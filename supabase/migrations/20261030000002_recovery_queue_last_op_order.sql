-- =========================================================
-- MIGRATION: Recovery-Queue — eindeutige letzte Mitarbeiteraktion
-- Datum: 2026-10-30
-- =========================================================
-- PROBLEM:
--   get_work_recovery_queue (20260922000000) bestimmt den Grund
--   late_pause/late_complete ueber die juengste Quittung, sortiert nach
--   work_operation_receipts.created_at. created_at ist now() = Beginn der
--   Transaktion. Zwei Aktionen derselben Zuweisung werden zwar ueber die
--   Job-Sperre serialisiert, aber eine FRUEHER begonnene Transaktion, die
--   auf die Sperre wartet, committet SPAETER mit kleinerem created_at. Die
--   Queue meldete dann den falschen Grund (z. B. late_pause statt
--   late_complete). Im Regressionstest (eine Transaktion) fuehrte derselbe
--   Gleichstand zu einem bekannten, sporadischen Fehlschlag.
--
-- FIX: primaer nach result_payload.recorded_at sortieren — clock_timestamp()
--   am Ende der Ausfuehrung, unter der Job-Sperre, also in echter
--   Ausfuehrungsreihenfolge. created_at bleibt Rueckfall.
--
-- UNVERAENDERT: Signatur, Spalten, Berechtigung, Grants, Kommentar.
-- ROLLBACK: Funktion aus 20260922000000 erneut einspielen.
-- =========================================================

begin;

CREATE OR REPLACE FUNCTION public.get_work_recovery_queue()
 RETURNS TABLE(assignment_id uuid, job_id uuid, employee_id uuid, employee_name text, customer_name text, service_name text, job_status job_status, employee_started_at timestamp with time zone, first_session_start timestamp with time zone, last_session_end timestamp with time zone, open_session_id uuid, open_session_started_at timestamp with time zone, recorded_seconds numeric, effective_seconds numeric, review_required boolean, reason_code text, stuck_since timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.current_user_role() is distinct from 'admin'
     or public.current_user_company_id() is null then
    raise exception 'Only admins can read the recovery queue' using errcode = '42501';
  end if;

  return query
  select ja.id,
         j.id,
         ja.employee_id,
         coalesce(nullif(btrim(p.full_name),''), ja.employee_name_snapshot, 'Unbekannt'),
         j.customer_name,
         j.service_name,
         j.status,
         ja.employee_started_at,
         agg.first_start,
         agg.last_end,
         agg.open_id,
         agg.open_started,
         agg.recorded_seconds,
         agg.effective_seconds,
         ja.work_review_required,
         case
           when agg.open_id is not null then 'open_session_expired'
           when ja.work_review_required and last_op.operation_type = 'pause'    then 'late_pause'
           when ja.work_review_required and last_op.operation_type = 'complete' then 'late_complete'
           when ja.work_review_required then 'review_required'
           else 'expired_unresolved'
         end,
         ja.employee_started_at + interval '12 hours'
  from public.job_assignments ja
  join public.jobs j on j.id = ja.job_id
  left join public.profiles p on p.id = ja.employee_id
  left join lateral (
    select min(e.effective_started_at)                              as first_start,
           max(e.effective_ended_at)                                as last_end,
           (array_agg(e.session_id) filter (where e.raw_ended_at is null))[1]    as open_id,
           (array_agg(e.raw_started_at) filter (where e.raw_ended_at is null))[1] as open_started,
           coalesce(sum(extract(epoch from e.raw_ended_at - e.raw_started_at))
             filter (where not exists (
               select 1 from public.session_time_corrections stc
               where stc.work_session_id = e.session_id
                 and stc.revision_no = 1 and stc.origin = 'admin_closed')),0)                 as recorded_seconds,
           coalesce(sum(extract(epoch from e.effective_ended_at - e.effective_started_at)),0) as effective_seconds
    from public._effective_sessions(array[ja.id]) e
  ) agg on true
  left join lateral (
    select r.operation_type from public.work_operation_receipts r
    where r.job_assignment_id = ja.id and r.operation_type <> 'admin_review'
    -- recorded_at = clock_timestamp() unter der Job-Sperre: eindeutige
    -- Reihenfolge auch wenn created_at (= Transaktionsstart) gleich ist oder
    -- eine frueher begonnene Transaktion spaeter committet (20261030000002).
    order by (r.result_payload->>'recorded_at')::timestamptz desc nulls last,
             r.created_at desc
    limit 1
  ) last_op on true
  where j.company_id = public.current_user_company_id()
    and ja.time_tracking_mode = 'sessions'
    and ja.employee_completed_at is null
    and ( ja.work_review_required
          or ja.employee_started_at < now() - interval '12 hours' )
  order by ja.employee_started_at;
end $function$;

commit;
