# create-employee / resend-invite — Deployment & manuelle Schritte

Mitarbeiter-Einladungsflow: Admin lädt per E-Mail ein (`admin.inviteUserByEmail`),
der Mitarbeiter setzt sein eigenes Passwort über einen Deep-Link
(`taskopsmanager://accept-invite` in Production, `taskopsmanagerdev://accept-invite`
auf Staging — siehe `features/auth/AcceptInviteScreen.tsx` und
„Deep-Link-Schema pro Umgebung" unten).

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

3. **Redirect-URLs im Dashboard eintragen (Pflicht, sonst schlägt jede
   Einladung fehl) — pro Projekt GENAU das eigene Schema:**

   **Dashboard → (Projekt wählen) → Authentication → URL Configuration →
   Redirect URLs**

   | Projekt | Redirect URLs (exakt diese, keine weiteren App-Schemata) |
   |---|---|
   | Production (`ivzsbspopudqgobunsdv`) | `taskopsmanager://reset-password`, `taskopsmanager://accept-invite` |
   | Staging (`legzogskvcmicdgowyax`) | `taskopsmanagerdev://reset-password`, `taskopsmanagerdev://accept-invite` |

   **Niemals das Schema der anderen Umgebung eintragen:** Supabase würde einen
   so angeforderten Link akzeptieren, und die Mail öffnete die App der
   falschen Umgebung (Phase 14: Staging-Reset-Link öffnete die
   Produktions-App, der PKCE-code_verifier fehlte dort). Ohne passenden
   Eintrag fällt Supabase auf die Site URL zurück — der Link ist dann defekt,
   landet aber nie in der falschen App.

## Deep-Link-Schema pro Umgebung

`inviteUserByEmail` läuft server-seitig in der Edge Function — anders als beim
client-ausgelösten Passwort-Reset (`createAuthRedirectUrl(...)`, siehe
`services/auth/authRedirect.ts`) kennt die Function die App-Installation nicht.
Die `redirectTo` folgt daher dem Projekt (`../_shared/appUrlScheme.ts`,
abgeleitet aus dem automatisch injizierten `SUPABASE_URL`): Staging →
`taskopsmanagerdev://`, alles andere → `taskopsmanager://`. Nach einer Änderung
an `_shared/` **beide** Functions neu deployen. Einladungs-Links funktionieren
nur in Dev-Client- oder Standalone-Builds, **nicht** in Expo Go.

## E-Mail-Template

Eigenes Branding liegt als HTML in `supabase/templates/invite.html` (Invite)
und `supabase/templates/recovery.html` (Passwort-Reset) im Repo und ist über
`config.toml` (`[auth.email.template.invite]` / `[auth.email.template.recovery]`)
für die **lokale** Supabase-CLI-Instanz aktiv.

**Für Prod wirkt das nicht automatisch** — das gehostete Projekt liest seine
Mail-Templates aus dem Dashboard, nicht aus `config.toml`. Der HTML-Inhalt
der beiden Dateien muss daher manuell eingefügt werden unter:
**Dashboard → Authentication → Email Templates → Invite user** bzw.
**→ Reset Password**. Bei Änderungen an den Templates im Repo diesen Schritt
wiederholen, sonst laufen Repo und Prod auseinander.

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
