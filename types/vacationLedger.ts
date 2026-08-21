// types/vacationLedger.ts
// ─────────────────────────────────────────────────────────────────
// Urlaubskonto-Buchhaltung. Der Saldo ist NIE ein gespeicherter Wert,
// sondern immer die Summe der Buchungszeilen — damit ist jede Zahl im UI
// zeilenweise belegbar ("warum 28,5?").
// ─────────────────────────────────────────────────────────────────

export type VacationLedgerEntryType =
  | "annual_entitlement"
  | "approved_vacation"
  | "vacation_cancellation"
  | "manual_adjustment"
  /** RESERVIERT — keine Logik in diesem Stand. */
  | "carry_over"
  /** RESERVIERT — keine Logik in diesem Stand (keine Rückgabe bei Krankheit). */
  | "au_restoration";

export const LEDGER_ENTRY_LABELS: Record<VacationLedgerEntryType, string> = {
  annual_entitlement: "Jahresanspruch",
  approved_vacation: "Genehmigter Urlaub",
  vacation_cancellation: "Storno",
  manual_adjustment: "Manuelle Korrektur",
  carry_over: "Übertrag",
  au_restoration: "Gutschrift (AU)",
};

export type VacationLedgerEntry = {
  id: string;
  entryType: VacationLedgerEntryType;
  /** Vorzeichenbehaftet: Anspruch positiv, Abzug negativ. */
  amountDays: number;
  absenceId: string | null;
  createdBy: string | null;
  note: string | null;
  createdAt: string;
};

export type VacationYear = {
  id: string;
  employeeId: string;
  year: number;
};

/**
 * Aufgeschlüsselter Saldo eines Urlaubsjahres.
 *
 * `pendingRequests` trägt bewusst NUR die Zeiträume, keine Tagessumme:
 * wie viele Tage ein offener Antrag verbrauchen wird, steht erst fest, wenn
 * der Admin den Abzug bei der Genehmigung bestätigt (siehe Migration
 * 20260824000000). Eine geschätzte Zahl hier wäre erfunden.
 */
export type VacationBalance = {
  year: number;
  annualEntitlement: number;
  carryOver: number;
  usedDays: number;
  adjustments: number;
  remaining: number;
  entries: VacationLedgerEntry[];
};

export type PendingVacationRequest = {
  absenceId: string;
  startDate: string;
  endDate: string;
};

/** Zustand des Kontos für die Anzeige. */
export type VacationAccountState =
  | { status: "disabled" }
  | { status: "not_initialized"; year: number }
  | { status: "ready"; balance: VacationBalance };
