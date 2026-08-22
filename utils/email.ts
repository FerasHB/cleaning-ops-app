// utils/email.ts
// Gemeinsame E-Mail-Normalisierung und Format-Prüfung für alle Auth-Formulare
// (Login, Registrierung, Passwort vergessen). Verhindert, dass unterschiedliche
// Groß-/Kleinschreibung oder Leerzeichen zu abweichenden Supabase-Auth-
// Nutzern führen. Ändert niemals das Passwort.

/** Trimmt Whitespace und normalisiert die Groß-/Kleinschreibung für Supabase Auth. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Bewusst ein einfaches, permissives Muster (kein RFC-5322-Vollvalidator) —
// Ziel ist, offensichtliche Tippfehler ("foo@bar") früh im Formular statt
// erst als generischer "E-Mail oder Passwort ist falsch."-Fehler zu fangen.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Grobe Format-Prüfung für Client-seitiges UI-Feedback (nicht die einzige Absicherung — Supabase validiert serverseitig). */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}
