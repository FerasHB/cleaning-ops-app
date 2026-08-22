// utils/email.ts
// Gemeinsame E-Mail-Normalisierung für alle Auth-Formulare (Login,
// Registrierung, Passwort vergessen). Verhindert, dass unterschiedliche
// Groß-/Kleinschreibung oder Leerzeichen zu abweichenden Supabase-Auth-
// Nutzern führen. Ändert niemals das Passwort.

/** Trimmt Whitespace und normalisiert die Groß-/Kleinschreibung für Supabase Auth. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
