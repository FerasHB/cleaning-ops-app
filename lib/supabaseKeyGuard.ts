// ─────────────────────────────────────────────────────────────────
// SICHERHEITS-GUARD (reine Logik, ohne Seiteneffekte): Klassifiziert den
// Supabase-Client-Key anhand SEINES WERTS — nicht anhand des Variablennamens.
//
// Warum ein eigenes Modul: Diese Funktionen sind absichtlich SEITENEFFEKTFREI
// (kein Client-Aufbau, kein Logging, kein throw). So lassen sie sich später
// ohne Test-Framework isoliert prüfen. Das App-weite Fail-Closed-Verhalten
// (throw + KEIN createClient) liegt bewusst in lib/supabase.ts, nicht hier.
//
// Es wird an KEINER Stelle der Key-Wert (oder ein Teil davon) zurückgegeben
// oder geloggt — ausschließlich die Klassifikation.
// ─────────────────────────────────────────────────────────────────

// Ergebnis der Klassifikation:
//   "public"  → zulässiger Client-Key (Publishable- oder Legacy-anon-Key)
//   "secret"  → Secret-/Service-Role-Key → im Client VERBOTEN
//   "unknown" → unbekanntes Format → fail-closed abgelehnt (könnte ein Secret sein)
//   "missing" → kein Key gesetzt → Konfigurationsfehler (createClient meldet ihn)
export type ClientKeyVerdict = "public" | "secret" | "unknown" | "missing";

// Akzeptierte öffentliche Key-Formate im Projekt:
//   1. Neues Publishable-Format: Präfix "sb_publishable_"
//      (aktuell in .env verwendet, siehe .env.example).
//   2. Legacy-anon-Key: JWT (3 Teile) mit role-Claim "anon".
// Verbotene Formate:
//   - Neues Secret-Format: Präfix "sb_secret_"
//   - Legacy-service_role-Key: JWT mit role-Claim "service_role"
const PUBLISHABLE_PREFIX = "sb_publishable_";
const SECRET_PREFIX = "sb_secret_";

// Extrahiert den role-Claim aus einem JWT, ohne eine Krypto-Lib.
// Gibt den role-String zurück oder null, wenn der Key kein dekodierbares
// JWT mit role-Claim ist. Dekodiert NUR den Payload-Teil (Base64URL) und
// sucht das role-Feld — es findet keine Signaturprüfung statt (nicht nötig:
// wir klassifizieren nur das Format, nicht die Echtheit).
export function jwtRoleClaim(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const g = globalThis as { atob?: (s: string) => string };
    const json = typeof g.atob === "function" ? g.atob(b64) : "";
    const m = json.match(/"role"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Klassifiziert einen Client-Key anhand seines Werts (fail-closed:
// alles nicht sicher als "public" Erkannte gilt als nicht verwendbar).
export function classifyClientKey(key: string | undefined | null): ClientKeyVerdict {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (trimmed.length === 0) return "missing";

  // Neue Formate sind eindeutig am Präfix erkennbar.
  if (trimmed.startsWith(SECRET_PREFIX)) return "secret";
  if (trimmed.startsWith(PUBLISHABLE_PREFIX)) return "public";

  // Legacy-JWT-Formate über den role-Claim unterscheiden.
  const role = jwtRoleClaim(trimmed);
  if (role === "service_role") return "secret";
  if (role === "anon") return "public";

  // Weder ein bekanntes öffentliches Präfix noch ein eindeutiger anon-JWT:
  // bewusst NICHT durchlassen. Ein nicht dekodierbarer service_role-JWT
  // (oder ein künftiges Secret-Format) darf niemals als "public" gelten.
  return "unknown";
}

// True, wenn der Key im Client verwendet werden darf. Nur "public" ist
// erlaubt — "secret", "unknown" und "missing" sind es NICHT.
export function isAcceptablePublicClientKey(key: string | undefined | null): boolean {
  return classifyClientKey(key) === "public";
}
