// utils/recurringRule.ts
// Reine, testbare Domänen-Logik rund um wiederkehrende Regeln (Daueraufträge)
// und ihre generierten Occurrences. KEINE React-/Supabase-Imports, damit die
// Funktionen isoliert (auch ohne UI-Test-Framework) geprüft werden können.
//
// Zwei Kernaufgaben:
//   1. isDetachedOccurrence – erkennt „abweichende Termine": Occurrences, die
//      nach einer Regeländerung (PR #43) mit Historie erhalten blieben, aber
//      nicht mehr zur aktuellen Regel passen. Spiegelt exakt das „passt nicht
//      mehr"-Kriterium der DB-Funktion update_job_occurrences wider.
//   2. deriveRuleHealth – leitet den Gesundheitszustand einer Parent-Regel ab
//      (gesund / inaktiv / keine Termine / Mitarbeiter inaktiv / abgeschlossen
//      / Zeitraum abgelaufen), damit defekte Regeln nicht still verborgen sind.

import type { Job } from "@/types/job";
import { getWeekdayKey } from "@/utils/recurrence";
import { normalizeTime } from "@/utils/date";

// "YYYY-MM-DD" → lokales Date (ohne Zeitzonen-Verschiebung).
function localDateFromKey(key: string): Date | null {
  const parts = key.slice(0, 10).split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// Die für den Abgleich relevanten Felder einer Parent-Regel.
export type RuleSchedule = Pick<
  Job,
  "recurringDays" | "startTime" | "recurrenceStartDate" | "recurrenceEndDate"
>;

/**
 * Ist diese Occurrence ein „abweichender Termin" gegenüber ihrer aktuellen
 * Parent-Regel? Nur sinnvoll für echte Occurrences (parentJobId gesetzt).
 *
 * Abweichend, wenn EINE Bedingung zutrifft:
 *   - Wochentag der Occurrence nicht (mehr) in recurringDays der Regel
 *   - Uhrzeit weicht von der Regel-Uhrzeit ab
 *   - Datum liegt außerhalb des Gültigkeitszeitraums der Regel
 *
 * Ohne bekannte Regel (rule undefined) → false (nicht als abweichend markieren,
 * lieber keine irreführende Kennzeichnung als eine falsche).
 */
export function isDetachedOccurrence(
  occ: Pick<Job, "parentJobId" | "date" | "startTime">,
  rule: RuleSchedule | undefined | null,
): boolean {
  if (!occ.parentJobId) return false; // kein generierter Termin
  if (!rule) return false; // Regel unbekannt → nicht markieren
  if (!occ.date) return false; // ohne Datum kein Wochentagsabgleich

  const occDate = localDateFromKey(occ.date);
  if (!occDate) return false;

  // Wochentag nicht mehr Teil der Regel?
  const dayKey = getWeekdayKey(occDate);
  const days = rule.recurringDays ?? [];
  if (days.length > 0 && !days.includes(dayKey)) return true;

  // Uhrzeit weicht ab? (auf "HH:mm" normalisieren, damit "08:00" == "08:00:00")
  const occTime = normalizeTime(occ.startTime);
  const ruleTime = normalizeTime(rule.startTime);
  if (occTime && ruleTime && occTime !== ruleTime) return true;

  // Außerhalb des Gültigkeitszeitraums?
  const dateKey = occ.date.slice(0, 10);
  if (rule.recurrenceEndDate && dateKey > rule.recurrenceEndDate) return true;
  if (rule.recurrenceStartDate && dateKey < rule.recurrenceStartDate) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────
// Regel-Gesundheit (Daueraufträge)
// ─────────────────────────────────────────────────────────────

export type RuleHealthState =
  | "healthy"
  | "inactive"
  | "horizon_expired"
  | "no_occurrences"
  | "inactive_employee"
  | "completed_rule";

export type RuleHealthSeverity = "ok" | "info" | "warning";

export type RuleHealth = {
  state: RuleHealthState;
  severity: RuleHealthSeverity;
  label: string;
  hint?: string;
};

// Zusammenfassung der Occurrences einer Regel (aus einer gebündelten Query).
export type RuleOccurrenceSummary = {
  hasOccurrences: boolean;
  nextOccurrenceDate: string | null; // "YYYY-MM-DD" oder null
};

/**
 * Leitet den Gesundheitszustand einer Parent-Regel ab.
 *
 * Prioritätsreihenfolge (erste passende gewinnt):
 *   1. completed_rule    – die Regel-Zeile selbst hat status='completed'
 *                          (inkonsistent; eine Regel wird nie „erledigt")
 *   2. inactive          – bewusst deaktiviert → keine Warnung, nur Info
 *   3. horizon_expired   – recurrence_end_date liegt in der Vergangenheit
 *   4. no_occurrences    – aktiv & nicht abgelaufen, aber KEINE Termine
 *                          generiert (der bekannte „defekte Regel"-Fall)
 *   5. inactive_employee – aktiv, aber zugewiesener Mitarbeiter ist inaktiv
 *   6. healthy           – alles in Ordnung
 */
export function deriveRuleHealth(
  rule: Pick<Job, "status" | "isActive" | "recurrenceEndDate" | "employeeId">,
  summary: RuleOccurrenceSummary,
  assigneeIsActive: boolean | null,
  today: string,
): RuleHealth {
  if (rule.status === "completed") {
    return {
      state: "completed_rule",
      severity: "warning",
      label: "Warnung",
      hint: "Regel-Status ist »erledigt« — bitte prüfen.",
    };
  }

  if (rule.isActive === false) {
    return { state: "inactive", severity: "info", label: "Inaktiv" };
  }

  if (rule.recurrenceEndDate && rule.recurrenceEndDate < today) {
    return {
      state: "horizon_expired",
      severity: "info",
      label: "Zeitraum abgelaufen",
      hint: "Das Enddatum der Regel liegt in der Vergangenheit.",
    };
  }

  if (!summary.hasOccurrences) {
    return {
      state: "no_occurrences",
      severity: "warning",
      label: "Keine Termine generiert",
      hint: "Für diese Regel wurden keine Termine erzeugt.",
    };
  }

  if (rule.employeeId && assigneeIsActive === false) {
    return {
      state: "inactive_employee",
      severity: "warning",
      label: "Mitarbeiter inaktiv",
      hint: "Der zugewiesene Mitarbeiter ist deaktiviert.",
    };
  }

  return { state: "healthy", severity: "ok", label: "Aktiv" };
}
