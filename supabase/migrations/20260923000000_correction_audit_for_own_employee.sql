-- =========================================================
-- Prüfkette auch für die eigene Zuweisung lesbar
-- =========================================================
-- PRODUKT-ENTSCHEIDUNG (Korrektur zu 20260922000000): der Stundenzettel-PDF
-- muss für Admin und Mitarbeiter INHALTSGLEICH sein. Ein Mitarbeiter bekommt
-- damit denselben Prüfvermerk — Aufgezeichnet, Geprüfte Arbeitszeit,
-- Korrektur und Grund — wie der Admin. Rollenunterschiede bleiben in der
-- mobilen Oberfläche erlaubt, im EXPORTIERTEN Dokument nicht mehr.
--
-- WARUM ÜBERHAUPT EINE MIGRATION: der Grund liegt ausschließlich in
-- session_time_corrections. Die Tabelle hat bewusst nur eine Admin-Policy, und
-- get_session_correction_audit() lehnte Mitarbeitende mit 42501 ab. Kein
-- Client-Umbau kann das schließen: der Text verlässt den Server für ein
-- Mitarbeiter-JWT schlicht nicht. Gemessen auf Staging vor dieser Migration:
--   get_session_correction_audit  -> 42501 "Only admins can read correction audit data"
--   select on session_time_corrections -> 0 Zeilen (RLS)
--
-- KEIN ERSATZ DURCH ROHDATEN: "Aufgezeichnet" aus work_sessions abzuleiten
-- wäre falsch. Bei origin='admin_closed' trägt work_sessions.ended_at den vom
-- ADMIN eingetragenen Wert; der Mitarbeiter hat dort nie abgeschlossen. Der
-- PDF-Export behauptete sonst eine Erfassung, die nie stattgefunden hat —
-- genau der Fehler, den die Spalten raw_ended_at/delta_seconds (NULL bei
-- admin_closed) vermeiden.
--
-- UMFANG: ausschließlich die Autorisierungs-Klausel dieser EINEN Funktion.
-- Signatur, Rückgabespalten, Reihenfolge und Firmen-Scoping bleiben
-- unverändert. Die RLS auf session_time_corrections bleibt Admin-only — diese
-- SECURITY-DEFINER-Funktion ist weiterhin der einzige Lesepfad, und ein
-- Mitarbeiter sieht durch sie NUR die eigene Zuweisung. Keine Änderung an der
-- Abrechnungslogik, an _effective_sessions oder an einer anderen RPC.

begin;

create or replace function public.get_session_correction_audit(assignment_ids_input uuid[])
returns table (
  correction_id              uuid,
  work_session_id            uuid,
  job_assignment_id          uuid,
  revision_no                int,
  origin                     text,
  raw_started_at             timestamptz,
  raw_ended_at               timestamptz,
  raw_duration_seconds       numeric,
  effective_ended_at         timestamptz,
  effective_duration_seconds numeric,
  delta_seconds              numeric,
  reason                     text,
  performed_by               uuid,
  performed_by_name          text,
  created_at                 timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_role text := public.current_user_role();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  -- IS DISTINCT FROM, nie <>: current_user_role() ist NULL für ein
  -- deaktiviertes oder fehlendes Profil, und "NULL <> 'admin'" ist NULL — der
  -- Guard würde genau für dieses Konto still übersprungen.
  if (v_role is distinct from 'admin' and v_role is distinct from 'employee')
     or public.current_user_company_id() is null then
    raise exception 'Not authorised to read correction audit data' using errcode = '42501';
  end if;

  return query
  select stc.correction_id, stc.work_session_id, stc.job_assignment_id,
         stc.revision_no, stc.origin,
         stc.raw_started_at, stc.raw_ended_at, stc.raw_duration_seconds,
         stc.effective_ended_at, stc.effective_duration_seconds, stc.delta_seconds,
         stc.reason, stc.performed_by,
         coalesce(nullif(btrim(p.full_name),''),'Unbekannt'),
         stc.created_at
  from public.session_time_corrections stc
  join public.jobs j on j.id = stc.job_id
  join public.job_assignments ja on ja.id = stc.job_assignment_id
  left join public.profiles p on p.id = stc.performed_by
  where stc.job_assignment_id = any(coalesce(assignment_ids_input,'{}'::uuid[]))
    and j.company_id = public.current_user_company_id()
    -- Admin: ganze Firma. Mitarbeiter: ausschliesslich die EIGENE Zuweisung.
    and (v_role = 'admin' or ja.employee_id = auth.uid())
  order by stc.work_session_id, stc.revision_no;
end $$;

revoke all on function public.get_session_correction_audit(uuid[]) from public, anon;
grant execute on function public.get_session_correction_audit(uuid[]) to authenticated;

comment on function public.get_session_correction_audit(uuid[]) is
'Korrektur-Prüfkette für die Anzeige. Admin liest die eigene Firma, ein '
'Mitarbeiter ausschliesslich die eigene Zuweisung — damit der exportierte '
'Stundenzettel für beide Rollen inhaltsgleich ist. NIEMALS eine '
'Abrechnungsquelle: jede Arbeitsminute kommt aus get_effective_work_sessions.';

commit;
