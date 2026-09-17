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
import { isAssignedTo, isUnassigned } from "@/utils/jobAssignees";
import type { WeekdayKey } from "@/utils/recurrence";
import { i18next, INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";

// Wochentag-Kurzcodes in DB-/Wochenreihenfolge (Montag zuerst). Eigenständig
// statt WEEKDAYS aus utils/recurrence.ts (deutsche Labels, breit in
// Admin-Formularen verankert) — dieselbe Lösung wie in components/JobCard.tsx.
const WEEKDAY_ORDER: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const REFERENCE_MONDAY = new Date(2024, 0, 1); // 1. Januar 2024 ist ein Montag

export function localizedWeekdayShort(key: WeekdayKey): string {
  const localeTag = INTL_LOCALE_TAGS[i18next.language as AppLocale] ?? "de-DE";
  const dayIndex = WEEKDAY_ORDER.indexOf(key);
  const d = new Date(REFERENCE_MONDAY);
  d.setDate(d.getDate() + dayIndex);
  return new Intl.DateTimeFormat(localeTag, { weekday: "short" }).format(d);
}

/**
 * Wie `formatRecurringDays` (utils/recurrence.ts), aber sprachabhängig statt
 * fest Deutsch — für Admin-Oberflächen, die die Regel-Wochentage als
 * Kurztext zeigen (z. B. AdminRecurringRulesScreen-Listenkarte).
 */
export function formatRecurringDaysLocalized(
  days: string[] | null | undefined,
): string {
  if (!days || days.length === 0) return "—";
  const set = new Set(days);
  return WEEKDAY_ORDER.filter((key) => set.has(key))
    .map(localizedWeekdayShort)
    .join(", ");
}

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
  rule: Pick<Job, "isActive" | "assignees" | "recurringDays">,
  filters: RuleFilters,
): boolean {
  if (filters.status === "active" && rule.isActive === false) return false;
  if (filters.status === "inactive" && rule.isActive !== false) return false;

  // Zuweisungsmenge statt Legacy-Primär: „Nicht zugewiesen" heißt jetzt
  // wirklich „keine einzige Zuweisung" (der Legacy-Zeiger kann auch dann
  // NULL sein, wenn Zuweisungen existieren — siehe compat_primary_assignee).
  if (filters.employee === "unassigned" && !isUnassigned(rule)) return false;
  if (
    filters.employee !== "all" &&
    filters.employee !== "unassigned" &&
    !isAssignedTo(rule, filters.employee)
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
    "customerName" | "service" | "location" | "isActive" | "assignees" | "recurringDays"
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

  if (filters.status === "active") parts.push(i18next.t("admin:recurringRules.badgeActive"));
  if (filters.status === "inactive") parts.push(i18next.t("admin:recurringRules.badgeInactive"));

  if (filters.employee !== "all") parts.push(employeeLabel);

  if (filters.weekdays.length > 0) {
    const short = WEEKDAY_ORDER.filter((key) => filters.weekdays.includes(key)).map(
      localizedWeekdayShort,
    );
    parts.push(short.join(" "));
  }

  return parts;
}
