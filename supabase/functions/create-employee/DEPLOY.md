# create-employee / resend-invite — Deployment & manuelle Schritte

Mitarbeiter-Einladungsflow: Admin lädt per E-Mail ein (`admin.inviteUserByEmail`),
der Mitarbeiter setzt sein eigenes Passwort über einen Deep-Link
(`taskopsmanager://accept-invite`, siehe `features/auth/AcceptInviteScreen.tsx`).

## Reihenfolge (wichtig)

1. **Migration zuerst anwenden.** `supabase/migrations/20260718000000_employee_invitations.sql`
   **manuell im Supabase SQL Editor** ausführen, **bevor** diese Functions oder
   der neue App-Code released werden. Der Client selektiert
   `invite_accepted_at` bei **jedem Login** (`getProfileByUserId`) — ohne die
   Migration schlägt der Login für **alle** Nutzer fehl
   (`column "invite_accepted_at" does not exist`), nicht nur für neue
   Einladungen. Die Migration backfillt bestehende Profile automatisch als
   "bereits akzeptiert", damit niemand rückwirkend ausgesperrt wird.

2. **Functions deployen:**

   ```bash
   supabase functions deploy create-employee
   supabase functions deploy resend-invite
   ```

   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` werden für
   deployte Functions automatisch injiziert. Beide prüfen die Authorization
   selbst (`verify_jwt = false` in `config.toml`) und sind auf `role = 'admin'`
   der eigenen Firma beschränkt.

3. **Redirect-URL im Dashboard eintragen (Pflicht, sonst schlägt jede
   Einladung fehl):**

   **Dashboard → Authentication → URL Configuration → Redirect URLs** —
   folgenden Wert hinzufügen:

   ```
   taskopsmanager://accept-invite
   ```

   Ohne diesen Eintrag leitet Supabase den Einladungs-Link nicht zur App
   um (identische Anforderung besteht bereits für `taskopsmanager://reset-password`,
   falls das noch nicht eingetragen ist, ebenfalls prüfen).

## Bekannte Einschränkung: nur Dev-Client-/Standalone-Builds

`inviteUserByEmail` läuft server-seitig in der Edge Function — anders als beim
client-ausgelösten Passwort-Reset (`Linking.createURL(...)`) kennt die
Function die aktuelle Expo-Go-Proxy-URL nicht. Die `redirectTo` ist daher fest
auf das `taskopsmanager://`-Scheme gesetzt. Einladungs-Links funktionieren
folglich nur in Dev-Client- oder Standalone-Builds, **nicht** in Expo Go.

## E-Mail-Template

Nutzt Supabase's Standard-"Invite user"-Template. Für eigenes Branding:
**Dashboard → Authentication → Email Templates → Invite user** — reiner
Dashboard-Schritt, nicht Teil dieses Repos.

## Sicherheit

- Kein Passwort verlässt je den Admin-Client oder diese Functions — der
  Mitarbeiter setzt sein Passwort ausschließlich selbst über
  `supabase.auth.updateUser(...)` nach Einlösen des Einladungs-Links.
- Einladungs-/Recovery-Tokens sind bei Supabase (GoTrue) grundsätzlich
  einmalig gültig — ein bereits eingelöster Link zeigt beim erneuten Öffnen
  den "ungültig/abgelaufen"-Zustand.
- `resend-invite` verweigert das erneute Einladen, sobald
  `profiles.invite_accepted_at` gesetzt ist (Mitarbeiter hat bereits ein
  eigenes Passwort) — verhindert versehentliches Zurücksetzen eines aktiven
  Kontos über diesen Weg.
