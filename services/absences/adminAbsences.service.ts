// services/absences/adminAbsences.service.ts
// Admin-Operationen für Urlaub/Krankheit (Phase C — Admin Absence Workflow).
//
// LESEN: normale SELECTs auf employee_absences. RLS ("admin read company
// absences", siehe supabase/migrations/20260816000000_absences_foundation.sql)
// beschränkt das bereits auf die eigene Firma — kein RPC nötig, gleiches
// Muster wie getJobs()/getEmployees() in services/jobs/jobs.service.ts.
//
// SCHREIBEN: ausschließlich über die zwei Admin-RPCs aus derselben Migration
// (admin_review_vacation, admin_create_absence). Es gibt bewusst KEINE
// INSERT/UPDATE/DELETE-Policy auf der Tabelle — jeder direkte Schreibversuch
// von hier aus würde ohnehin an RLS scheitern.
//
// Employee-Selbstbedienung bleibt in absences.service.ts (siehe dessen
// Kopfkommentar) — diese Datei importiert von dort nur die geteilte
// Zeilenform/das Mapping, dupliziert sie nicht.

import { supabase } from "@/lib/supabase";
import {
  ABSENCE_SELECT,
  ACTIVE_ABSENCE_FILTER_OR,
  mapAbsence,
  type AbsenceRow,
} from "@/services/absences/absences.service";
import {
  Absence,
  AbsenceStatus,
  AbsenceType,
} from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";
import { i18next } from "@/i18n";

export type AdminCreateAbsenceInput = {
  employeeId: string;
  type: AbsenceType;
  /** "YYYY-MM-DD" */
  startDate: string;
  /** "YYYY-MM-DD", nur bei Urlaub Pflicht */
  endDate?: string | null;
  note?: string;
};

// Sicherheitsdeckel für ungefilterte/weit gefasste Listen — gleiche Rolle wie
// OCCURRENCE_LIMIT in AdminJobsCalendarScreen: kein erwarteter Regelfall,
// verhindert nur eine stillschweigend unvollständige, unbegrenzte Abfrage.
const COMPANY_ABSENCES_LIMIT = 200;
const PENDING_REQUESTS_LIMIT = 100;

// Bekannte englische RPC-Ablehnungen der Admin-RPCs → deutsche Nutzer-
// Meldung. Reihenfolge spezifisch → grob, gleiche Bauform wie
// services/absences/absences.service.ts (translateRpcError).
function adminRpcMessageMap(): { match: string; key: string }[] {
  return [
    {
      match: "Only admins can review vacation requests",
      key: "admin:absenceAdmin.rpcErrors.onlyAdminsReview",
    },
    {
      match: "Only admins can manually record an absence",
      key: "admin:absenceAdmin.rpcErrors.onlyAdminsCreate",
    },
    {
      match: "Vacation request not found, not in your company, or already reviewed",
      key: "admin:absenceAdmin.rpcErrors.requestNotFound",
    },
    {
      match: "Employee not found in your company",
      key: "admin:absenceAdmin.rpcErrors.employeeNotFound",
    },
    {
      match: "start_date is required",
      key: "admin:absenceAdmin.create.startDateRequiredError",
    },
    {
      match: "end_date is required for vacation",
      key: "admin:absenceAdmin.create.endDateRequiredError",
    },
    {
      match: "end_date must not be before start_date",
      key: "admin:absenceAdmin.create.endBeforeStartError",
    },
    {
      match: "Overlaps an existing vacation request",
      key: "admin:absenceAdmin.rpcErrors.overlapsVacation",
    },
    {
      match: "Overlaps an existing active sickness report",
      key: "admin:absenceAdmin.rpcErrors.overlapsSickness",
    },
    { match: "decision must be", key: "admin:absenceAdmin.rpcErrors.invalidDecision" },
  ];
}

function translateAdminRpcError(err: unknown, fallback: string): string {
  const raw =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : "";

  const hit = adminRpcMessageMap().find((entry) => raw.includes(entry.match));
  if (hit) return i18next.t(hit.key);

  return toUserMessage(err, fallback);
}

function firstRow(data: AbsenceRow[] | null): Absence {
  const row = data?.[0];
  if (!row) {
    throw new Error(i18next.t("admin:absenceAdmin.loadErrors.loadAbsenceFailed"));
  }
  return mapAbsence(row);
}

/**
 * Firmenweite Abwesenheiten, optional nach Zeitraum/Typ/Status gefiltert.
 * RLS beschränkt bereits auf die eigene Firma. Für unbegrenzte Aufrufe gilt
 * ein Sicherheitsdeckel (COMPANY_ABSENCES_LIMIT) — kein Regelfall in der
 * Firmengröße dieser App, aber verhindert eine stillschweigend unvollständige
 * Liste bei sehr vielen historischen Einträgen.
 */
export async function getCompanyAbsences(params?: {
  /** "YYYY-MM-DD", inklusive — Zeilen mit start_date >= from */
  from?: string;
  /** "YYYY-MM-DD", inklusive — Zeilen mit start_date <= to */
  to?: string;
  type?: AbsenceType;
  status?: AbsenceStatus[];
  limit?: number;
}): Promise<Absence[]> {
  let query = supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .order("start_date", { ascending: false })
    .limit(params?.limit ?? COMPANY_ABSENCES_LIMIT);

  if (params?.from) query = query.gte("start_date", params.from);
  if (params?.to) query = query.lte("start_date", params.to);
  if (params?.type) query = query.eq("type", params.type);
  if (params?.status?.length) query = query.in("status", params.status);

  const { data, error } = await query;
  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadAbsencesFailed")),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/**
 * Firmenweite Abwesenheiten mit ECHTER Zeitraum-Überschneidung zu [from, to]
 * (Phase D, Admin-Kalender) — bewusst additiv neben getCompanyAbsences()
 * statt dessen from/to zu verändern (bestehende Aufrufer bleiben unberührt).
 *
 * WARUM NICHT getCompanyAbsences({from, to}) WIEDERVERWENDEN:
 * dessen from/to filtert NUR start_date (Zeilen mit start_date >= from UND
 * <= to). Ein Urlaub, der VOR dem sichtbaren Monat begann und noch andauert,
 * würde damit für die Kalenderansicht fälschlich unsichtbar. Das korrekte
 * Überschneidungs-Prädikat (identisch zu getCurrentCompanyAbsences(), nur
 * über einen Zeitraum statt einen einzelnen Tag):
 *   start_date <= to AND (end_date IS NULL OR end_date >= from)
 */
export async function getCompanyAbsencesInRange(params: {
  /** "YYYY-MM-DD", inklusive */
  from: string;
  /** "YYYY-MM-DD", inklusive */
  to: string;
  /** true = nur genehmigter Urlaub / gemeldete Krankheit (siehe ACTIVE_ABSENCE_FILTER_OR). */
  activeOnly?: boolean;
  limit?: number;
}): Promise<Absence[]> {
  let query = supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .lte("start_date", params.to)
    .or(`end_date.is.null,end_date.gte.${params.from}`)
    .order("start_date", { ascending: true })
    .limit(params.limit ?? COMPANY_ABSENCES_LIMIT);

  if (params.activeOnly) {
    query = query.or(ACTIVE_ABSENCE_FILTER_OR);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadAbsencesFailed")),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/** Abwesenheitshistorie eines einzelnen Mitarbeiters, neueste zuerst. */
export async function getEmployeeAbsences(
  employeeId: string,
  limit = 10,
): Promise<Absence[]> {
  const { data, error } = await supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .eq("employee_id", employeeId)
    .order("start_date", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadAbsencesFailed")),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/** Reine Zählung offener Urlaubsanträge — für den Dashboard-Chip, ohne Zeilen zu laden. */
export async function getPendingVacationCount(): Promise<number> {
  const { count, error } = await supabase
    .from("employee_absences")
    .select("id", { count: "exact", head: true })
    .eq("type", "vacation")
    .eq("status", "requested");

  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadPendingCountFailed")),
    );
  }
  return count ?? 0;
}

/** Offene Urlaubsanträge, älteste zuerst (FIFO-Warteschlange für die Review-Liste). */
export async function getPendingVacationRequests(): Promise<Absence[]> {
  const { data, error } = await supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .eq("type", "vacation")
    .eq("status", "requested")
    .order("created_at", { ascending: true })
    .limit(PENDING_REQUESTS_LIMIT);

  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadPendingRequestsFailed")),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/**
 * Firmenweite Krankmeldungen, neueste zuerst — für den "Krankmeldungen"-
 * Reiter. Zeigt reported (aktiv) UND cancelled (kürzlich storniert) nicht
 * automatisch aus; der Aufrufer filtert nach Bedarf serverseitig über
 * `status`. Ohne status-Filter: alle Krankheits-Zeilen (begrenzt).
 */
export async function getSicknessReports(params?: {
  status?: AbsenceStatus[];
  limit?: number;
}): Promise<Absence[]> {
  let query = supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .eq("type", "sickness")
    .order("start_date", { ascending: false })
    .limit(params?.limit ?? COMPANY_ABSENCES_LIMIT);

  if (params?.status?.length) query = query.in("status", params.status);

  const { data, error } = await query;
  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadSicknessFailed")),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/**
 * Aktive Abwesenheiten der Firma an einem bestimmten Tag (Standard: heute).
 * NUR genehmigter Urlaub und gemeldete Krankheit zählen als "aktive
 * Abwesenheit" — eine angefragte (requested) Abwesenheit macht niemanden
 * "abwesend" (siehe Architektur-Audit Phase C, Abschnitt 3B). Eine Abfrage
 * für die gesamte Firma, kein Loop pro Mitarbeiter — der Aufrufer joint
 * client-seitig gegen die bereits geladene Mitarbeiterliste, exakt wie
 * AdminDashboardScreen es heute für `activeJob` tut.
 */
export async function getCurrentCompanyAbsences(
  dateIso: string,
): Promise<Absence[]> {
  const { data, error } = await supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .or("and(type.eq.vacation,status.eq.approved),and(type.eq.sickness,status.eq.reported)")
    .lte("start_date", dateIso)
    .or(`end_date.is.null,end_date.gte.${dateIso}`);

  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.loadErrors.loadAbsencesFailed")),
    );
  }
  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/** Admin genehmigt/lehnt eine Urlaubsanfrage der eigenen Firma ab. */
/**
 * Urlaub genehmigen/ablehnen.
 *
 * `deductions` ist die vom Admin BESTÄTIGTE Abzugsmenge je Kalenderjahr
 * (z. B. `{ "2026": 3 }`, bei Jahresübergang `{ "2026": 2, "2027": 3 }`).
 * Sie wird NICHT berechnet: aus Referenz-Arbeitstagen/Woche lässt sich nicht
 * ableiten, welche konkreten Tage Anspruch verbrauchen, und die Einsatzplanung
 * ist nachträglich änderbar (siehe Migration 20260824000000).
 *
 * Pflicht, sobald für den Mitarbeiter ein Urlaubskonto geführt wird — die RPC
 * lehnt eine Genehmigung ohne bestätigten Abzug ab. Ohne Urlaubskonto bleibt
 * der Ablauf unverändert und der Wert wird ignoriert.
 */
export async function reviewVacation(
  absenceId: string,
  decision: "approved" | "rejected",
  adminNote?: string,
  deductions?: Record<string, number> | null,
): Promise<Absence> {
  const { data, error } = await supabase.rpc("admin_review_vacation", {
    absence_id_input: absenceId,
    decision_input: decision,
    admin_note_input: adminNote?.trim() || null,
    p_deductions: deductions ?? null,
  });

  if (error) {
    throw new Error(
      translateAdminRpcError(
        error,
        decision === "approved"
          ? i18next.t("admin:absenceAdmin.loadErrors.approveFailed")
          : i18next.t("admin:absenceAdmin.loadErrors.rejectFailed"),
      ),
    );
  }
  return firstRow(data as AbsenceRow[] | null);
}

/**
 * Admin erfasst eine Abwesenheit manuell für einen Mitarbeiter der eigenen
 * Firma. Urlaub landet direkt bei status=approved, Krankheit bei
 * status=reported — beides serverseitig, kein clientseitig erfundener
 * Zwischenzustand.
 */
export async function adminCreateAbsence(
  input: AdminCreateAbsenceInput,
): Promise<Absence> {
  const { data, error } = await supabase.rpc("admin_create_absence", {
    employee_id_input: input.employeeId,
    type_input: input.type,
    start_date_input: input.startDate,
    end_date_input: input.endDate ?? null,
    note_input: input.note?.trim() || null,
  });

  if (error) {
    throw new Error(
      translateAdminRpcError(error, i18next.t("admin:absenceAdmin.create.createFailedFallback")),
    );
  }
  return firstRow(data as AbsenceRow[] | null);
}
