-- Ersetzt is_active als Reservierungs-Marker für die Kontolöschung durch
-- explizite Reservierungsspalten + Token.
--
-- Zwei Probleme mit dem is_active-basierten Ansatz aus
-- 20260723000000_last_admin_deletion_reservation.sql:
--
-- 1. Crash-Fenster ohne Recovery: prepare_self_account_deletion() committet
--    is_active=false, BEVOR die Edge Function auth.admin.deleteUser()
--    aufruft. Bricht die Function danach ab (Timeout, Crash, Netzwerkfehler)
--    BEVOR sie deleteUser() ODER den Rollback ausführen konnte, bleibt das
--    Konto dauerhaft is_active=false, ohne gelöscht zu sein — kein Cron, kein
--    Recovery-Mechanismus holt das nachträglich ein.
--
-- 2. is_active hat zwei unterscheidbare Bedeutungen, die dieselbe Spalte
--    teilten: "administrativ deaktiviert" (z. B. durch einen anderen Admin)
--    und "vorübergehend für die Löschung reserviert". rollback_self_account_
--    deletion() konnte das nicht unterscheiden — sie prüfte nur
--    role='admin' AND is_active=false und hätte damit auch ein ADMINISTRATIV
--    deaktiviertes Konto reaktivieren können, wenn der betroffene Admin sie
--    selbst aufruft (auth.uid()-bound, aber ohne echten Nachweis, dass GENAU
--    DIESE Deaktivierung von einer eigenen Löschreservierung stammte).
--
-- Lösung: is_active bleibt AUSSCHLIESSLICH der administrativen Deaktivierung
-- vorbehalten und wird von der Löschung nie mehr angefasst. Die Reservierung
-- läuft stattdessen über zwei neue, ausschließlich für diesen Zweck genutzte
-- Spalten + einen zufälligen Token, den nur die Edge Function kennt (sie wird
-- von prepare_self_account_deletion() zurückgegeben und muss unverändert an
-- rollback_self_account_deletion() übergeben werden — ein falscher/fremder
-- Token bewirkt nichts).

alter table public.profiles
  add column if not exists account_deletion_token uuid null,
  add column if not exists account_deletion_reserved_at timestamptz null;

comment on column public.profiles.account_deletion_token is
  'Zufälliger Token einer laufenden Selbstlöschungs-Reservierung (siehe prepare_self_account_deletion). NULL = keine Reservierung. Unabhängig von is_active.';
comment on column public.profiles.account_deletion_reserved_at is
  'Zeitpunkt der letzten Löschreservierung. Wird von recover_stale_account_deletion_reservations() genutzt, um veraltete Reservierungen (Crash/Timeout der Edge Function) automatisch abzuräumen.';

-- Alte Funktionen entfernen: prepare_self_account_deletion() ändert den
-- Rückgabetyp (void -> uuid), das kann CREATE OR REPLACE nicht (siehe
-- Kommentar bei current_user_role() in lib/schema.sql). rollback_self_
-- account_deletion() bekommt einen neuen Parameter (p_token uuid) — ohne
-- expliziten DROP würde CREATE OR REPLACE eine zusätzliche Überladung
-- anlegen und die alte, unsichere parameterlose Version bliebe weiter
-- aufrufbar.
drop function if exists public.prepare_self_account_deletion();
drop function if exists public.rollback_self_account_deletion();

-- =========================================================
-- RPC: PREPARE SELF ACCOUNT DELETION (v2, Token-basiert)
-- =========================================================
-- Gibt den neu erzeugten Reservierungs-Token zurück. Schlägt fehl, wenn:
--   - kein Profil existiert ('profile_not_found')
--   - das Profil bereits is_active=false ist ('inactive_account') — ein
--     administrativ deaktiviertes Konto darf gar nicht erst eine Löschung
--     anstoßen, unabhängig von jeder Reservierung
--   - der Aufrufer der letzte verfügbare Admin seiner Firma ist ('last_admin')
create or replace function public.prepare_self_account_deletion()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_is_active boolean;
  v_other_available_admins int;
  v_token uuid;
begin
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;

  -- Ungesperrtes Lesen: entscheidet nur den weiteren Ablauf. Bewusst OHNE
  -- FOR UPDATE — siehe Kommentar bei der Multi-Row-Sperre unten, warum ein
  -- separater Row-Lock auf die eigene Zeile hier zu einem Deadlock zwischen
  -- zwei gleichzeitig aufrufenden Admins führen würde.
  select role, company_id, is_active
    into v_role, v_company_id, v_is_active
  from public.profiles
  where id = v_caller;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if v_is_active is distinct from true then
    -- Administrativ deaktivierte Konten dürfen keine Löschung anstoßen.
    -- is_active wird von dieser RPC nie gesetzt — ist es hier schon false,
    -- kann das nur ein anderer Vorgang (Admin-Deaktivierung) gewesen sein.
    raise exception 'inactive_account';
  end if;

  if v_role <> 'admin' or v_company_id is null then
    -- Mitarbeiter (oder Admin ohne Firma): keine Last-Admin-Prüfung nötig,
    -- aber trotzdem einen Token vergeben, damit die Edge Function bei einem
    -- Rollback-Bedarf einheitlich verfahren kann.
    v_token := gen_random_uuid();
    update public.profiles
       set account_deletion_token = v_token,
           account_deletion_reserved_at = now()
     where id = v_caller;
    return v_token;
  end if;

  -- Sperrt ALLE Admin-Zeilen der Firma (inkl. der eigenen) in EINEM
  -- Statement, deterministisch nach id sortiert — die einzige Sperre in
  -- dieser Funktion. Zwei separate Sperren (erst eigene Zeile, dann die der
  -- anderen Admins) würden bei zwei gleichzeitig löschenden Admins zu einer
  -- zirkulären Wartebeziehung und damit zu einem Postgres-Deadlock führen.
  -- Eine einzige Sperr-Query mit fester Reihenfolge vermeidet das.
  perform 1
  from public.profiles
  where company_id = v_company_id
    and role = 'admin'
  order by id
  for update;

  -- "Verfügbar" heißt: aktiv UND ohne eigene laufende Löschreservierung.
  -- Ein Admin mit account_deletion_token IS NOT NULL zählt nicht mehr mit,
  -- auch wenn is_active noch true ist (is_active wird ja nicht mehr
  -- geändert) — sonst könnten sich zwei Admins gegenseitig als "verfügbar"
  -- sehen, obwohl beide bereits mitten in der eigenen Löschung stecken.
  select count(*)
    into v_other_available_admins
  from public.profiles
  where company_id = v_company_id
    and role = 'admin'
    and is_active = true
    and account_deletion_token is null
    and id <> v_caller;

  if v_other_available_admins = 0 then
    -- Kurzer, maschinenlesbarer Fehlertext: diese RPC wird ausschließlich
    -- von supabase/functions/delete-account/index.ts aufgerufen.
    raise exception 'last_admin';
  end if;

  v_token := gen_random_uuid();
  update public.profiles
     set account_deletion_token = v_token,
         account_deletion_reserved_at = now()
   where id = v_caller;

  return v_token;
end;
$$;

revoke all on function public.prepare_self_account_deletion() from public, anon;
grant execute on function public.prepare_self_account_deletion() to authenticated;

-- =========================================================
-- RPC: ROLLBACK SELF ACCOUNT DELETION (v2, Token-basiert)
-- =========================================================
-- Macht NUR die eigene Reservierung rückgängig, und nur wenn der
-- übergebene Token exakt zum aktuell gespeicherten passt. is_active wird
-- nie angefasst — kann also auch nie fälschlich ein administrativ
-- deaktiviertes Konto reaktivieren, unabhängig davon, wer die Funktion
-- aufruft oder welchen Token er übergibt. Bei fehlendem Treffer (falscher/
-- fremder Token ODER die Reservierung wurde inzwischen bereits durch
-- recover_stale_account_deletion_reservations() entfernt) wirft die
-- Funktion 'reservation_not_found', statt still keine Zeile zu ändern —
-- die Edge Function soll das explizit als rollback_failed erkennen können.
create or replace function public.rollback_self_account_deletion(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_rows int;
begin
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;

  if p_token is null then
    raise exception 'reservation_not_found';
  end if;

  update public.profiles
     set account_deletion_token = null,
         account_deletion_reserved_at = null
   where id = v_caller
     and account_deletion_token = p_token;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'reservation_not_found';
  end if;
end;
$$;

revoke all on function public.rollback_self_account_deletion(uuid) from public, anon;
grant execute on function public.rollback_self_account_deletion(uuid) to authenticated;

-- =========================================================
-- RPC: RECOVER STALE ACCOUNT DELETION RESERVATIONS
-- =========================================================
-- Räumt NUR die Reservierungs-Marker ab (Token + Timestamp) von
-- Reservierungen, die älter als 15 Minuten sind — weit über jeder
-- realistischen Edge-Function-Laufzeit, aber kurz genug, um nach einem
-- Crash/Timeout zeitnah einen neuen Löschversuch zuzulassen. Fasst is_active
-- NIE an (die Reservierung setzt es ja auch nie), kann also nie
-- fälschlich einen administrativ deaktivierten Nutzer reaktivieren.
--
-- Kein SECURITY DEFINER: nur service_role darf diese Funktion aufrufen
-- (siehe Grants unten), und service_role umgeht RLS bereits durch die
-- eigene Rolle — SECURITY DEFINER wäre hier ein ungenutztes Privileg.
--
-- Auslösung (aktuell): die Edge Function ruft diese Funktion best-effort
-- vor JEDEM neuen Löschversuch auf (supabase/functions/delete-account/
-- index.ts) — das reicht für den MVP-Betrieb aus, ohne dass eine
-- zusätzliche Infrastruktur (Cron) nötig ist. Ein zukünftiger pg_cron-Job
-- (z. B. alle 15 Minuten) wäre eine sinnvolle Ergänzung, falls einmal
-- Reservierungen anfallen, ohne dass zeitnah ein neuer Löschversuch
-- unternommen wird — NICHT Teil dieser Migration, bewusst nicht aktiviert.
create or replace function public.recover_stale_account_deletion_reservations()
returns int
language plpgsql
set search_path = public
as $$
declare
  v_rows int;
begin
  update public.profiles
     set account_deletion_token = null,
         account_deletion_reserved_at = null
   where account_deletion_reserved_at is not null
     and account_deletion_reserved_at < now() - interval '15 minutes';

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.recover_stale_account_deletion_reservations() from public, anon, authenticated;
grant execute on function public.recover_stale_account_deletion_reservations() to service_role;
