-- Last-Admin-Schutz für die Kontolöschung: schließt die Race Condition der
-- bisherigen Prüfung in supabase/functions/delete-account/index.ts.
--
-- Bisher: die Edge Function zählte aktive Admins der Firma (SELECT), und rief
-- danach separat auth.admin.deleteUser() auf — zwei unabhängige Schritte ohne
-- gemeinsame Transaktion. Zwei Admins derselben Firma, die sich fast zeitgleich
-- selbst löschen, sehen beide "es gibt noch einen weiteren aktiven Admin" und
-- werden beide gelöscht → die Firma bleibt führungslos zurück.
--
-- Warum ein einfaches "SELECT ... FOR UPDATE" innerhalb der RPC NICHT reicht:
-- Der Row-Lock existiert nur bis zum Ende der RPC-Transaktion (Commit beim
-- Rückkehren der Funktion). auth.admin.deleteUser() läuft danach als
-- separater Aufruf gegen GoTrue (Auth-Service), nicht innerhalb derselben
-- Postgres-Transaktion — der Lock ist zu diesem Zeitpunkt längst freigegeben
-- und schützt nichts mehr.
--
-- Lösung: prepare_self_account_deletion() reserviert den Admin-Platz VOR dem
-- eigentlichen Löschen, indem sie das aufrufende Admin-Profil innerhalb der
-- Prüf-Transaktion auf is_active=false setzt (COMMIT beim Funktionsende). Ein
-- zeitgleicher zweiter Aufruf sieht diesen committeten Zustand (oder wartet
-- durch den Row-Lock darauf) und zählt den ersten Admin korrekt nicht mehr
-- mit. Schlägt der anschließende auth.admin.deleteUser() in der Edge Function
-- fehl, macht rollback_self_account_deletion() die Reservierung rückgängig
-- (is_active wieder true).
--
-- Keine neue Spalte nötig: is_active ist bereits die zentrale
-- Deaktivierungs-Markierung (current_user_role()/current_user_company_id()
-- liefern für is_active=false bewusst NULL, siehe Kommentar dort) — exakt
-- das Verhalten, das eine "reservierte" Admin-Zeile für die Dauer der
-- Löschung braucht. Nebeneffekt (gewollt, kein neuer Mechanismus): der
-- clear_push_token_on_deactivate-Trigger und der Live-Deaktivierungs-Kanal
-- in context/AuthContext.tsx reagieren auf is_active=false wie bei jeder
-- anderen Deaktivierung auch — der Aufrufer wird ggf. bereits während der
-- kurzen Reservierung clientseitig abgemeldet. Das ist unkritisch: entweder
-- die Löschung schließt Sekundenbruchteile später ohnehin ab, oder — im
-- seltenen Rollback-Fall (z. B. GoTrue-Ausfall) — der Nutzer muss sich
-- lediglich erneut anmelden; das Konto selbst bleibt unverändert erhalten.

-- =========================================================
-- RPC: PREPARE SELF ACCOUNT DELETION (Last-Admin-Reservierung)
-- =========================================================
create or replace function public.prepare_self_account_deletion()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_company_id uuid;
  v_other_active_admins int;
begin
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;

  -- Ungesperrtes Lesen: entscheidet nur, ob eine Reservierung überhaupt
  -- nötig ist. Bewusst OHNE FOR UPDATE — siehe Kommentar bei der
  -- Multi-Row-Sperre unten, warum ein separater Row-Lock auf die eigene
  -- Zeile hier zu einem Deadlock zwischen zwei gleichzeitig aufrufenden
  -- Admins führen würde.
  select role, company_id
    into v_role, v_company_id
  from public.profiles
  where id = v_caller;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if v_role <> 'admin' or v_company_id is null then
    -- Mitarbeiter (oder Admin ohne Firma): keine Reservierung nötig, die
    -- Edge Function kann direkt mit auth.admin.deleteUser() fortfahren.
    return;
  end if;

  -- Sperrt ALLE Admin-Zeilen der Firma (inkl. der eigenen) in EINEM
  -- Statement, deterministisch nach id sortiert. Das ist absichtlich die
  -- EINZIGE Sperre in dieser Funktion: würde man stattdessen zuerst nur die
  -- eigene Zeile sperren und danach separat die der anderen Admins, würden
  -- zwei sich gleichzeitig löschende Admins A und B jeweils die eigene
  -- Zeile halten und auf die des jeweils anderen warten → klassischer
  -- Postgres-Deadlock. Eine einzige Sperr-Query mit fester Reihenfolge
  -- vermeidet das: beide Aufrufer fordern dieselben Zeilen in derselben
  -- Reihenfolge an, es gibt keine zirkuläre Wartebeziehung — der zweite
  -- Aufrufer wartet einfach, bis der erste committet.
  perform 1
  from public.profiles
  where company_id = v_company_id
    and role = 'admin'
  order by id
  for update;

  select count(*)
    into v_other_active_admins
  from public.profiles
  where company_id = v_company_id
    and role = 'admin'
    and is_active = true
    and id <> v_caller;

  if v_other_active_admins = 0 then
    -- Kurzer, maschinenlesbarer Fehlertext: diese RPC wird ausschließlich
    -- von supabase/functions/delete-account/index.ts aufgerufen, die daraus
    -- die freundliche Nutzermeldung baut — kein Mensch sieht diesen Text
    -- direkt.
    raise exception 'last_admin';
  end if;

  -- Reservierung: is_active=false wird HIER committet (Funktionsende =
  -- Ende der RPC-Transaktion), nicht nur gesperrt — das ist der Teil, der
  -- über das Ende der Transaktion hinaus wirkt und die Race Condition
  -- schließt, denn der Row-Lock selbst ist beim nachfolgenden
  -- auth.admin.deleteUser()-Aufruf in der Edge Function bereits wieder frei.
  update public.profiles
     set is_active = false
   where id = v_caller;
end;
$$;

revoke all on function public.prepare_self_account_deletion() from public, anon;
grant execute on function public.prepare_self_account_deletion() to authenticated;

-- =========================================================
-- RPC: ROLLBACK SELF ACCOUNT DELETION
-- =========================================================
-- Macht die Reservierung aus prepare_self_account_deletion() rückgängig,
-- falls auth.admin.deleteUser() in der Edge Function fehlschlägt (z. B.
-- GoTrue-Fehler). Sicher als no-op: setzt is_active nur zurück, wenn der
-- Aufrufer aktuell genau im reservierten Zustand ist (role='admin',
-- is_active=false) — ein Mitarbeiter (der nie reserviert wurde) oder ein
-- bereits wieder aktiver Admin bleibt unberührt. Wirkt ausschließlich auf
-- die eigene Zeile (auth.uid()), es gibt keinen user_id-Parameter.
create or replace function public.rollback_self_account_deletion()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;

  update public.profiles
     set is_active = true
   where id = v_caller
     and role = 'admin'
     and is_active = false;
end;
$$;

revoke all on function public.rollback_self_account_deletion() from public, anon;
grant execute on function public.rollback_self_account_deletion() to authenticated;
