// utils/authDiagnostics.ts
// ─────────────────────────────────────────────────────────────────
// TEMPORÄR — NUR FÜR DIE DIAGNOSE DES INTERMITTIERENDEN PKCE-RECOVERY-FEHLERS.
//
// Vor dem Merge ersatzlos entfernen, zusammen mit:
//   • EXPO_PUBLIC_AUTH_DIAGNOSTICS im preview-Profil von eas.json
//   • allen rein diagnostischen devLog/authDebug-Zeilen in
//     features/auth/useAuthLinkSession.ts, features/auth/ResetPasswordScreen.tsx
//     und context/AuthContext.tsx
//
// Grund für die Existenz dieser Datei: der Fehler tritt ausschließlich in
// einem echten Preview-Build auf dem iPhone auf. Dort ist __DEV__ false, die
// bestehenden Diagnose-Zeilen wären also stumm. Ein Dev-Client ist keine
// Alternative, weil dessen Deep-Link-Redirect (eigenes Schema + Metro-Host)
// nicht in der Supabase-Allow-List steht und Supabase deshalb still auf
// site_url zurückfällt — die App würde sich gar nicht öffnen.
//
// Es wird NIE ein Passwort, Code, code_verifier, Token, eine vollständige
// Recovery-URL oder ein Secret geloggt — ausschließlich Zähler, Zustands-
// namen, Fehlertypen und YES/NO-Angaben.
// ─────────────────────────────────────────────────────────────────

export const AUTH_DIAGNOSTICS_ENABLED =
  __DEV__ || process.env.EXPO_PUBLIC_AUTH_DIAGNOSTICS === "1";
