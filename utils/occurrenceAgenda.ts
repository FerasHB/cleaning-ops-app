// utils/occurrenceAgenda.ts
// Reine, testbare Aufbereitung der generierten Termine EINER Dauerauftrags-
// Regel für die Agenda-Ansicht. KEINE React-/Supabase-Imports.
//
// Aufgabe: aus der (unveränderten) Liste von getJobOccurrences eine Struktur
// bauen, die progressiv aufgedeckt werden kann —
//   1. „Als Nächstes"  – die nächsten N Termine, immer sichtbar
//   2. Monatsgruppen   – der Rest der Zukunft, eingeklappt
//   3. Vergangenes     – nach Monaten, neueste zuerst, eingeklappt
//
// WARUM HIER UND NICHT IM SERVICE: getJobOccurrences bleibt in diesem PR
// bewusst unverändert (kein Paging, keine Datumsgrenze). Die Liste kann daher
// mehrere hundert Zeilen enthalten. Die Begrenzung passiert rein in der
// Darstellung: die UI hängt nur die Zeilen ein, deren Gruppe aufgeklappt ist.
// Deshalb liefert diese Datei GRUPPEN (mit Zähler), nicht eine flache Liste —
// der Zähler ist ohne Mount der Zeilen bekannt.
//
// VOLLSTÄNDIGKEIT (invariant): jeder übergebene Termin landet in genau einer
// Ausgabe-Menge — nextUp, upcomingGroups oder pastGroups. Es wird nie ein
// Datensatz weggelassen; „eingeklappt" ist nicht dasselbe wie „verborgen".

import type { Job } from "@/types/job";

/** Deterministische deutsche Monatsnamen (kein Intl-/Locale-Risiko). */
const MONTH_NAMES = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

/** Gruppen-Key für Termine ohne Datum (defensiv — sollte nie vorkommen). */
export const NO_DATE_GROUP_KEY = "__no_date__";

export type OccurrenceMonthGroup = {
  /** "2026-08" bzw. NO_DATE_GROUP_KEY. Stabiler React-/State-Key. */
  key: string;
  /** "August 2026" bzw. "Ohne Datum". */
  label: string;
  occurrences: Job[];
};

export type OccurrenceCounts = {
  total: number;
  upcoming: number;
  past: number;
  open: number;
  inProgress: number;
  completed: number;
};

export type OccurrenceAgenda = {
  /** Die nächsten N kommenden Termine — immer sichtbar, nie eingeklappt. */
  nextUp: Job[];
  /** Restliche kommende Termine nach Monat, aufsteigend. */
  upcomingGroups: OccurrenceMonthGroup[];
  /** Vergangene Termine nach Monat, neuester Monat zuerst. */
  pastGroups: OccurrenceMonthGroup[];
  counts: OccurrenceCounts;
  /**
   * Letztes generiertes Datum ("YYYY-MM-DD") über ALLE Termine — die Grenze
   * des erzeugten Zeitraums. null, wenn keine Termine mit Datum vorliegen.
   */
  horizonDate: string | null;
};

/** "YYYY-MM-DD" aus einem Termin (leer, wenn kein Datum gesetzt ist). */
function dateKeyOf(occurrence: Job): string {
  return occurrence.date?.slice(0, 10) ?? "";
}

/** "2026-08-14" → "2026-08". Leerer Key → NO_DATE_GROUP_KEY. */
function monthKeyOf(dateKey: string): string {
  return dateKey ? dateKey.slice(0, 7) : NO_DATE_GROUP_KEY;
}

/** "2026-08" → "August 2026". */
function monthLabelOf(monthKey: string): string {
  if (monthKey === NO_DATE_GROUP_KEY) return "Ohne Datum";
  const [year, month] = monthKey.split("-");
  const index = parseInt(month, 10) - 1;
  const name = MONTH_NAMES[index];
  if (!name || !year) return monthKey;
  return `${name} ${year}`;
}

/**
 * Gruppiert eine bereits sortierte Terminliste nach Monat und behält die
 * eingehende Reihenfolge innerhalb jeder Gruppe bei. Die Gruppen-Reihenfolge
 * ergibt sich ebenfalls aus der Eingabe (erstes Auftreten gewinnt) — die
 * Aufrufer übergeben bereits richtig sortierte Listen.
 */
function groupByMonth(occurrences: Job[]): OccurrenceMonthGroup[] {
  const groups: OccurrenceMonthGroup[] = [];
  const byKey = new Map<string, OccurrenceMonthGroup>();

  for (const occurrence of occurrences) {
    const key = monthKeyOf(dateKeyOf(occurrence));
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: monthLabelOf(key), occurrences: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.occurrences.push(occurrence);
  }

  return groups;
}

/**
 * Baut die Agenda-Struktur.
 *
 * @param occurrences Termine wie von getJobOccurrences geliefert
 *                    (aufsteigend nach date, dann start_time).
 * @param todayKey    Heutiger Kalendertag als "YYYY-MM-DD".
 * @param nextUpCount Anzahl der immer sichtbaren nächsten Termine.
 *
 * Termine OHNE Datum gelten — wie in der Vorgänger-Ansicht — als „kommend"
 * und landen in einer eigenen Gruppe „Ohne Datum" am Ende.
 */
export function buildOccurrenceAgenda(
  occurrences: Job[],
  todayKey: string,
  nextUpCount = 5,
): OccurrenceAgenda {
  const upcoming: Job[] = [];
  const past: Job[] = [];

  let open = 0;
  let inProgress = 0;
  let completed = 0;
  let horizonDate: string | null = null;

  for (const occurrence of occurrences) {
    const key = dateKeyOf(occurrence);

    // Heute zählt zu „kommend" — der Termin steht noch an.
    if (key && key < todayKey) past.push(occurrence);
    else upcoming.push(occurrence);

    if (key && (horizonDate === null || key > horizonDate)) {
      horizonDate = key;
    }

    if (occurrence.status === "open") open += 1;
    else if (occurrence.status === "in_progress") inProgress += 1;
    else if (occurrence.status === "completed") completed += 1;
  }

  // Vergangenes: neueste zuerst — relevanter als der allererste Termin.
  past.reverse();

  const nextUp = upcoming.slice(0, nextUpCount);
  const remainingUpcoming = upcoming.slice(nextUpCount);

  return {
    nextUp,
    upcomingGroups: groupByMonth(remainingUpcoming),
    pastGroups: groupByMonth(past),
    counts: {
      total: occurrences.length,
      upcoming: upcoming.length,
      past: past.length,
      open,
      inProgress,
      completed,
    },
    horizonDate,
  };
}
