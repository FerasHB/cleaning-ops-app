-- =========================================================
-- HARDENING: EXECUTE-Grants auf clientseitig aufrufbaren RPCs
-- =========================================================
-- Ausgangslage (aus dem 20260713000000-Baseline geerbt): Die unten stehenden
-- RPCs tragen noch ein EXECUTE-Recht für PUBLIC und/oder anon. Alle diese
-- Funktionen setzen intern zwingend eine eingeloggte Identität voraus
-- (auth.uid()-basiert) und sind daher für einen anonymen Aufrufer nutzlos —
-- das Recht ist überflüssig und widerspricht dem Least-Privilege-Prinzip, das
-- das Projekt für neuere Funktionen bereits konsequent anwendet
-- (siehe 20260717000001_harden_dispatcher_grants.sql und
-- 20260723000001_account_deletion_reservation_tokens.sql).
--
-- KEINE aktive Lücke: Jede dieser Funktionen bricht ohne gültige Session
-- serverseitig ab (auth.uid() IS NULL / current_user_role() IS NULL). Diese
-- Migration ist Defense-in-Depth: sie entfernt das nutzlose anon/PUBLIC-Recht,
-- damit die Angriffsfläche der DB dem tatsächlichen Bedarf entspricht.
--
-- WARUM "from public" UND "from anon": Das Baseline-Recht liegt bei PUBLIC
-- (proacl-Eintrag "=X/postgres"). Ein bloßes "revoke from anon" bliebe wirkungslos,
-- weil anon das Recht über PUBLIC weiter erbt — exakt die Lehre aus der
-- Dispatcher-Härtung. Deshalb wird von PUBLIC UND anon entzogen und danach
-- authenticated + service_role explizit (re-)granted.
--
-- BEWUSST NICHT ANGEFASST:
--   * current_user_role() / current_user_company_id(): werden in ~79 RLS-
--     USING/WITH-CHECK-Klauseln aufgerufen. Diese Auswertung läuft auch für
--     anon-Requests (die die Zeilen anschließend herausfiltern). Ohne anon-
--     EXECUTE würde eine anon-Query auf jobs/profiles/... mit
--     "permission denied for function" FEHLSCHLAGEN statt leer zurückzukommen.
--     Ihr anon-Recht ist also FUNKTIONAL ERFORDERLICH und bleibt bestehen.
--   * Trigger-Funktionen (enforce_profile_field_guard, enforce_active_assignee,
--     clear_push_token_on_deactivate, handle_new_user): Trigger prüfen KEIN
--     EXECUTE-Recht des auslösenden Rollenkontexts — ihre Grants sind für die
--     Sicherheit irrelevant und werden nicht verändert.
--   * Kontolöschung (prepare_/rollback_self_account_deletion) sowie Dispatcher-
--     RPCs: bereits korrekt gehärtet (anon entzogen bzw. service_role-only).
--
-- CALL-SITES (vor dem Entzug verifiziert — alle mit aktiver Session):
--   start_own_job / complete_own_job ....... services/jobs/jobs.service.ts (Mitarbeiter)
--   get_unread_comment_job_ids ............. services/comments/comments.service.ts
--   generate_/update_job_occurrences ....... services/jobs/jobs.service.ts (Admin);
--                                            update_ ruft generate_ intern als
--                                            SECURITY DEFINER (postgres) auf.
--   setup_company_for_admin ................ services/company/setupCompanyForAdmin.ts (nach Login)
--   register_admin_with_company ............ admin-panel app/register/page.tsx (nach signUp/Session)
--   update_my_push_token / clear_my_push_token  context/AuthContext.tsx
--   accept_own_invite ...................... features/auth/AcceptInviteScreen.tsx (nach updateUser)
--
-- Additiv & idempotent: nur GRANT/REVOKE, keine Signatur-/Logikänderung.
-- =========================================================

-- start_own_job(uuid, timestamptz)
revoke execute on function public.start_own_job(uuid, timestamptz) from public, anon;
grant  execute on function public.start_own_job(uuid, timestamptz) to authenticated, service_role;

-- complete_own_job(uuid, timestamptz)
revoke execute on function public.complete_own_job(uuid, timestamptz) from public, anon;
grant  execute on function public.complete_own_job(uuid, timestamptz) to authenticated, service_role;

-- get_unread_comment_job_ids()
revoke execute on function public.get_unread_comment_job_ids() from public, anon;
grant  execute on function public.get_unread_comment_job_ids() to authenticated, service_role;

-- generate_job_occurrences(uuid)
revoke execute on function public.generate_job_occurrences(uuid) from public, anon;
grant  execute on function public.generate_job_occurrences(uuid) to authenticated, service_role;

-- update_job_occurrences(uuid)
revoke execute on function public.update_job_occurrences(uuid) from public, anon;
grant  execute on function public.update_job_occurrences(uuid) to authenticated, service_role;

-- setup_company_for_admin(text)
revoke execute on function public.setup_company_for_admin(text) from public, anon;
grant  execute on function public.setup_company_for_admin(text) to authenticated, service_role;

-- register_admin_with_company(text, text, text)
revoke execute on function public.register_admin_with_company(text, text, text) from public, anon;
grant  execute on function public.register_admin_with_company(text, text, text) to authenticated, service_role;

-- update_my_push_token(text)
revoke execute on function public.update_my_push_token(text) from public, anon;
grant  execute on function public.update_my_push_token(text) to authenticated, service_role;

-- clear_my_push_token()
revoke execute on function public.clear_my_push_token() from public, anon;
grant  execute on function public.clear_my_push_token() to authenticated, service_role;

-- accept_own_invite()
revoke execute on function public.accept_own_invite() from public, anon;
grant  execute on function public.accept_own_invite() to authenticated, service_role;
