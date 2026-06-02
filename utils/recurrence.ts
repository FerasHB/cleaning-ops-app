// utils/recurrence.ts
// Hilfsfunktionen für wiederkehrende Aufträge (recurring jobs).
// Wochentage werden in der DB als stabile englische Kurzcodes gespeichert
// ("mon" … "sun") und nur in der UI auf Deutsch übersetzt.

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// Reihenfolge bewusst Montag-zuerst (DE-üblich) für die UI-Auswahl.
export const WEEKDAYS: { key: WeekdayKey; label: string; short: string }[] = [
  { key: "mon", label: "Montag", short: "Mo" },
  { key: "tue", label: "Dienstag", short: "Di" },
  { key: "wed", label: "Mittwoch", short: "Mi" },
  { key: "thu", label: "Donnerstag", short: "Do" },
  { key: "fri", label: "Freitag", short: "Fr" },
  { key: "sat", label: "Samstag", short: "Sa" },
  { key: "sun", label: "Sonntag", short: "So" },
];

// JS Date.getDay(): 0 = Sonntag … 6 = Samstag → unser Key
const DAY_INDEX_TO_KEY: WeekdayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

const KEY_TO_SHORT: Record<string, string> = WEEKDAYS.reduce(
  (acc, w) => {
    acc[w.key] = w.short;
    return acc;
  },
  {} as Record<string, string>,
);

/** Liefert den Wochentag-Key (mon…sun) für ein Datum. */
export function getWeekdayKey(date: Date): WeekdayKey {
  return DAY_INDEX_TO_KEY[date.getDay()];
}

/** Prüft, ob der Wochentag von `date` in der Liste enthalten ist. */
export function isWeekdayInList(
  date: Date,
  days: string[] | null | undefined,
): boolean {
  if (!days || days.length === 0) return false;
  return days.includes(getWeekdayKey(date));
}

/**
 * Formatiert die Wochentage zu lesbarem Deutsch, sortiert in Wochen-Reihenfolge.
 * z.B. ["thu","mon"] → "Mo, Do"
 */
export function formatRecurringDays(days: string[] | null | undefined): string {
  if (!days || days.length === 0) return "—";
  const set = new Set(days);
  return WEEKDAYS.filter((w) => set.has(w.key))
    .map((w) => w.short)
    .join(", ");
}
