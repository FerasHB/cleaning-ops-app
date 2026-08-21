// utils/vacationBalance.ts
// ─────────────────────────────────────────────────────────────────
// Aggregation der Urlaubs-Buchungszeilen zu einem erklärbaren Saldo.
//
// Reine Funktion ohne Supabase — gleiche Bauform wie utils/vacationConfig.ts
// und utils/resolveEffectiveAbsenceDays.ts.
//
// GRUNDREGEL: Resturlaub = SUMME aller Zeilen. Es gibt keinen zweiten,
// gespeicherten Saldo, der davon abweichen könnte. Die Einzelposten unten
// sind nur eine Gruppierung derselben Zeilen für die Anzeige — deshalb
// stimmt die Aufstellung per Konstruktion immer mit dem Ergebnis überein.
//
// NICHT Teil dieser Datei: geplante Minuten, Ist-Zeiten, Timesheet. Die
// Einheit des Urlaubskontos ist TAGE (siehe types/vacationLedger.ts).
// ─────────────────────────────────────────────────────────────────

import type {
  VacationBalance,
  VacationLedgerEntry,
} from "@/types/vacationLedger";

function sumOf(
  entries: VacationLedgerEntry[],
  types: VacationLedgerEntry["entryType"][],
): number {
  return entries
    .filter((entry) => types.includes(entry.entryType))
    .reduce((total, entry) => total + entry.amountDays, 0);
}

// Gleitkomma-Summen können 27.999999999 erzeugen. Urlaub wird in halben
// Tagen geführt, zwei Nachkommastellen sind daher verlustfrei.
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildVacationBalance(
  year: number,
  entries: VacationLedgerEntry[],
): VacationBalance {
  // "Verbraucht" ist der NETTO-Verbrauch: ein stornierter Urlaub hebt seinen
  // eigenen Abzug wieder auf. Beide Zeilen bleiben im Verlauf sichtbar —
  // nur die Kennzahl fasst sie zusammen, damit "Verbraucht" nicht dauerhaft
  // Urlaub ausweist, der nie genommen wurde.
  const used = -sumOf(entries, ["approved_vacation", "vacation_cancellation"]);

  return {
    year,
    annualEntitlement: round(sumOf(entries, ["annual_entitlement"])),
    carryOver: round(sumOf(entries, ["carry_over"])),
    usedDays: round(used),
    // au_restoration zählt als Korrektur mit — es existiert in diesem Stand
    // keine Logik, die solche Zeilen erzeugt (reserviert für bestätigte AU).
    adjustments: round(sumOf(entries, ["manual_adjustment", "au_restoration"])),
    remaining: round(entries.reduce((total, entry) => total + entry.amountDays, 0)),
    entries: [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/** Anzeigeform eines Betrags: "+30,0" / "−3,0". */
export function formatLedgerAmount(amountDays: number): string {
  const sign = amountDays < 0 ? "−" : "+";
  const value = Math.abs(amountDays).toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
  return `${sign}${value}`;
}

/**
 * Anzeigeform einer Kennzahl (ohne erzwungenes Vorzeichen): "28,5".
 *
 * `+ 0` normalisiert eine negative Null (-0) auf +0, BEVOR toLocaleString sie
 * sieht — sonst zeigt z. B. ein exakt ausgeglichenes "Verbraucht" (Abzug und
 * Storno heben sich auf, buildVacationBalance liefert -0) fälschlich "-0,0"
 * an. In JS gilt -0 + 0 === 0 (Object.is(-0 + 0, 0) → true), das ist reine
 * Zahlendarstellung und ändert keinen echten negativen Wert.
 */
export function formatDays(amountDays: number): string {
  return (amountDays + 0).toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
}

/**
 * Kalenderjahre, die ein Urlaubszeitraum berührt.
 *
 * Grundlage für die Abzugs-Bestätigung: erstreckt sich ein Urlaub über den
 * Jahreswechsel, muss der Admin für JEDES Jahr eine Menge bestätigen — es
 * ist bewusst unmöglich, versehentlich alles ins Startjahr zu buchen.
 */
export function yearsInRange(startDate: string, endDate: string): number[] {
  const start = parseInt(startDate.slice(0, 4), 10);
  const end = parseInt(endDate.slice(0, 4), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const years: number[] = [];
  for (let year = start; year <= end; year++) years.push(year);
  return years;
}
