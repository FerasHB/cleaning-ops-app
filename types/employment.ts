// types/employment.ts
// ─────────────────────────────────────────────────────────────────
// Beschäftigungs- und Urlaubs-KONFIGURATION eines Mitarbeiters.
//
// WICHTIG — dieser Typ trägt bewusst KEINEN Saldo: kein verbrauchter, kein
// verbleibender Urlaub, kein Übertrag. Das ist reine Konfiguration. Die
// Verbrauchsrechnung (Ledger) kommt im nächsten Arbeitspaket; sie hier
// vorwegzunehmen würde eine Zahl erzeugen, die niemand pflegt.
// ─────────────────────────────────────────────────────────────────

/**
 * Beschäftigungsart — REIN BESCHREIBEND.
 *
 * Aus diesem Wert wird NIE ein Urlaubsanspruch abgeleitet. Minijob und
 * Aushilfe haben gesetzlichen Urlaubsanspruch; eine automatische Zuordnung
 * „Minijob = 0 Tage" wäre fachlich falsch. Beschäftigungsart und
 * Urlaubsverwaltung sind zwei unabhängige Schalter.
 */
export type EmploymentType =
  | "vollzeit"
  | "teilzeit"
  | "minijob"
  | "aushilfe"
  | "sonstiges";

export const EMPLOYMENT_TYPES: EmploymentType[] = [
  "vollzeit",
  "teilzeit",
  "minijob",
  "aushilfe",
  "sonstiges",
];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  vollzeit: "Vollzeit",
  teilzeit: "Teilzeit",
  minijob: "Minijob",
  aushilfe: "Aushilfe",
  sonstiges: "Sonstiges",
};

/** Konfiguration, wie sie am Mitarbeiter gespeichert ist (Overrides = null-fähig). */
export type EmploymentConfig = {
  employmentType: EmploymentType | null;
  employmentStartDate: string | null; // "YYYY-MM-DD"
  employmentEndDate: string | null; // "YYYY-MM-DD"
  vacationManagementEnabled: boolean;
  /** null = Firmen-Default gilt. */
  vacationAnnualEntitlementDays: number | null;
  /** null = Firmen-Default gilt. */
  vacationReferenceDaysPerWeek: number | null;
};

/** Firmenweite Vorgabewerte. */
export type CompanyVacationDefaults = {
  defaultAnnualEntitlementDays: number | null;
  defaultReferenceDaysPerWeek: number | null;
  defaultVacationManagementEnabled: boolean;
};

/** Woher ein effektiver Wert stammt — die UI zeigt das explizit an. */
export type ConfigSource = "employee" | "company";

export type ResolvedValue = {
  value: number;
  source: ConfigSource;
};

/**
 * Ergebnis der Auflösung. Drei klar getrennte Zustände statt stiller
 * Ersatzwerte:
 *
 *  - `disabled`    → Urlaubskonto ist für diesen Mitarbeiter nicht aktiv.
 *                    Die UI zeigt dann KEINE Zahl (insbesondere kein „0 Tage",
 *                    das fälschlich wie „kein Anspruch" gelesen würde).
 *  - `incomplete`  → aktiv, aber es fehlt mindestens ein Pflichtwert (weder
 *                    Override noch Firmen-Default gesetzt). Bewusst ein
 *                    eigener Zustand: einen Default zu erfinden würde einen
 *                    Konfigurationsfehler verstecken.
 *  - `configured`  → aktiv und vollständig.
 */
export type EffectiveVacationConfig =
  | { status: "disabled" }
  | { status: "incomplete"; missing: ("entitlement" | "referenceDays")[] }
  | {
      status: "configured";
      annualEntitlementDays: ResolvedValue;
      referenceDaysPerWeek: ResolvedValue;
    };
