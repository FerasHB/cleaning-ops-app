-- =========================================================
-- TEST: Dispatch-Sweeper liest die Projekt-URL aus Vault
-- (Migration 20261109000000)
-- =========================================================
-- Erwartet:
--   1. Kein pg_cron-Job enthält eine fest eingetragene http(s)-URL.
--   2. 'notification-dispatch-sweeper' existiert, ist aktiv, läuft jede
--      Minute und ruft public.kick_dispatch_sweeper() auf.
--   3. Ohne Vault-Secrets: kick_dispatch_sweeper() liefert NULL und legt
--      KEINEN pg_net-Request an (lokal / CI erreichen nie ein Projekt).
--   4. Nur project_url ODER nur Secret: ebenfalls kein Request.
--   5. Mit beiden Secrets: genau ein POST an
--      <project_url ohne Slash>/functions/v1/dispatch-notifications mit
--      x-sweeper-secret, Body {} und Timeout 8000 ms (wie zuvor).
--   6. anon / authenticated dürfen die Funktion nicht ausführen.
--
-- Läuft in einer Transaktion mit ROLLBACK: Vault-Testsecrets und die
-- Queue-Zeile verschwinden wieder; der pg_net-Worker sieht nur committete
-- Zeilen, es wird also nichts versendet.
-- Lokal: docker exec -i <db-container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 < this file
-- =========================================================

begin;

do $$
declare
  v_job       record;
  v_bad       text;
  v_before    bigint;
  v_result    bigint;
  v_req       record;
begin
  -- Ausgangslage dieses Tests: keine Vault-Secrets. Auf einer Umgebung mit
  -- echten Secrets (Staging/Produktion) bricht der Test ab, statt sie zu
  -- überschreiben.
  if exists (select 1 from vault.secrets where name in ('project_url', 'dispatch_sweeper_secret')) then
    raise exception 'TESTRESULT dispatch_sweeper_url_from_vault: Vault secrets already exist here; run this test only on a local/CI database.';
  end if;

  -- 1
  select string_agg(jobname, ', ') into v_bad
  from cron.job where command ~* 'https?://';
  if v_bad is not null then
    raise exception 'TESTRESULT 1 FAIL: cron jobs with a hard-coded URL: %', v_bad;
  end if;

  -- 2
  select * into v_job from cron.job where jobname = 'notification-dispatch-sweeper';
  if not found then
    raise exception 'TESTRESULT 2 FAIL: sweeper job missing';
  end if;
  if v_job.schedule <> '* * * * *'
     or btrim(v_job.command) <> 'select public.kick_dispatch_sweeper();' then
    raise exception 'TESTRESULT 2 FAIL: sweeper job schedule/command: % / %', v_job.schedule, v_job.command;
  end if;
  -- active wird in CI für andere Jobs pausiert, der Sweeper bleibt aktiv.
  if not v_job.active then
    raise exception 'TESTRESULT 2 FAIL: sweeper job inactive';
  end if;

  -- 3
  select count(*) into v_before from net.http_request_queue;
  v_result := public.kick_dispatch_sweeper();
  if v_result is not null or (select count(*) from net.http_request_queue) <> v_before then
    raise exception 'TESTRESULT 3 FAIL: request queued without Vault secrets (id %)', v_result;
  end if;

  -- 4a: nur project_url
  perform vault.create_secret('https://sweeper-test.example.invalid/', 'project_url');
  v_result := public.kick_dispatch_sweeper();
  if v_result is not null or (select count(*) from net.http_request_queue) <> v_before then
    raise exception 'TESTRESULT 4a FAIL: request queued without dispatch_sweeper_secret';
  end if;

  -- 4b: nur Secret
  delete from vault.secrets where name = 'project_url';
  perform vault.create_secret('test-sweeper-secret', 'dispatch_sweeper_secret');
  v_result := public.kick_dispatch_sweeper();
  if v_result is not null or (select count(*) from net.http_request_queue) <> v_before then
    raise exception 'TESTRESULT 4b FAIL: request queued without project_url';
  end if;

  -- 5
  perform vault.create_secret('https://sweeper-test.example.invalid/', 'project_url');
  v_result := public.kick_dispatch_sweeper();
  if v_result is null or (select count(*) from net.http_request_queue) <> v_before + 1 then
    raise exception 'TESTRESULT 5 FAIL: expected exactly one queued request, got id %', v_result;
  end if;
  select * into v_req from net.http_request_queue where id = v_result;
  if v_req.method <> 'POST'
     or v_req.url <> 'https://sweeper-test.example.invalid/functions/v1/dispatch-notifications'
     or v_req.headers ->> 'x-sweeper-secret' <> 'test-sweeper-secret'
     or v_req.headers ->> 'Content-Type' <> 'application/json'
     or convert_from(v_req.body, 'utf8')::jsonb <> '{}'::jsonb
     or v_req.timeout_milliseconds <> 8000 then
    raise exception 'TESTRESULT 5 FAIL: unexpected request % % % %',
      v_req.method, v_req.url, v_req.headers, v_req.timeout_milliseconds;
  end if;

  -- 6
  if has_function_privilege('anon', 'public.kick_dispatch_sweeper()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.kick_dispatch_sweeper()', 'EXECUTE') then
    raise exception 'TESTRESULT 6 FAIL: kick_dispatch_sweeper is executable by anon/authenticated';
  end if;

  raise notice 'PASS dispatch_sweeper_url_from_vault: 6/6';
end $$;

rollback;
