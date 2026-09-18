import { i18next, INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";

export function formatToISO(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function parseToDate(date: Date | string | null | undefined): Date | null {
  if (!date) return null;
  const d = new Date(date);
  return isNaN(d.getTime()) ? null : d;
}

// ─────────────────────────────────────────────
// Helfer für wiederkehrende/terminierte Jobs
// ─────────────────────────────────────────────

/** Formatiert ein Datum als lokale Uhrzeit "HH:mm" (für DB-Spalte start_time). */
export function formatTimeHHmm(date: Date | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Normalisiert eine DB-Zeit ("HH:mm:ss" oder "HH:mm") auf "HH:mm". */
export function normalizeTime(time: string | null | undefined): string | null {
  if (!time) return null;
  return time.slice(0, 5);
}

/** Baut aus einer Zeit "HH:mm" ein Date (heutiges Datum) für den Time-Picker. */
export function timeStringToDate(time: string | null | undefined): Date | null {
  const normalized = normalizeTime(time);
  if (!normalized) return null;
  const [h, m] = normalized.split(":").map((n) => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return null;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Baut aus den MASSGEBLICHEN Terminfeldern `date` ("YYYY-MM-DD") und
 * `start_time` ("HH:mm[:ss]") ein LOKALES Date für die Datum-/Uhrzeit-Picker.
 *
 * Bewusst NICHT aus `scheduled_start` ableiten: diese Spalte wird
 * serverseitig per einfacher Konkatenation (`date || ' ' || start_time`)
 * in die Zeitzone der Datenbank (UTC) geschrieben. `new Date(scheduledStart)`
 * rendert sie danach in der LOKALEN Zeitzone und verschiebt die Uhrzeit um den
 * UTC-Versatz — aus 19:30 würde in Deutschland 21:30. Wird ein Formular so
 * vorbelegt, schreibt schon das Speichern eines unbeteiligten Feldes eine
 * verschobene Uhrzeit zurück; bei einem generierten Termin gilt er damit als
 * einzeln angepasst ("Abweichender Termin", siehe Migration 20260916000000).
 * `date` + `start_time` sind laut CLAUDE.md ohnehin die maßgebliche Quelle.
 */
export function localDateTimeFrom(
  dateKey: string | null | undefined,
  time: string | null | undefined,
): Date | null {
  if (!dateKey) return null;
  const parts = dateKey.slice(0, 10).split("-");
  if (parts.length !== 3) return null;
  const [year, month, day] = parts.map((n) => parseInt(n, 10));
  if (!year || !month || !day) return null;

  const normalized = normalizeTime(time);
  const [hours, minutes] = normalized
    ? normalized.split(":").map((n) => parseInt(n, 10))
    : [0, 0];
  if (isNaN(hours) || isNaN(minutes)) return null;

  const d = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Formatiert ein Datum als lokales "YYYY-MM-DD" (für DB-Spalte date). */
export function formatDateISO(date: Date | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Prüft, ob ein "YYYY-MM-DD"-String dem lokalen Datum von `ref` entspricht. */
export function isSameLocalDate(
  dateString: string | null | undefined,
  ref: Date,
): boolean {
  if (!dateString) return false;
  return formatDateISO(ref) === dateString.slice(0, 10);
}

// ─────────────────────────────────────────────
// Dauer-Helfer (Stundenzettel/Arbeitszeit)
// ─────────────────────────────────────────────

/**
 * Differenz zweier ISO-Zeitstempel in Minuten (kaufmännisch gerundet).
 * Negative oder ungültige Werte ergeben 0 (defensiv gegen Datenanomalien).
 */
export function diffInMinutes(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number {
  if (!startIso || !endIso) return 0;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  const minutes = Math.round((end - start) / 60000);
  return minutes > 0 ? minutes : 0;
}

/** Formatiert Minuten als "H:mm" (z.B. 150 → "2:30"). Für den PDF-Stundenzettel. */
export function formatDurationHm(totalMinutes: number): string {
  const safe = totalMinutes > 0 ? totalMinutes : 0;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Formatiert Minuten als Langform (z.B. 15 → "15 min", 65 → "1h 05min").
 * Für Job-Karten/Detail-Ansicht — lesbarer als formatDurationHm, das dem
 * klassischen Stundenzettel-Format vorbehalten bleibt.
 */
export function formatDurationLong(totalMinutes: number): string {
  const safe = totalMinutes > 0 ? totalMinutes : 0;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours}h ${String(minutes).padStart(2, "0")}min`;
}

// ─────────────────────────────────────────────
// Sprachabhängige Anzeige-Formatierung (Mitarbeiter-UI, Phase C.2)
// ─────────────────────────────────────────────
//
// formatDateOnlyDE/formatDateTimeDE wurden in Phase D entfernt (letzte
// Aufrufer, AdminAuReviewScreen/TimeCorrectionSheet, nutzen jetzt
// formatDateOnlyLocalized/formatDateTimeLocalized). Reagieren live auf
// Sprachwechsel: i18next.language wird bei jedem Aufruf frisch gelesen (analog
// utils/calendarMonth.ts, utils/jobAssignees.ts).

function activeDateLocaleTag(): string {
  return INTL_LOCALE_TAGS[i18next.language as AppLocale] ?? "de-DE";
}

/**
 * Formatiert einen ISO-Zeitstempel als Datum + Uhrzeit in der aktiven
 * App-Sprache, z. B. "14.09.2026 um 18:54" (de) / "09/14/2026 at 18:54" (en).
 * Verbindungswort über den bestehenden Schlüssel jobs:comments.dateAt (schon
 * in allen 4 Sprachen vorhanden, siehe JobComments.tsx) — kein Duplikat.
 */
export function formatDateTimeLocalized(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  const localeTag = activeDateLocaleTag();
  const datePart = date.toLocaleDateString(localeTag, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString(localeTag, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return i18next.t("jobs:comments.dateAt", { date: datePart, time: timePart });
}

/**
 * Formatiert ein "YYYY-MM-DD"-Datum (ohne Uhrzeit) in der aktiven
 * App-Sprache, z. B. "14.09.2026" (de/tr) / "09/14/2026" (en) / Arabische
 * Ziffern (ar). Baut das Datum lokal (kein `new Date("YYYY-MM-DD")` — das
 * parst als UTC-Mitternacht und kann je nach Zeitzone auf den Vortag rutschen).
 */
export function formatDateOnlyLocalized(dateKey?: string | null): string | null {
  if (!dateKey) return null;
  const [y, m, d] = dateKey
    .slice(0, 10)
    .split("-")
    .map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString(activeDateLocaleTag(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
