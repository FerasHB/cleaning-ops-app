// utils/vacationConfig.ts
// ─────────────────────────────────────────────────────────────────
// Auflösung der EFFEKTIVEN Urlaubs-Konfiguration eines Mitarbeiters.
//
// Reine Funktion, kein Supabase-Zugriff — gleiche Bauform wie
// utils/jobSchedule.ts und utils/resolveEffectiveAbsenceDays.ts, damit die
// Regel ohne Netzwerk nachvollziehbar und testbar bleibt.
//
// ABSICHTLICH NICHT HIER: verbrauchter Urlaub, Resturlaub, Übertrag,
// Anteilsberechnung. Diese Datei beantwortet ausschließlich „welche
// Konfiguration gilt für diesen Mitarbeiter?" — nicht „wie viel hat er noch?".
// Die Verbrauchsrechnung folgt im Ledger-Arbeitspaket.
// ─────────────────────────────────────────────────────────────────

import type {
  CompanyVacationDefaults,
  EffectiveVacationConfig,
  EmploymentConfig,
  ResolvedValue,
} from "@/types/employment";

// Override gewinnt, sonst Firmen-Default, sonst „fehlt". Bewusst KEIN
// erfundener Ersatzwert: ein stiller Default würde einen echten
// Konfigurationsfehler unsichtbar machen.
function resolve(
  override: number | null,
  companyDefault: number | null,
): ResolvedValue | null {
  if (override !== null) return { value: override, source: "employee" };
  if (companyDefault !== null) return { value: companyDefault, source: "company" };
  return null;
}

/**
 * Ermittelt die geltende Urlaubs-Konfiguration.
 *
 * Die Beschäftigungsart wird hier BEWUSST nicht gelesen — sie darf den
 * Anspruch nicht beeinflussen (siehe types/employment.ts).
 */
export function resolveEffectiveVacationConfig(
  employee: EmploymentConfig,
  companyDefaults: CompanyVacationDefaults,
): EffectiveVacationConfig {
  if (!employee.vacationManagementEnabled) {
    return { status: "disabled" };
  }

  const entitlement = resolve(
    employee.vacationAnnualEntitlementDays,
    companyDefaults.defaultAnnualEntitlementDays,
  );
  const referenceDays = resolve(
    employee.vacationReferenceDaysPerWeek,
    companyDefaults.defaultReferenceDaysPerWeek,
  );

  const missing: ("entitlement" | "referenceDays")[] = [];
  if (!entitlement) missing.push("entitlement");
  if (!referenceDays) missing.push("referenceDays");

  if (missing.length > 0) {
    return { status: "incomplete", missing };
  }

  return {
    status: "configured",
    annualEntitlementDays: entitlement!,
    referenceDaysPerWeek: referenceDays!,
  };
}

/** Kurzlabel für die Herkunft eines Wertes (Admin-UI). */
export function describeSource(source: ResolvedValue["source"]): string {
  return source === "employee" ? "individuell" : "Firmen-Standard";
}
