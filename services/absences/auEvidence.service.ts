// services/absences/auEvidence.service.ts
// ─────────────────────────────────────────────────────────────────
// AU-Bestätigung und Urlaubs-Rückgabe (nur Admin).
//
// Alle schreibenden Aktionen laufen über SECURITY DEFINER-RPCs — auf
// absence_evidence gibt es bewusst keine insert/update/delete-Policy, ein
// Mitarbeiter kann seine eigene AU also strukturell nicht bestätigen.
// ─────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import type {
  AbsenceEvidence,
  AuEvidenceStatus,
  AuRestorationCandidate,
  AuRestorationInput,
} from "@/types/absenceEvidence";

type EvidenceRow = {
  id: string;
  absence_id: string;
  status: AuEvidenceStatus;
  confirmed_by: string | null;
  confirmed_at: string | null;
  note: string | null;
};

type CandidateRow = {
  vacation_absence_id: string;
  vacation_start: string;
  vacation_end: string;
  year: number;
  deducted_days: number | string;
  already_restored: number | string;
  restorable_days: number | string;
  overlap_start: string;
  overlap_end: string;
  full_coverage: boolean;
};

// PostgREST liefert numeric als String.
const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);

/** Nachweis zu einer Krankmeldung, falls vorhanden. */
export async function getAbsenceEvidence(
  absenceId: string,
): Promise<AbsenceEvidence | null> {
  const { data, error } = await supabase
    .from("absence_evidence")
    .select("id, absence_id, status, confirmed_by, confirmed_at, note")
    .eq("absence_id", absenceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as EvidenceRow;
  return {
    id: row.id,
    absenceId: row.absence_id,
    status: row.status,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    note: row.note,
  };
}

/** AU bestätigen oder ablehnen (Admin). Idempotent. */
export async function reviewAu(
  absenceId: string,
  decision: "confirmed" | "rejected",
  note?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("admin_review_au", {
    p_absence_id: absenceId,
    p_decision: decision,
    p_note: note?.trim() || null,
  });

  if (error) throw error;
  return data as string;
}

/**
 * Rückgabefähige Posten zu einer Krankmeldung.
 *
 * Grundlage sind ausschliesslich TATSÄCHLICH GEBUCHTE Abzüge im Ledger —
 * nie ein blosser Urlaubszeitraum und nie die Einsatzplanung.
 */
export async function getRestorationCandidates(
  absenceId: string,
): Promise<AuRestorationCandidate[]> {
  const { data, error } = await supabase.rpc("get_au_restoration_candidates", {
    p_absence_id: absenceId,
  });

  if (error) throw error;

  return ((data ?? []) as CandidateRow[]).map((row) => ({
    vacationAbsenceId: row.vacation_absence_id,
    vacationStart: row.vacation_start,
    vacationEnd: row.vacation_end,
    year: row.year,
    deductedDays: num(row.deducted_days),
    alreadyRestored: num(row.already_restored),
    restorableDays: num(row.restorable_days),
    overlapStart: row.overlap_start,
    overlapEnd: row.overlap_end,
    fullCoverage: row.full_coverage,
  }));
}

/**
 * Urlaubstage aufgrund bestätigter AU zurückgeben.
 *
 * Die Menge je Urlaub und Jahr kommt vom Admin — bei Teilüberschneidung ist
 * sie nicht berechenbar. Serverseitig gilt eine harte Obergrenze: die Summe
 * aller Rückgaben je (Urlaub, Jahr) kann den ursprünglichen Abzug nie
 * übersteigen, auch nicht über mehrere Krankmeldungen hinweg.
 */
export async function restoreVacationFromAu(
  evidenceId: string,
  restorations: AuRestorationInput[],
): Promise<number> {
  if (restorations.length === 0) {
    throw new Error("Bitte mindestens einen Posten angeben.");
  }

  const { data, error } = await supabase.rpc("admin_restore_vacation_from_au", {
    p_evidence_id: evidenceId,
    p_restorations: restorations,
  });

  if (error) throw error;
  return (data as number) ?? 0;
}
