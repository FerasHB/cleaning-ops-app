export function formatToISO(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatForDisplay(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";

  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");

  return `${day}.${month}.${year} ${hours}:${minutes}`;
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
