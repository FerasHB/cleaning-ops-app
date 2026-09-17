-- =========================================================
-- MIGRATION: register_admin_with_company — Zugriffs-Härtung
-- =========================================================
-- BEFUND (Web/Backend-Audit, Backend-Hardening-Mini-PR)
--   register_admin_with_company ist eine Legacy-RPC ohne jede Vorprüfung des
--   Aufrufers: sie legt eine NEUE Firma an und schreibt per INSERT ... ON
--   CONFLICT (id) DO UPDATE unbedingt role='admin', company_id=<neue Firma>
--   und is_active=true auf das eigene Profil — unabhängig davon, ob der
--   Aufrufer bereits einer Firma angehört, deaktiviert ist oder noch gar
--   kein Profil hat. Ein bereits bestehender Mitarbeiter/Admin könnte sich
--   damit selbst in eine neue Firma umhängen; ein deaktiviertes Konto könnte
--   sich über diesen Weg selbst reaktivieren.
--
--   Bestätigt unbenutzt von beiden aktuellen Clients (Web entfernt in PR3,
--   Mobile verwendet ausschließlich die geschützte setup_company_for_admin,
--   siehe services/company/setupCompanyForAdmin.ts). Die RPC bleibt in
--   dieser Migration bewusst ERHALTEN (nicht entfernt) — nur gehärtet, für
--   den Fall, dass sie noch aus einem älteren, nicht mehr gepflegten Build
--   erreichbar ist. Eine spätere Migration kann sie nach Bestätigung, dass
--   kein Build sie mehr referenziert, vollständig entfernen.
--
-- HÄRTUNG (spiegelt exakt die Prüfungen von setup_company_for_admin,
-- 20260912000000_company_contact_foundation.sql)
--   1. auth.uid() IS NULL                    -> "Not authenticated"
--      (unverändert, war bereits vorhanden)
--   2. kein profiles-Datensatz für den Aufrufer -> "Profile not found"
--      (NEU — vorher legte der INSERT-Zweig bei fehlendem Profil einfach
--      eines an)
--   3. profiles.company_id IS NOT NULL       -> "User already belongs to a
--      company" (NEU — verhindert das Umhängen eines bestehenden
--      Mitarbeiters/Admins in eine neue Firma)
--   4. profiles.is_active IS NOT true        -> "User account is inactive"
--      (NEU — verhindert Selbst-Reaktivierung über diesen Pfad)
--
--   Erst wenn alle vier Prüfungen bestehen, wird die Firma angelegt und das
--   VORHANDENE Profil per UPDATE (nicht mehr INSERT ... ON CONFLICT) auf
--   role='admin', company_id=<neue Firma>, is_active=true gesetzt — Prüfung
--   2 stellt sicher, dass die Zeile zu diesem Zeitpunkt existiert.
--
-- UNVERÄNDERT
--   - Signatur: (p_full_name text, p_company_name text, p_company_slug text)
--     RETURNS json — kein Client ruft diese RPC aktuell auf, eine
--     Signaturänderung ist dennoch nicht nötig und wird vermieden.
--   - Owner (postgres), SECURITY DEFINER, SET search_path TO 'public',
--     Sprache plpgsql — 1:1 wie die aktuell auf Staging deployte Fassung
--     (verifiziert vor dieser Migration). CREATE OR REPLACE mit identischer
--     Signatur ändert weder Owner noch bestehende GRANTs (weiterhin
--     EXECUTE für authenticated + service_role, kein EXECUTE für anon).
--   - Rückgabewert bei Erfolg: {"company_id": "..."} wie zuvor.
--   - Alle bestehenden Validierungsfehler (leerer Name/Firmenname/Slug)
--     bleiben unverändert erhalten.
--
-- NICHT TEIL DIESER MIGRATION
--   - Keine Änderung an setup_company_for_admin, RLS, anderen RPCs oder
--     Tabellen.
--   - Keine Entfernung der RPC selbst.
--
-- ANWENDUNG
--   Wie alle Schemaänderungen hier MANUELL im Supabase SQL Editor ausführen
--   (siehe CLAUDE.md). Diese Migration wurde NICHT auf Production
--   ausgeführt.
-- =========================================================

CREATE OR REPLACE FUNCTION public.register_admin_with_company(p_full_name text, p_company_name text, p_company_slug text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id              uuid;
  v_company_id           uuid;
  v_existing_company_id  uuid;
  v_is_active            boolean;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  IF trim(p_company_name) = '' THEN
    RAISE EXCEPTION 'Company name is required';
  END IF;

  IF trim(p_company_slug) = '' THEN
    RAISE EXCEPTION 'Company slug is required';
  END IF;

  -- ── Zugriffs-Härtung (neu) ──────────────────────────────────────────
  -- Gleiche Prüfreihenfolge wie setup_company_for_admin: Profil muss
  -- existieren, darf noch keiner Firma angehören und muss aktiv sein.
  SELECT company_id, is_active
    INTO v_existing_company_id, v_is_active
  FROM public.profiles
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_existing_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'User already belongs to a company';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'User account is inactive';
  END IF;
  -- ── Ende Zugriffs-Härtung ───────────────────────────────────────────

  INSERT INTO public.companies (name, slug)
  VALUES (trim(p_company_name), trim(p_company_slug))
  RETURNING id INTO v_company_id;

  -- UPDATE statt vormals INSERT ... ON CONFLICT DO UPDATE: die
  -- Zugriffs-Härtung oben garantiert bereits, dass die Zeile existiert.
  UPDATE public.profiles
     SET full_name  = trim(p_full_name),
         role       = 'admin',
         company_id = v_company_id,
         is_active  = true
   WHERE id = v_user_id;

  RETURN json_build_object(
    'company_id', v_company_id
  );
END;
$function$
