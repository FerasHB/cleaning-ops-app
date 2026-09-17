// utils/userMessages.ts
// Zentrale Übersetzung beliebiger Fehler in nutzerfreundliche, ÜBERSETZTE
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
//   1. Netzwerk/Offline    → feste, übersetzte Offline-Meldung
//   2. Bekannter Fehlercode/-text → passende übersetzte Meldung
//   3. Bereits vom Server/Service auf DEUTSCH formulierte Meldung
//      (z. B. "Nur Admins dürfen Jobs erstellen.") → unverändert durchreichen,
//      ABER NUR wenn die aktive UI-Sprache Deutsch ist (siehe
//      isUserSafeMessage) — RPCs formulieren ihre eigenen Meldungen bislang
//      ausschließlich auf Deutsch (server-seitige Lokalisierung ist eine
//      spätere Phase); in jeder anderen UI-Sprache wäre die deutsche
//      RPC-Meldung für den Nutzer nicht verständlich, also fällt der Code in
//      diesem Fall stattdessen auf den (übersetzten) `fallback` zurück.
//   4. Alles andere        → screen-spezifischer, übersetzter `fallback` des
//      Aufrufers
//
// Für Auth-/Edge-Function-Fehler bleibt utils/authErrorMessages.ts zuständig
// (kennt GoTrue-Texte und liest Edge-Function-Bodys); toUserMessage ersetzt
// sie NICHT, sondern deckt den Rest der App ab.
//
// Plain-function-Datei (keine Komponente) — kein useTranslation()-Hook
// möglich. Nutzt wie utils/dialogs.ts die exportierte i18next-Instanz direkt:
// i18next.t() liest die aktuell aktive Sprache bei JEDEM Aufruf frisch,
// bleibt also über Sprachwechsel hinweg korrekt (siehe i18n/index.ts).

import { isNetworkError } from "@/utils/networkError";
import { i18next } from "@/i18n";

// ── Fehlercodes ─────────────────────────────────────────────────────────────
// Postgres-SQLSTATE und PostgREST-Codes, die Supabase im `code`-Feld liefert,
// abgebildet auf i18next-Keys (common:errors.*) statt literaler Texte, damit
// die Zuordnung sprachunabhängig bleibt und t() erst beim tatsächlichen
// Treffer aufgelöst wird.
// P0001 (raise_exception) fehlt bewusst: RPCs formulieren dort eigene, meist
// schon deutsche Texte — die laufen unten durch die Durchreiche-Prüfung.
const CODE_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  // Postgres
  "42501": "common:errors.permission", // insufficient_privilege / RLS
  "23505": "common:errors.conflict", // unique_violation
  "23503": "common:errors.inUse", // foreign_key_violation
  "23502": "common:errors.invalidInput", // not_null_violation
  "23514": "common:errors.invalidInput", // check_violation
  "22P02": "common:errors.invalidInput", // invalid_text_representation
  "57014": "common:errors.timeout", // query_canceled
  // PostgREST
  PGRST116: "common:errors.notFound", // 0 oder >1 Zeilen bei .single()
  PGRST301: "common:errors.sessionExpired", // JWT ungültig/abgelaufen
  PGRST204: "common:errors.invalidInput", // Spalte im Payload unbekannt
  PGRST202: "common:errors.generic", // RPC nicht gefunden
};

// ── Textmuster ──────────────────────────────────────────────────────────────
// Greifen, wenn kein `code` mitgeliefert wird (z. B. weil der Service den
// Fehler in ein `new Error(...)` umverpackt hat). Reihenfolge: spezifisch → grob.
const MESSAGE_PATTERNS: readonly { pattern: RegExp; key: string }[] = [
  // Vor der Berechtigungs-Regel: die Job-RPCs melden gelöschte UND gesperrte
  // Jobs mit demselben Text ("Job not found or not allowed"). Der mit Abstand
  // häufigere Fall ist ein zwischenzeitlich gelöschter/umverteilter Auftrag —
  // "nicht mehr verfügbar" passt dort, während "keine Berechtigung" unnötig
  // alarmiert (und im RLS-Fall inhaltlich ebenfalls zutrifft).
  {
    pattern:
      /job not found|not found or not allowed|no rows returned|results contain 0 rows/i,
    key: "common:errors.notFound",
  },
  {
    pattern:
      /row-level security|violates row-level|permission denied|insufficient privilege|not allowed|nicht erlaubt|nur admins/i,
    key: "common:errors.permission",
  },
  {
    pattern: /duplicate key|already exists|unique constraint/i,
    key: "common:errors.conflict",
  },
  {
    pattern: /foreign key constraint|still referenced/i,
    key: "common:errors.inUse",
  },
  {
    pattern: /violates (check|not-null)|invalid input syntax/i,
    key: "common:errors.invalidInput",
  },
  {
    pattern: /invalid jwt|jwt expired|not authenticated|session.{0,15}(missing|not found)/i,
    key: "common:errors.sessionExpired",
  },
  {
    pattern: /timed? ?out|timeout|deadline exceeded|aborted/i,
    key: "common:errors.timeout",
  },
  {
    pattern:
      /^5\d{2}\b|internal server error|service unavailable|bad gateway|upstream/i,
    key: "common:errors.serverUnavailable",
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
// deutsch formuliert ist, keinerlei technische Marker enthält UND die aktive
// UI-Sprache Deutsch ist — RPCs formulieren ihre Meldungen ausschließlich auf
// Deutsch (siehe Dateikopf); in jeder anderen Sprache wäre der Text für den
// Nutzer nicht verständlich, der Aufrufer fällt dann auf den übersetzten
// `fallback` zurück statt eine deutsche RPC-Meldung in eine
// englische/arabische/türkische Oberfläche durchzureichen.
function isUserSafeMessage(message: string): boolean {
  if (!message || message.length > 200) return false;
  if (TECHNICAL_MARKER_PATTERN.test(message)) return false;
  if (!i18next.language?.startsWith("de")) return false;
  return GERMAN_MARKER_PATTERN.test(message);
}

/**
 * Übersetzt einen beliebigen Fehler in eine anzeigbare, übersetzte Meldung.
 *
 * `fallback` ist der screen-spezifische, bereits übersetzte Kontext des
 * Aufrufers (z. B. t("jobs:errors.startFailed")) und wird immer dann
 * verwendet, wenn der Fehler nicht zugeordnet werden kann — bewusst statt
 * einer einzigen vagen Meldung überall.
 */
export function toUserMessage(
  err: unknown,
  fallback: string = i18next.t("common:errors.generic"),
): string {
  if (isNetworkError(err)) return i18next.t("common:errors.offline");

  const { message, code } = extractParts(err);

  const byCodeKey = CODE_MESSAGE_KEYS[code];
  if (byCodeKey) return i18next.t(byCodeKey);

  for (const { pattern, key } of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return i18next.t(key);
  }

  if (isUserSafeMessage(message)) return message;

  return fallback;
}
