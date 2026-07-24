// utils/recurringRuleFilter.ts
// Reine, testbare Such-/Filter-Logik für die Daueraufträge-Verwaltung
// (AdminRecurringRulesScreen). KEINE React-/Supabase-Imports.
//
// Daueraufträge ist eine Verwaltungsansicht, kein operativer Zeitplan: die
// Regel-Liste ist pro Firma klein (wenige Dutzend Zeilen, bereits durch
// getRecurringRules() serverseitig auf `job_type='recurring' AND
// parent_job_id IS NULL` begrenzt). Suche UND Filter laufen daher bewusst
// clientseitig auf diesem bereits kleinen, gebundenen Ergebnis — es wird nie
// zusätzlich nachgeladen.
//
// Architektur für künftige Filter (Service/Objekt/Kunde/Region/Tags):
// RuleFilters ist ein flaches Objekt, matchesRuleFilters() prüft jedes Feld
// unabhängig (frühes return false). Ein neuer Filter bedeutet: ein neues Feld
// im Typ + eine neue Bedingung in matchesRuleFilters() + einen neuen Eintrag
// in ruleFilterSummaryParts() — keine bestehende Logik muss sich ändern.

import type { Job } from "@/types/job";
import type { WeekdayKey } from "@/utils/recurrence";
import { WEEKDAYS } from "@/utils/recurrence";

export type RuleStatusFilter = "all" | "active" | "inactive";

// Wiederverwendet dieselbe Auswahl-Semantik wie der Zeitplan-Mitarbeiter-
// Filter (EmployeeFilterControl): "all" | "unassigned" | <Mitarbeiter-ID>.
export type RuleEmployeeFilter = "all" | "unassigned" | string;

export type RuleFilters = {
  status: RuleStatusFilter;
  employee: RuleEmployeeFilter;
  /** Leeres Array = kein Wochentags-Filter. Mehrfachauswahl = ODER. */
  weekdays: WeekdayKey[];
};

export const DEFAULT_RULE_FILTERS: RuleFilters = {
  status: "all",
  employee: "all",
  weekdays: [],
};

/** Ist irgendein Filter (nicht die Suche) von der Standardeinstellung abgewichen? */
export function isRuleFiltersActive(filters: RuleFilters): boolean {
  return (
    filters.status !== "all" ||
    filters.employee !== "all" ||
    filters.weekdays.length > 0
  );
}

/**
 * Freitext-Suche über eine Regel (Objekt/Kunde, Service, Adresse).
 * ODER-Semantik, groß-/kleinschreibungsunabhängig, leer = kein Filter.
 * Bewusst kein Mitarbeitername hier (der lebt im strukturierten Employee-
 * Filter, nicht in der Freitextsuche — anders als im Zeitplan, wo es nur
 * einen Suchkanal gibt).
 */
export function matchesRuleSearch(
  rule: Pick<Job, "customerName" | "service" | "location">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [rule.customerName, rule.service, rule.location]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

/**
 * Strukturierte Filter (Status UND Mitarbeiter UND Wochentage).
 * Jede Bedingung ist unabhängig prüfbar — siehe Architektur-Hinweis oben.
 */
export function matchesRuleFilters(
  rule: Pick<Job, "isActive" | "employeeId" | "recurringDays">,
  filters: RuleFilters,
): boolean {
  if (filters.status === "active" && rule.isActive === false) return false;
  if (filters.status === "inactive" && rule.isActive !== false) return false;

  if (filters.employee === "unassigned" && rule.employeeId) return false;
  if (
    filters.employee !== "all" &&
    filters.employee !== "unassigned" &&
    rule.employeeId !== filters.employee
  ) {
    return false;
  }

  if (filters.weekdays.length > 0) {
    const days = rule.recurringDays ?? [];
    const overlaps = filters.weekdays.some((d) => days.includes(d));
    if (!overlaps) return false;
  }

  return true;
}

/** Kombiniert Suche UND Filter (alle Bedingungen müssen zutreffen). */
export function matchesRuleSearchAndFilters(
  rule: Pick<
    Job,
    "customerName" | "service" | "location" | "isActive" | "employeeId" | "recurringDays"
  >,
  query: string,
  filters: RuleFilters,
): boolean {
  return matchesRuleSearch(rule, query) && matchesRuleFilters(rule, filters);
}

/**
 * Lesbare Teile für den kompakten Zusammenfassungs-Chip, z. B.
 * ["Aktiv", "Lena Brandt", "Mo Mi Fr"]. Leer, wenn kein Filter aktiv ist —
 * der Aufrufer entscheidet, ob/wie er das gemeinsam mit der Suche anzeigt.
 */
export function ruleFilterSummaryParts(
  filters: RuleFilters,
  employeeLabel: string,
): string[] {
  const parts: string[] = [];

  if (filters.status === "active") parts.push("Aktiv");
  if (filters.status === "inactive") parts.push("Inaktiv");

  if (filters.employee !== "all") parts.push(employeeLabel);

  if (filters.weekdays.length > 0) {
    const short = WEEKDAYS.filter((w) => filters.weekdays.includes(w.key)).map(
      (w) => w.short,
    );
    parts.push(short.join(" "));
  }

  return parts;
}
