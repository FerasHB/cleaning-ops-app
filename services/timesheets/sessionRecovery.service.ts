// services/timesheets/sessionRecovery.service.ts
// Client für die Admin-Sitzungswiederherstellung (Migration 20260922000000).
//
// DREI GETRENNTE QUELLEN, EINE ABRECHNUNGSWAHRHEIT:
//  • get_effective_work_sessions  — die EINZIGE Abrechnungsquelle. Liefert das
//    wirksame Intervall je Sitzung plus einen neutralen `reviewed`-Marker.
//    Mitarbeitende und Admins rufen exakt dieselbe RPC auf, damit beide Seiten
//    niemals unterschiedliche Summen berechnen können.
//  • get_work_recovery_queue      — firmenweite Admin-Warteschlange.
//  • get_session_correction_audit — NUR Anzeige-/Prüfdaten für Admins. Diese
//    Werte dürfen NIE in eine Minutenberechnung einfließen; sie werden erst
//    NACH der Abrechnung an die fertigen Zeilen gehängt.
//
// Der Grund einer Korrektur kann interne Notizen enthalten und verlässt die
// Admin-Grenze nicht: die RLS auf session_time_corrections und die Rollenprüfung
// in get_session_correction_audit erzwingen das serverseitig, der Client holt
// die Daten zusätzlich nur im Admin-Pfad.

import { supabase } from "@/lib/supabase";
import type { RecordedSession } from "@/services/timesheets/sessionAccounting";

/** Grund, warum eine Zuweisung in der Warteschlange steht (Server-Ableitung). */
export type RecoveryReasonCode =
  | "late_pause"
  | "late_complete"
  | "open_session_expired"
  | "paused_expired"
  | "review_required";

export type RecoveryQueueItem = {
  assignmentId: string;
  jobId: string;
  employeeId: string | null;
  employeeName: string;
  customerName: string;
  serviceName: string | null;
  jobStatus: string;
  employeeStartedAt: string | null;
  firstSessionStart: string | null;
  lastSessionEnd: string | null;
  openSessionId: string | null;
  openSessionStartedAt: string | null;
  /** Nur was der Mitarbeiter selbst erfasst hat. 0 = nichts erfasst. */
  recordedSeconds: number;
  effectiveSeconds: number;
  reviewRequired: boolean;
  reasonCode: RecoveryReasonCode;
  stuckSince: string | null;
};

/** Eine Korrektur aus der Prüfkette — reine Anzeige, nie Abrechnungsgrundlage. */
export type SessionCorrectionAudit = {
  correctionId: string;
  workSessionId: string;
  assignmentId: string;
  revisionNo: number;
  origin: "admin_reduced" | "admin_closed" | "admin_raised";
  rawStartedAt: string;
  rawEndedAt: string | null;
  rawDurationSeconds: number | null;
  effectiveEndedAt: string;
  effectiveDurationSeconds: number;
  /** NULL bei admin_closed: ohne erfasstes Ende gibt es keine Differenz. */
  deltaSeconds: number | null;
  reason: string;
  performedBy: string | null;
  performedByName: string;
  createdAt: string;
};

export type SessionCorrectionInput = {
  sessionId: string;
  /** Immer ausdrücklich gesetzt — nie aus den Zeitstempeln abgeleitet. */
  operation: "reduce" | "raise";
  effectiveEndedAt: string;
};

export type RecoveryResult = {
  assignmentId: string;
  assignmentState: string;
  workRevision: number;
  employeeStartedAt: string | null;
  employeeCompletedAt: string | null;
  recordedSeconds: number;
  effectiveSeconds: number;
  correctionSeconds: number;
  jobStatus: string;
};

const asNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : asNumber(value);

/**
 * DIE Abrechnungsquelle. Ersetzt jeden direkten work_sessions-Lesezugriff für
 * Arbeitszeit — sonst könnte eine Sicht das rohe, unkorrigierte Intervall als
 * Abrechnungszeit darstellen.
 */
export async function getEffectiveWorkSessions(
  assignmentIds: string[],
): Promise<(RecordedSession & { reviewed: boolean })[]> {
  if (assignmentIds.length === 0) return [];
  const { data, error } = await supabase.rpc("get_effective_work_sessions", {
    assignment_ids_input: assignmentIds,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.session_id),
    job_assignment_id: String(row.job_assignment_id),
    started_at: String(row.effective_started_at),
    ended_at: (row.effective_ended_at as string | null) ?? null,
    reviewed: Boolean(row.reviewed),
  }));
}

/** Firmenweite Warteschlange — nicht mitarbeiter- und nicht monatsgebunden. */
export async function getWorkRecoveryQueue(): Promise<RecoveryQueueItem[]> {
  const { data, error } = await supabase.rpc("get_work_recovery_queue");
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    assignmentId: String(row.assignment_id),
    jobId: String(row.job_id),
    employeeId: (row.employee_id as string | null) ?? null,
    employeeName: String(row.employee_name ?? ""),
    customerName: String(row.customer_name ?? ""),
    serviceName: (row.service_name as string | null) ?? null,
    jobStatus: String(row.job_status ?? ""),
    employeeStartedAt: (row.employee_started_at as string | null) ?? null,
    firstSessionStart: (row.first_session_start as string | null) ?? null,
    lastSessionEnd: (row.last_session_end as string | null) ?? null,
    openSessionId: (row.open_session_id as string | null) ?? null,
    openSessionStartedAt: (row.open_session_started_at as string | null) ?? null,
    recordedSeconds: asNumber(row.recorded_seconds),
    effectiveSeconds: asNumber(row.effective_seconds),
    reviewRequired: Boolean(row.review_required),
    reasonCode: (row.reason_code as RecoveryReasonCode) ?? "review_required",
    stuckSince: (row.stuck_since as string | null) ?? null,
  }));
}

/** NUR Admin-Anzeige. Niemals als Zahlenquelle für Arbeitsminuten verwenden. */
export async function getSessionCorrectionAudit(
  assignmentIds: string[],
): Promise<SessionCorrectionAudit[]> {
  if (assignmentIds.length === 0) return [];
  const { data, error } = await supabase.rpc("get_session_correction_audit", {
    assignment_ids_input: assignmentIds,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    correctionId: String(row.correction_id),
    workSessionId: String(row.work_session_id),
    assignmentId: String(row.job_assignment_id),
    revisionNo: asNumber(row.revision_no),
    origin: row.origin as SessionCorrectionAudit["origin"],
    rawStartedAt: String(row.raw_started_at),
    rawEndedAt: (row.raw_ended_at as string | null) ?? null,
    rawDurationSeconds: asNullableNumber(row.raw_duration_seconds),
    effectiveEndedAt: String(row.effective_ended_at),
    effectiveDurationSeconds: asNumber(row.effective_duration_seconds),
    deltaSeconds: asNullableNumber(row.delta_seconds),
    reason: String(row.reason ?? ""),
    performedBy: (row.performed_by as string | null) ?? null,
    performedByName: String(row.performed_by_name ?? ""),
    createdAt: String(row.created_at),
  }));
}

export async function reviewSessionAssignment(input: {
  recoveryId: string;
  assignmentId: string;
  expectedRevision: number;
  reason: string;
  corrections: SessionCorrectionInput[];
}): Promise<RecoveryResult> {
  const { data, error } = await supabase.rpc("admin_review_session_assignment", {
    recovery_id_input: input.recoveryId,
    assignment_id_input: input.assignmentId,
    expected_revision_input: input.expectedRevision,
    reason_input: input.reason,
    session_corrections_input: input.corrections.map((item) => ({
      session_id: item.sessionId,
      operation: item.operation,
      effective_ended_at: item.effectiveEndedAt,
    })),
  });
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    assignmentId: String(row.assignment_id),
    assignmentState: String(row.assignment_state),
    workRevision: asNumber(row.work_revision),
    employeeStartedAt: (row.employee_started_at as string | null) ?? null,
    employeeCompletedAt: (row.employee_completed_at as string | null) ?? null,
    recordedSeconds: asNumber(row.recorded_seconds),
    effectiveSeconds: asNumber(row.effective_seconds),
    correctionSeconds: asNumber(row.correction_seconds),
    jobStatus: String(row.job_status),
  };
}

/**
 * Abschnitte einer Zuweisung für die Admin-Prüfansicht: ROHWERT und WIRKSAMER
 * Wert nebeneinander.
 *
 * Der Rohwert kommt aus work_sessions (Admins lesen die eigene Firma per RLS),
 * der wirksame Wert aus get_effective_work_sessions. Beides ist hier reine
 * ANZEIGE — die Abrechnung läuft unverändert über get_effective_work_sessions
 * und accountSessionAssignment.
 */
export async function getReviewSessions(assignmentId: string): Promise<{
  id: string; startedAt: string; rawEndedAt: string | null; effectiveEndedAt: string | null;
}[]> {
  const [{ data: raw, error }, effective] = await Promise.all([
    supabase.from("work_sessions").select("id,started_at,ended_at")
      .eq("job_assignment_id", assignmentId).order("started_at", { ascending: true }),
    getEffectiveWorkSessions([assignmentId]),
  ]);
  if (error) throw error;
  const effectiveById = new Map(effective.map((item) => [item.id, item.ended_at]));
  return (raw ?? []).map((session) => ({
    id: session.id as string,
    startedAt: session.started_at as string,
    rawEndedAt: (session.ended_at as string | null) ?? null,
    effectiveEndedAt: effectiveById.get(session.id as string) ?? null,
  }));
}
