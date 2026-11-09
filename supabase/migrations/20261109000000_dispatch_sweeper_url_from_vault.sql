-- =====================================================================
-- Dispatch-Sweeper: Projekt-URL aus Vault statt fest verdrahtet
-- =====================================================================
--
-- Problem: 20260717000003 hat den Minuten-Cron 'notification-dispatch-sweeper'
-- mit der fest eingetragenen PRODUKTIONS-URL angelegt. Jede Datenbank, die aus
-- den Migrationen gebaut wird (lokaler Stack, CI, neue Umgebungen), schickt
-- deshalb jede Minute einen POST an die Produktions-Edge-Function. Staging
-- wurde per Hand auf die eigene URL umgestellt (Drift gegenüber dem Repo).
--
-- Lösung: kick_dispatch_sweeper() liest project_url und
-- dispatch_sweeper_secret zur LAUFZEIT aus Vault, genau wie der Sofort-Trigger
-- (20260916140000) und der Receipt-Poller (20261018000001). Fehlt eines der
-- Secrets, wird KEIN Request abgesetzt. Lokale und CI-Datenbanken haben keine
-- Vault-Secrets und erreichen damit nie Staging oder Produktion.
--
-- Produktion / Staging: beide tragen project_url (= eigene Projekt-URL) und
-- dispatch_sweeper_secret in Vault (read-only geprüft 2026-11-09). Ziel-URL,
-- Header, Body und Timeout bleiben dort identisch; nur die Quelle der URL
-- ändert sich.
--
-- Der bestehende Job wird per cron.alter_job umgestellt (gleiche jobid), damit
-- der Health-Check H6 (h6_sweeper_cron, letzte erfolgreiche Ausführung je
-- jobid) seine Historie behält und nach dem Deploy nicht kurz auf critical
-- springt.
--
-- Schutzgeländer (Migration bricht ab, statt still etwas zu verändern):
--   * Vault-URL vorhanden, aber anders als die URL im bestehenden Job
--     ⇒ Abbruch (kein unbemerkter Zielwechsel).
--   * Vault-URL oder Secret fehlt, aber der Dispatcher hat in der letzten
--     Stunde HTTP 200 geliefert (= lebende Umgebung) ⇒ Abbruch (Versand würde
--     sonst stillschweigend stoppen). Erst Vault-Secrets setzen, dann anwenden.
--
-- ROLLBACK (stellt den Zustand vor dieser Migration her; <url> = eigene
-- Projekt-URL, nur auf Staging/Produktion sinnvoll):
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'notification-dispatch-sweeper'),
--     command := $cron$
--   select net.http_post(
--     url := '<url>/functions/v1/dispatch-notifications',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-sweeper-secret',
--       (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_sweeper_secret')
--     ),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 8000
--   );
--   $cron$);
--   drop function public.kick_dispatch_sweeper();
-- =====================================================================

create or replace function public.kick_dispatch_sweeper()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_url text;
  v_secret      text;
  v_request_id  bigint;
begin
  select nullif(btrim(decrypted_secret), '') into v_project_url
  from vault.decrypted_secrets where name = 'project_url';
  select nullif(btrim(decrypted_secret), '') into v_secret
  from vault.decrypted_secrets where name = 'dispatch_sweeper_secret';
  if v_project_url is null or v_secret is null then
    return null;
  end if;
  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweeper-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  ) into v_request_id;
  return v_request_id;
end;
$$;

comment on function public.kick_dispatch_sweeper() is
'Minuten-Sweeper: stößt dispatch-notifications unter <Vault project_url> an '
'(x-sweeper-secret aus Vault). Ohne Secrets kein Request (lokal/CI). '
'20261109000000. Nur Service Role / Cron.';

revoke all on function public.kick_dispatch_sweeper() from public, anon, authenticated;
grant execute on function public.kick_dispatch_sweeper() to service_role;

do $$
declare
  v_jobid       bigint;
  v_command     text;
  v_job_url     text;
  v_vault_url   text;
  v_has_secret  boolean;
  v_live_200    boolean;
begin
  select nullif(rtrim(btrim(decrypted_secret), '/'), '') into v_vault_url
  from vault.decrypted_secrets where name = 'project_url';
  select exists (select 1 from vault.decrypted_secrets
                 where name = 'dispatch_sweeper_secret'
                   and nullif(btrim(decrypted_secret), '') is not null)
    into v_has_secret;

  select jobid, command into v_jobid, v_command
  from cron.job where jobname = 'notification-dispatch-sweeper';

  -- Fest eingetragene Projekt-URL im bestehenden Job (falls vorhanden).
  v_job_url := substring(v_command from '(https?://[^/'']+)/functions/v1/dispatch-notifications');

  if v_vault_url is not null and v_job_url is not null and v_vault_url <> v_job_url then
    raise exception 'dispatch sweeper: Vault project_url (%) differs from the URL in the current cron job (%). Refusing to change the target silently.',
      v_vault_url, v_job_url;
  end if;

  if v_vault_url is null or not v_has_secret then
    select exists (select 1 from net._http_response
                   where status_code = 200 and created > now() - interval '1 hour')
      into v_live_200;
    if v_live_200 then
      raise exception 'dispatch sweeper: Vault project_url / dispatch_sweeper_secret missing, but this database delivered notifications in the last hour. Set the Vault secrets first, then apply this migration.';
    end if;
  end if;

  if v_jobid is null then
    perform cron.schedule(
      'notification-dispatch-sweeper',
      '* * * * *',
      $cron$select public.kick_dispatch_sweeper();$cron$
    );
  else
    perform cron.alter_job(
      v_jobid,
      schedule := '* * * * *',
      command  := $cron$select public.kick_dispatch_sweeper();$cron$
    );
  end if;
end $$;
