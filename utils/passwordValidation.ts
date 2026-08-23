// utils/passwordValidation.ts
// Gemeinsame Passwort-Validierung für alle Formulare, die ein neues Passwort
// setzen (Registrierung, Einladungs-Annahme, Passwort zurücksetzen/ändern).
// Muss mit der serverseitigen Mindestlänge übereinstimmen (Supabase Auth
// `password_min_length` — siehe supabase/config.toml und Abschlussbericht
// für den nötigen Dashboard-Abgleich auf Staging/Prod).

export const MIN_PASSWORD_LENGTH = 10;

// Supabase Auth hasht Passwörter mit bcrypt, das nur die ersten 72 BYTES
// (nicht Zeichen) verwendet — bei Überschreitung antwortet GoTrue nicht mit
// einer sauberen Validierungsmeldung, sondern mit einem rohen, instabilen
// 500 "unexpected_failure" (verifiziert direkt gegen Staging). Da dieses
// 72-Byte-Limit eine feste, dokumentierte Eigenschaft von bcrypt selbst ist
// (nicht etwas, das sich mit der Supabase-Version ändert), lohnt sich eine
// clientseitige Schranke, statt sich auf die Fehlerzuordnung eines instabilen
// 500ers zu verlassen. Byte- statt zeichenbasiert geprüft, da Unicode-Zeichen
// (Emoji, Umlaute außerhalb Latin-1 etc.) mehr als 1 Byte belegen können.
export const MAX_PASSWORD_BYTES = 72;

export const PASSWORD_MISMATCH_MESSAGE = "Die Passwörter stimmen nicht überein.";

export type PasswordValidationResult = {
  valid: boolean;
  /** Deutsche Fehlermeldungen, leer wenn `valid`. Für UI-Feedback nutzbar. */
  errors: string[];
};

// UTF-8-Byte-Länge ohne TextEncoder (dessen Verfügbarkeit auf allen
// RN/Hermes-Zielplattformen nicht gesichert ist) — behandelt Surrogatpaare
// (z.B. Emoji) korrekt über codePointAt.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) i++; // Surrogatpaar: zweite UTF-16-Einheit überspringen
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Prüft ein neues Passwort gegen Mindest- und Höchstlänge. Liefert Details für UI-Feedback statt nur einem Boolean. */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (!password.trim()) {
    errors.push("Bitte ein Passwort eingeben.");
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
  } else if (utf8ByteLength(password) > MAX_PASSWORD_BYTES) {
    errors.push("Das Passwort ist zu lang.");
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
