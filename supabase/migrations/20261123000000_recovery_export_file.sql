-- =========================================================
-- Work Recovery S1.7 — verlustfreie Export-Datei für die Admin-App
-- =========================================================
-- get_company_recovery_export() (S1.5) liefert jsonb. Der Client
-- (supabase-js) parst die Antwort mit JSON.parse — dabei gehen Zahlen
-- verloren, die JavaScript nicht exakt darstellt: 1.50 wird 1.5,
-- 12345678901234567890 wird 12345678901234567000. Solche Werte können in
-- Mitarbeiter-Nachweisen (work_recovery_submissions.claimed_ops,
-- work_recovery_events.detail) stehen. Eine aus dem geparsten Objekt neu
-- serialisierte Datei wäre also NICHT der vollständige, unveränderte
-- Nachweis.
--
-- Diese Funktion liefert dieselbe Antwort zusätzlich als TEXT
-- (file_text = Antwort::text, wörtlich vom Server) plus SHA-256 dieses Texts
-- (UTF-8). JSON-Strings überstehen den Transport verlustfrei. Die App
-- schreibt file_text unverändert in die Datei, liest sie zurück und
-- vergleicht den Hash — damit ist belegt, dass die gespeicherte Datei
-- Byte für Byte der Server-Antwort entspricht.
--
-- Keine neue Logik: Berechtigung, Export-Nachweis (company_deletion_exports,
-- inkl. Wiederverwendung bei gleichem Fingerprint) und Inhalt kommen
-- unverändert aus get_company_recovery_export(). Bestätigung bleibt
-- acknowledge_company_recovery_export(export_id). Keine Änderung an Purge,
-- Aufbewahrung, Arbeitszeit, Auftragsabschluss oder Anmeldung.

create or replace function public.get_company_recovery_export_file()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_export jsonb;
  v_text   text;
begin
  -- Prüft Anmeldung, aktive Admin-Rolle und Firma; legt den Export-Nachweis an.
  v_export := public.get_company_recovery_export();
  v_text   := v_export::text;

  return jsonb_build_object(
    'format',          'work_recovery_export_file_v1',
    'export_id',       v_export -> 'export_id',
    'fingerprint',     v_export -> 'fingerprint',
    'generated_at',    v_export -> 'generated_at',
    'record_counts',   v_export -> 'record_counts',
    'open_case_count', v_export -> 'open_case_count',
    'file_text',       v_text,
    'file_sha256',     encode(sha256(convert_to(v_text, 'UTF8')), 'hex')
  );
end;
$$;

revoke all on function public.get_company_recovery_export_file()
  from public, anon, authenticated, service_role;
grant execute on function public.get_company_recovery_export_file() to authenticated;

comment on function public.get_company_recovery_export_file() is
'Work Recovery S1.7: Antwort von get_company_recovery_export() zusätzlich als exakter Text (file_text) + SHA-256 (file_sha256, UTF-8), damit die App die Datei verlustfrei schreiben und prüfen kann. Gleiche Berechtigung (aktiver Admin, eigene Firma).';
