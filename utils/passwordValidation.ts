// utils/passwordValidation.ts
// Gemeinsame Validierung für "neues Passwort setzen"-Formulare (Reset,
// Einladungs-Annahme). Muss mit der serverseitigen Mindestlänge übereinstimmen
// (siehe supabase.auth-Passwortregeln / vormals create-employee-Validierung).

/** Null bei gültiger Eingabe, sonst eine deutsche Fehlermeldung. */
export function validateNewPassword(
  password: string,
  confirmPassword: string,
): string | null {
  if (!password.trim()) return "Bitte ein neues Passwort eingeben.";
  if (password.length < 6)
    return "Das Passwort muss mindestens 6 Zeichen lang sein.";
  if (password !== confirmPassword)
    return "Die Passwörter stimmen nicht überein.";
  return null;
}
