// utils/userMessages.ts
// Zentrale Übersetzung beliebiger Fehler in nutzerfreundliche, deutsche
// Meldungen — für ALLE nicht-Auth-Fehlerpfade (Jobs, Kommentare, Fotos,
// Mitarbeiter, Stundenzettel, Firma).
//
// Warum: Die Services reichen Supabase-/PostgREST-Fehler an vielen Stellen roh
// weiter (`if (error) throw error;`). Das UI zeigte sie bisher mit dem Muster
//   err instanceof Error ? err.message : fallback
// direkt an — Nutzer sahen dadurch Texte wie
//   "new row violates row-level security policy for table \"job_comments\""
//   "duplicate key value violates unique constraint \"...\""
//   "JSON object requested, multiple (or no) rows returned"
//   "Network request failed"
// also Tabellen-, Policy- und Constraint-Namen aus dem Backend.
//
// `toUserMessage(err, fallback)` ist die eine Anlaufstelle dafür:
//   1. Netzwerk/Offline    → feste Offline-Meldung
//   2. Bekannter Fehlercode/-text → passende deutsche Meldung
//   3. Bereits vom Server/Service auf Deutsch formulierte Meldung
//      (z. B. "Nur Admins dürfen Jobs erstellen.") → unverändert durchreichen
//   4. Alles andere        → screen-spezifischer `fallback` des Aufrufers
//
// Für Auth-/Edge-Function-Fehler bleibt utils/authErrorMessages.ts zuständig
// (kennt GoTrue-Texte und liest Edge-Function-Bodys); toUserMessage ersetzt
// sie NICHT, sondern deckt den Rest der App ab.

import { isNetworkError } from "@/utils/networkError";

// ── Standard-Meldungen ──────────────────────────────────────────────────────
export const GENERIC_ERROR_MESSAGE =
  "Die Aktion konnte nicht ausgeführt werden.";
export const OFFLINE_MESSAGE =
  "Keine Internetverbindung. Bitte versuche es erneut.";
export const PERMISSION_MESSAGE =
  "Du hast keine Berechtigung für diese Aktion.";
export const NOT_FOUND_MESSAGE =
  "Der Eintrag wurde nicht gefunden oder ist nicht mehr verfügbar.";
export const CONFLICT_MESSAGE =
  "Dieser Eintrag existiert bereits.";
export const IN_USE_MESSAGE =
  "Der Eintrag wird noch verwendet und kann nicht gelöscht werden.";
export const INVALID_INPUT_MESSAGE =
  "Die Eingaben sind unvollständig oder ungültig.";
export const SESSION_EXPIRED_MESSAGE =
  "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.";
export const SERVER_UNAVAILABLE_MESSAGE =
  "Der Server ist momentan nicht erreichbar. Bitte versuche es später erneut.";
export const TIMEOUT_MESSAGE =
  "Die Anfrage hat zu lange gedauert. Bitte versuche es erneut.";
export const LOAD_FAILED_MESSAGE = "Die Daten konnten nicht geladen werden.";
export const SAVE_FAILED_MESSAGE =
  "Die Änderungen konnten nicht gespeichert werden.";

// ── Fehlercodes ─────────────────────────────────────────────────────────────
// Postgres-SQLSTATE und PostgREST-Codes, die Supabase im `code`-Feld liefert.
// P0001 (raise_exception) fehlt bewusst: RPCs formulieren dort eigene, meist
// schon deutsche Texte — die laufen unten durch die Durchreiche-Prüfung.
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  // Postgres
  "42501": PERMISSION_MESSAGE, // insufficient_privilege / RLS
  "23505": CONFLICT_MESSAGE, // unique_violation
  "23503": IN_USE_MESSAGE, // foreign_key_violation
  "23502": INVALID_INPUT_MESSAGE, // not_null_violation
  "23514": INVALID_INPUT_MESSAGE, // check_violation
  "22P02": INVALID_INPUT_MESSAGE, // invalid_text_representation
  "57014": TIMEOUT_MESSAGE, // query_canceled
  // PostgREST
  PGRST116: NOT_FOUND_MESSAGE, // 0 oder >1 Zeilen bei .single()
  PGRST301: SESSION_EXPIRED_MESSAGE, // JWT ungültig/abgelaufen
  PGRST204: INVALID_INPUT_MESSAGE, // Spalte im Payload unbekannt
  PGRST202: GENERIC_ERROR_MESSAGE, // RPC nicht gefunden
};

// ── Textmuster ──────────────────────────────────────────────────────────────
// Greifen, wenn kein `code` mitgeliefert wird (z. B. weil der Service den
// Fehler in ein `new Error(...)` umverpackt hat). Reihenfolge: spezifisch → grob.
const MESSAGE_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  // Vor der Berechtigungs-Regel: die Job-RPCs melden gelöschte UND gesperrte
  // Jobs mit demselben Text ("Job not found or not allowed"). Der mit Abstand
  // häufigere Fall ist ein zwischenzeitlich gelöschter/umverteilter Auftrag —
  // "nicht mehr verfügbar" passt dort, während "keine Berechtigung" unnötig
  // alarmiert (und im RLS-Fall inhaltlich ebenfalls zutrifft).
  {
    pattern:
      /job not found|not found or not allowed|no rows returned|results contain 0 rows/i,
    message: NOT_FOUND_MESSAGE,
  },
  {
    pattern:
      /row-level security|violates row-level|permission denied|insufficient privilege|not allowed|nicht erlaubt|nur admins/i,
    message: PERMISSION_MESSAGE,
  },
  {
    pattern: /duplicate key|already exists|unique constraint/i,
    message: CONFLICT_MESSAGE,
  },
  {
    pattern: /foreign key constraint|still referenced/i,
    message: IN_USE_MESSAGE,
  },
  {
    pattern: /violates (check|not-null)|invalid input syntax/i,
    message: INVALID_INPUT_MESSAGE,
  },
  {
    pattern: /invalid jwt|jwt expired|not authenticated|session.{0,15}(missing|not found)/i,
    message: SESSION_EXPIRED_MESSAGE,
  },
  {
    pattern: /timed? ?out|timeout|deadline exceeded|aborted/i,
    message: TIMEOUT_MESSAGE,
  },
  {
    pattern:
      /^5\d{2}\b|internal server error|service unavailable|bad gateway|upstream/i,
    message: SERVER_UNAVAILABLE_MESSAGE,
  },
];

// Sichtbare Spuren von Backend-Internas. Eine Meldung, auf die eines dieser
// Muster passt, wird NIE durchgereicht — auch dann nicht, wenn sie sonst
// deutsch aussieht (z. B. eine deutsche RPC-Meldung mit angehängtem
// Constraint-Namen). Sicherheitsnetz hinter der Muster-Zuordnung oben.
const TECHNICAL_MARKER_PATTERN =
  /\b(select|insert|update|delete|from|where|join|relation|column|table|constraint|policy|schema|function|rpc|sqlstate|pgrst\w*|postgres|supabase|storage|bucket|auth\.uid|null value|stack|typeerror|referenceerror|syntaxerror|econnrefused|enotfound|fetch|http|https?:\/\/|\{|\}|\[object|=>|at [A-Z]\w+\.)\b|_id\b|"[a-z_]+"|`|\bjwt\b/i;

// Positive Prüfung: sieht der Text wie bewusst formulierte deutsche
// Nutzer-Kopie aus? Ohne diese Hürde würde jede unbekannte englische
// Backend-Meldung durchrutschen (Denylist allein ist zu löchrig).
const GERMAN_MARKER_PATTERN =
  /[äöüßÄÖÜ]|\b(bitte|nicht|kein|keine|keinen|konnte|konnten|wurde|wurden|darf|dürfen|muss|müssen|fehlt|ist|sind|du|dein|deine|der|die|das|ein|eine|noch|mehr|erneut|wähle|gib)\b/i;

function extractParts(err: unknown): { message: string; code: string } {
  if (!err) return { message: "", code: "" };
  if (typeof err === "string") return { message: err, code: "" };

  const raw = err as { message?: unknown; code?: unknown; status?: unknown };
  const message =
    typeof raw.message === "string"
      ? raw.message
      : err instanceof Error
        ? err.message
        : "";
  const code =
    typeof raw.code === "string"
      ? raw.code
      : typeof raw.code === "number"
        ? String(raw.code)
        : typeof raw.status === "number"
          ? String(raw.status)
          : "";

  return { message, code };
}

// Darf diese Meldung dem Nutzer unverändert gezeigt werden? Nur wenn sie
// deutsch formuliert ist UND keinerlei technische Marker enthält.
function isUserSafeMessage(message: string): boolean {
  if (!message || message.length > 200) return false;
  if (TECHNICAL_MARKER_PATTERN.test(message)) return false;
  return GERMAN_MARKER_PATTERN.test(message);
}

/**
 * Übersetzt einen beliebigen Fehler in eine anzeigbare deutsche Meldung.
 *
 * `fallback` ist der screen-spezifische Kontext des Aufrufers (z. B. "Job
 * konnte nicht gestartet werden.") und wird immer dann verwendet, wenn der
 * Fehler nicht zugeordnet werden kann — bewusst statt einer einzigen vagen
 * Meldung überall.
 */
export function toUserMessage(
  err: unknown,
  fallback: string = GENERIC_ERROR_MESSAGE,
): string {
  if (isNetworkError(err)) return OFFLINE_MESSAGE;

  const { message, code } = extractParts(err);

  const byCode = CODE_MESSAGES[code];
  if (byCode) return byCode;

  for (const { pattern, message: friendly } of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return friendly;
  }

  if (isUserSafeMessage(message)) return message;

  return fallback;
}
