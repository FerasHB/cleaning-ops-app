// utils/phone.ts
// Gemeinsame Telefonnummer-Normalisierung/-Validierung/-Formatierung für alle
// Formulare (Registrierung, Firma einrichten, Profil bearbeiten, Firmen-
// Einstellungen, Mitarbeiter einladen) sowie die Anruf-Aktion (utils/dialogs).
//
// Speicherformat ist IMMER E.164: '+' gefolgt von 7–15 Ziffern, erste Ziffer
// nach '+' ungleich 0 (z. B. +491701234567). Genau dieses Format erwarten
// später auch Supabase Auth Phone-OTP / MFA — deshalb kein späteres Reformat.
//
// Deutschland zuerst: DEFAULT_PHONE_COUNTRY = 'DE'. `normalizePhone` nimmt
// optional ein Land, damit die internationale Erweiterung nur diesen einen
// Parameter dreht (später aus companies.locale oder einer Länderauswahl) —
// die gespeicherten Werte bleiben unverändert.
//
// Bewusst OHNE libphonenumber (~500 KB): eine kleine, deterministische Regel
// deckt DE + generische internationale Eingaben ab. Feiner validiert
// serverseitig der DB-CHECK (^\+[1-9][0-9]{6,14}$) — dieselbe Grenze.
// Seiteneffektfrei, ohne RN-/Expo-Importe → per
// `node --experimental-strip-types scripts/check-phone.mjs` testbar.

export type PhoneCountry = "DE";

export const DEFAULT_PHONE_COUNTRY: PhoneCountry = "DE";

// E.164: + und 8–15 Ziffern insgesamt (erste ≠ 0). Deckungsgleich mit dem
// CHECK-Constraint in 20260912000000_company_contact_foundation.sql.
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const COUNTRY_DIAL_CODE: Record<PhoneCountry, string> = {
  DE: "49",
};

/**
 * Wandelt eine Roh-Eingabe in E.164 um oder gibt `null` zurück, wenn daraus
 * keine plausible Nummer wird.
 *
 * Regeln (in dieser Reihenfolge):
 *   1. Trenner entfernen: Leerzeichen, `/`, `-`, `.`, `(`, `)`.
 *   2. `00…`  → `+…`      (internationaler Präfix)
 *   3. `+…`   → unverändert übernehmen
 *   4. `0…`   → Landesvorwahl + Rest ohne die führende 0 (nationaler Präfix)
 *   5. reine Ziffern ohne Präfix → als bereits vollständige Nummer mit `+`
 *      davor interpretieren (deckt "491701234567" ab)
 *   6. Ergebnis muss E164_PATTERN erfüllen, sonst `null`.
 */
export function normalizePhone(
  raw: string | null | undefined,
  country: PhoneCountry = DEFAULT_PHONE_COUNTRY,
): string | null {
  if (raw == null) return null;

  let value = String(raw).replace(/[\s/().-]/g, "");
  if (value === "") return null;

  const dial = COUNTRY_DIAL_CODE[country];

  if (value.startsWith("00")) {
    value = "+" + value.slice(2);
  } else if (value.startsWith("+")) {
    // unverändert
  } else if (value.startsWith("0")) {
    value = "+" + dial + value.slice(1);
  } else if (/^\d+$/.test(value)) {
    value = "+" + value;
  }

  return E164_PATTERN.test(value) ? value : null;
}

/** UI-Feedback: true, wenn `normalizePhone` etwas Gültiges liefert. */
export function isValidPhone(
  raw: string | null | undefined,
  country: PhoneCountry = DEFAULT_PHONE_COUNTRY,
): boolean {
  return normalizePhone(raw, country) !== null;
}

/**
 * Anzeige-Formatierung. Wirft NIE — kann sie eine Nummer nicht deuten, gibt
 * sie die Eingabe unverändert zurück. Für DE: `+49 170 1234567`
 * (Vorwahl-Heuristik bewusst simpel), sonst `+CC RestInDreierBlöcken`.
 */
export function formatPhoneForDisplay(
  value: string | null | undefined,
): string {
  if (!value) return "";
  const e164 = normalizePhone(value);
  if (!e164) return String(value);

  if (e164.startsWith("+49") && e164.length > 5) {
    const rest = e164.slice(3);
    // grobe Aufteilung: die ersten 3 Ziffern als "Vorwahl/Netz", Rest am Stück
    return `+49 ${rest.slice(0, 3)} ${rest.slice(3)}`.trimEnd();
  }

  const cc = e164.slice(1, e164.length - 10) || e164.slice(1, 3);
  const subscriber = e164.slice(1 + cc.length);
  const grouped = subscriber.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
  return `+${cc} ${grouped}`.trim();
}
