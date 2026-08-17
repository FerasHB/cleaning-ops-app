// services/absences/absences.service.ts
// Supabase-Operationen für Urlaub/Krankheit (Phase B).
//
// EINZIGER SCHREIBPFAD sind die fünf Mitarbeiter-RPCs aus
// supabase/migrations/20260816000000_absences_foundation.sql
// (request_own_vacation, report_own_sickness, cancel_own_vacation,
// cancel_own_sickness, update_own_sickness_end) — es gibt bewusst keine
// INSERT/UPDATE/DELETE-Policy auf employee_absences, siehe dortigen
// Kopfkommentar. Lesen läuft über ein normales SELECT, RLS beschränkt das
// bereits auf die eigenen Zeilen ("employee read own absences").
//
// Admin-RPCs (admin_review_vacation, admin_create_absence) sind bewusst NICHT
// hier verdrahtet — Admin-Workflow lebt in services/absences/adminAbsences.service.ts
// (Phase C), das AbsenceRow/mapAbsence/ABSENCE_SELECT von hier importiert statt
// sie zu duplizieren.

import { supabase } from "@/lib/supabase";
import {
  Absence,
  AbsenceStatus,
  AbsenceType,
  ReportSicknessInput,
  RequestVacationInput,
} from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";

// Exportiert für services/absences/adminAbsences.service.ts — Zeilenform und
// Mapping sind für Mitarbeiter- und Admin-Lesezugriff identisch (dieselbe
// Tabelle, dieselbe SELECT-Projektion), nur die WHERE-Bedingungen und RPCs
// unterscheiden sich. Keine zweite Kopie dieser Typen/Funktion pflegen.
export type AbsenceRow = {
  id: string;
  company_id: string;
  employee_id: string | null;
  employee_name_snapshot: string;
  type: AbsenceType;
  status: AbsenceStatus;
  start_date: string;
  end_date: string | null;
  employee_note: string | null;
  admin_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export function mapAbsence(row: AbsenceRow): Absence {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name_snapshot,
    type: row.type,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    employeeNote: row.employee_note,
    adminNote: row.admin_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Bekannte englische RPC-Ablehnungen → deutsche Nutzer-Meldung. Reihenfolge
// spezifisch → grob, gleiche Bauform wie
// services/timesheets/timeCorrection.service.ts (translateRpcError).
const RPC_MESSAGE_MAP: { match: string; message: string }[] = [
  {
    match: "Only employees can request their own vacation",
    message: "Nur Mitarbeiter können Urlaub beantragen.",
  },
  {
    match: "Only employees can report their own sickness",
    message: "Nur Mitarbeiter können eine Krankheit melden.",
  },
  {
    match: "Only employees can cancel their own vacation",
    message: "Nur Mitarbeiter können ihren eigenen Urlaub stornieren.",
  },
  {
    match: "Only employees can cancel their own sickness report",
    message: "Nur Mitarbeiter können ihre eigene Krankmeldung stornieren.",
  },
  {
    match: "Only employees can update their own sickness report",
    message: "Nur Mitarbeiter können ihre eigene Krankmeldung aktualisieren.",
  },
  {
    match: "start_date and end_date are required",
    message: "Bitte Von- und Bis-Datum angeben.",
  },
  {
    match: "start_date is required",
    message: "Bitte ein Startdatum angeben.",
  },
  {
    match: "end_date must not be before start_date",
    message: "Das Enddatum darf nicht vor dem Startdatum liegen.",
  },
  {
    match: "Overlaps an existing vacation request",
    message:
      "Dieser Zeitraum überschneidet sich mit einem bereits bestehenden Urlaubsantrag.",
  },
  {
    match: "Overlaps an existing active sickness report",
    message:
      "Dieser Zeitraum überschneidet sich mit einer bereits aktiven Krankmeldung.",
  },
  {
    match: "Vacation not found, not yours, or no longer cancellable",
    message:
      "Dieser Urlaub kann nicht mehr storniert werden — er ist entweder bereits vergangen oder wurde schon entschieden.",
  },
  {
    match: "Sickness report not found, not yours, or already closed",
    message:
      "Diese Krankmeldung wurde nicht gefunden oder ist bereits abgeschlossen.",
  },
];

function translateRpcError(err: unknown, fallback: string): string {
  const raw =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : "";

  const hit = RPC_MESSAGE_MAP.find((entry) => raw.includes(entry.match));
  if (hit) return hit.message;

  return toUserMessage(err, fallback);
}

export const ABSENCE_SELECT =
  "id, company_id, employee_id, employee_name_snapshot, type, status, start_date, end_date, employee_note, admin_note, reviewed_at, created_at, updated_at";

// "Aktive Abwesenheit" (Phase D, Kalender/Zuweisungs-Warnung): NUR
// genehmigter Urlaub oder gemeldete Krankheit — dieselbe Definition wie in
// getCurrentCompanyAbsences() (adminAbsences.service.ts, Architektur-Audit
// Phase C, Abschnitt 3B). Als Konstante exportiert statt den literalen
// PostgREST-.or()-Ausdruck an drei Stellen zu wiederholen (hier,
// adminAbsences.service.ts, absenceConflicts.ts).
export const ACTIVE_ABSENCE_FILTER_OR =
  "and(type.eq.vacation,status.eq.approved),and(type.eq.sickness,status.eq.reported)";

/** Lädt die eigenen Abwesenheiten des aktuellen Mitarbeiters (RLS-skopiert). */
export async function getMyAbsences(): Promise<Absence[]> {
  const { data, error } = await supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .order("start_date", { ascending: false });

  if (error) {
    throw new Error(
      translateRpcError(error, "Die Abwesenheiten konnten nicht geladen werden."),
    );
  }

  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/**
 * Eigene Abwesenheiten mit ECHTER Zeitraum-Überschneidung zu [from, to]
 * (Phase D, Kalenderansicht) — anders als getMyAbsences() (unbegrenzt, kein
 * Zeitraum) oder ein naiver start_date-Filter (siehe getCompanyAbsencesInRange
 * für die ausführliche Begründung des Überschneidungs-Prädikats). RLS
 * beschränkt bereits auf die eigenen Zeilen ("employee read own absences").
 */
export async function getOwnAbsencesInRange(params: {
  /** "YYYY-MM-DD", inklusive */
  from: string;
  /** "YYYY-MM-DD", inklusive */
  to: string;
  /** true = nur genehmigter Urlaub / gemeldete Krankheit (siehe ACTIVE_ABSENCE_FILTER_OR). */
  activeOnly?: boolean;
}): Promise<Absence[]> {
  let query = supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .lte("start_date", params.to)
    .or(`end_date.is.null,end_date.gte.${params.from}`)
    .order("start_date", { ascending: true });

  if (params.activeOnly) {
    query = query.or(ACTIVE_ABSENCE_FILTER_OR);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(
      translateRpcError(error, "Die Abwesenheiten konnten nicht geladen werden."),
    );
  }

  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

/**
 * Abwesenheiten EINES Mitarbeiters mit echter Zeitraum-Überschneidung zu
 * [from, to] (Phase E, Stundenzettel-Abwesenheiten) — bewusst KEIN
 * `activeOnly`-Filter hier: resolveEffectiveAbsenceDays() filtert selbst
 * nach dem operativen Aktiv-Prädikat (siehe dort), diese Abfrage liefert
 * bewusst alle Status, damit ein künftig anderes Prädikat ohne Änderung
 * dieser Funktion greifen kann.
 *
 * FUNKTIONIERT UNVERÄNDERT FÜR BEIDE ROLLEN — keine Rollen-Verzweigung
 * nötig: RLS beschränkt Mitarbeitende ohnehin auf `employee_id = auth.uid()`
 * ("employee read own absences"), unabhängig vom hier übergebenen
 * `employeeId` — ein Mitarbeiter, der (fälschlich) eine fremde ID übergibt,
 * bekommt schlicht ein leeres Ergebnis. Admins sind firmenweit gelesen
 * ("admin read company absences"), der `employeeId`-Filter grenzt hier nur
 * client-seitig auf den gewählten Mitarbeiter ein. Siehe
 * supabase/migrations/20260816000000_absences_foundation.sql (RLS-Policies).
 */
export async function getEmployeeAbsencesInRange(params: {
  employeeId: string;
  /** "YYYY-MM-DD", inklusive */
  from: string;
  /** "YYYY-MM-DD", inklusive */
  to: string;
}): Promise<Absence[]> {
  const { data, error } = await supabase
    .from("employee_absences")
    .select(ABSENCE_SELECT)
    .eq("employee_id", params.employeeId)
    .lte("start_date", params.to)
    .or(`end_date.is.null,end_date.gte.${params.from}`)
    .order("start_date", { ascending: true });

  if (error) {
    throw new Error(
      translateRpcError(error, "Die Abwesenheiten konnten nicht geladen werden."),
    );
  }

  return (data ?? []).map((row) => mapAbsence(row as AbsenceRow));
}

function firstRow(data: AbsenceRow[] | null): Absence {
  const row = data?.[0];
  if (!row) {
    throw new Error("Die Abwesenheit konnte nicht geladen werden.");
  }
  return mapAbsence(row);
}

/** Mitarbeiter beantragt eigenen Urlaub (status=requested). */
export async function requestOwnVacation(
  input: RequestVacationInput,
): Promise<Absence> {
  const { data, error } = await supabase.rpc("request_own_vacation", {
    start_date_input: input.startDate,
    end_date_input: input.endDate,
    employee_note_input: input.note?.trim() || null,
  });

  if (error) {
    throw new Error(
      translateRpcError(error, "Der Urlaubsantrag konnte nicht gestellt werden."),
    );
  }

  return firstRow(data as AbsenceRow[] | null);
}

/** Mitarbeiter meldet eigene Krankheit (status=reported, sofort aktiv). */
export async function reportOwnSickness(
  input: ReportSicknessInput,
): Promise<Absence> {
  const { data, error } = await supabase.rpc("report_own_sickness", {
    start_date_input: input.startDate,
    end_date_input: input.endDate ?? null,
    employee_note_input: input.note?.trim() || null,
  });

  if (error) {
    throw new Error(
      translateRpcError(error, "Die Krankmeldung konnte nicht gespeichert werden."),
    );
  }

  return firstRow(data as AbsenceRow[] | null);
}

/** Mitarbeiter storniert eigenen, noch nicht begonnenen Urlaub. */
export async function cancelOwnVacation(absenceId: string): Promise<Absence> {
  const { data, error } = await supabase.rpc("cancel_own_vacation", {
    absence_id_input: absenceId,
  });

  if (error) {
    throw new Error(
      translateRpcError(error, "Der Urlaub konnte nicht storniert werden."),
    );
  }

  return firstRow(data as AbsenceRow[] | null);
}

/** Mitarbeiter storniert eigene Krankmeldung (z. B. fälschlich erfasst). */
export async function cancelOwnSickness(absenceId: string): Promise<Absence> {
  const { data, error } = await supabase.rpc("cancel_own_sickness", {
    absence_id_input: absenceId,
  });

  if (error) {
    throw new Error(
      translateRpcError(error, "Die Krankmeldung konnte nicht storniert werden."),
    );
  }

  return firstRow(data as AbsenceRow[] | null);
}

/**
 * Mitarbeiter setzt/ändert das Enddatum der eigenen aktiven Krankmeldung.
 * `newEndDate: null` macht sie wieder offen-endig ("bis auf Weiteres").
 */
export async function updateOwnSicknessEnd(
  absenceId: string,
  newEndDate: string | null,
): Promise<Absence> {
  const { data, error } = await supabase.rpc("update_own_sickness_end", {
    absence_id_input: absenceId,
    new_end_date_input: newEndDate,
  });

  if (error) {
    throw new Error(
      translateRpcError(error, "Das Enddatum konnte nicht aktualisiert werden."),
    );
  }

  return firstRow(data as AbsenceRow[] | null);
}
