// utils/passwordValidation.ts
// Gemeinsame Passwort-Validierung für alle Formulare, die ein neues Passwort
// setzen (Registrierung, Einladungs-Annahme, Passwort zurücksetzen/ändern).
// Muss mit der serverseitigen Mindestlänge übereinstimmen (Supabase Auth
// `password_min_length` — siehe supabase/config.toml und Abschlussbericht
// für den nötigen Dashboard-Abgleich auf Staging/Prod).

export const MIN_PASSWORD_LENGTH = 10;

export const PASSWORD_MISMATCH_MESSAGE = "Die Passwörter stimmen nicht überein.";

export type PasswordValidationResult = {
  valid: boolean;
  /** Deutsche Fehlermeldungen, leer wenn `valid`. Für UI-Feedback nutzbar. */
  errors: string[];
};

/** Prüft ein neues Passwort gegen die Mindestlänge. Liefert Details für UI-Feedback statt nur einem Boolean. */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (!password.trim()) {
    errors.push("Bitte ein Passwort eingeben.");
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
  }

  return { valid: errors.length === 0, errors };
}

/** Wie validatePassword, plus Abgleich mit der Bestätigung. Null bei gültiger Eingabe, sonst eine deutsche Fehlermeldung. */
export function validateNewPassword(
  password: string,
  confirmPassword: string,
): string | null {
  const { valid, errors } = validatePassword(password);
  if (!valid) return errors[0];
  if (password !== confirmPassword) return PASSWORD_MISMATCH_MESSAGE;
  return null;
}
