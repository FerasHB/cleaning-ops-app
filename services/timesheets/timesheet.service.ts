// services/timesheets/timesheet.service.ts
// Stundenzettel-Operationen: Laden der abgeschlossenen Jobs eines Mitarbeiters
// für einen Monat sowie PDF-Export (expo-print) + Teilen (expo-sharing).
//
// Quelle ist job_assignments (Phase 2, Worked Time) — keine eigene
// Timesheet-Tabelle, keine RPC. Lesezugriff ist durch die RLS-Policies
// "admin read assignments in own company" bzw.
// "employee read assignments on assigned jobs" abgesichert (siehe
// supabase/migrations/20260727000000_job_assignments_rls.sql).
//
// WARUM job_assignments STATT jobs (Phase 2, vorher jobs.started_at/
// completed_at — die GETEILTE Job-Uhr):
// Bei mehreren Zugewiesenen ist die geteilte Uhr für den Stundenzettel nicht
// mehr aussagekräftig — Ahmad und Maria hätten beide dieselbe Auftragsdauer,
// obwohl sie unterschiedlich lange vor Ort waren. Seit Phase 1 (Migration
// 20260812000000) pflegen start_own_job/complete_own_job zusätzlich die
// EIGENE Zuweisungszeile jedes Mitarbeiters (employee_started_at/
// employee_completed_at). Der Stundenzettel liest jetzt genau diese Werte.
//
// RÜCKWÄRTSKOMPATIBILITÄT: Zuweisungszeilen aus der Zeit VOR Phase 1 haben
// employee_started_at/employee_completed_at = null (die Spalten existierten
// zwar schon seit Migration 20260725000000, wurden aber von keinem Code
// beschrieben). Ein Eintrag ohne beide Werte fällt pro Zeile auf die
// GETEILTE Job-Uhr (jobs.started_at/completed_at) zurück — siehe mapEntry
// unten. Damit bleiben historische Stundenzettel korrekt (keine 0-Stunden-
// Einträge) und neue Mehrfachzuweisungen bekommen trotzdem ihre eigene,
// individuelle Dauer.

import { supabase } from "@/lib/supabase";
import { buildTimesheetHtml } from "@/services/timesheets/timesheetHtml";
import type { TimesheetData, TimesheetEntry } from "@/types/timesheet";
import {
  diffInMinutes,
  formatDateISO,
  formatDurationHm,
  formatTimeHHmm,
} from "@/utils/date";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

// So sieht eine für den Stundenzettel benötigte job_assignments-Zeile
// (inkl. eingebettetem Job `j`) aus der DB aus. `j` ist `!inner`, filtert
// also selbst mit (siehe JOB_EMBED) — pro Zuweisung gibt es dank
// `unique (job_id, employee_id)` (Migration 20260725000000) höchstens eine
// Zeile, ein Auftrag erscheint damit weiterhin nie doppelt.
type TimesheetAssignmentRow = {
  employee_started_at: string | null;
  employee_completed_at: string | null;
  j: {
    id: string;
    customer_name: string;
    service_name: string;
    location_address: string;
    started_at: string;
    completed_at: string;
  };
};

// Eingebetteter Job, aliasiert als `j`: trägt sowohl die Anzeige-Spalten
// (Kunde/Service/Ort) als auch die GETEILTE Job-Uhr für den Fallback.
// `!inner` macht `j`-Filter unten (status/job_type/started_at-Bereich) wirksam.
const JOB_EMBED = `,j:jobs!inner(id,customer_name,service_name,location_address,started_at,completed_at)`;

// Baut die Bemerkung aus Service + Ort: "Fensterreinigung · Hauptstr. 1".
function buildRemark(service: string | null, location: string | null): string {
  const parts = [service?.trim(), location?.trim()].filter(
    (part): part is string => !!part,
  );
  return parts.join(" · ");
}

// Wandelt eine job_assignments-Zeile in einen Stundenzettel-Eintrag um.
//
// QUELLE PRO ZEILE: individuelle Zeit (employee_started_at/completed_at),
// wenn BEIDE gesetzt sind — sonst Fallback auf die geteilte Job-Uhr
// (j.started_at/completed_at). Kein Mischen einzelner Werte (z.B. eigener
// Start + geteiltes Ende): entweder das vollständige eigene Paar oder das
// vollständige geteilte Paar, nie eine Kombination aus beiden.
//
// Der Arbeitstag wird lokal aus dem jeweils verwendeten Start abgeleitet
// (timestamptz ist UTC).
function mapEntry(row: TimesheetAssignmentRow): TimesheetEntry {
  const hasOwnTimes = !!row.employee_started_at && !!row.employee_completed_at;
  const startIso = hasOwnTimes ? row.employee_started_at! : row.j.started_at;
  const endIso = hasOwnTimes ? row.employee_completed_at! : row.j.completed_at;

  const startedAt = new Date(startIso);
  const durationMinutes = diffInMinutes(startIso, endIso);

  return {
    jobId: row.j.id,
    date: formatDateISO(startedAt) ?? startIso.slice(0, 10),
    beginLabel: formatTimeHHmm(startedAt) ?? "--:--",
    endLabel: formatTimeHHmm(new Date(endIso)) ?? "--:--",
    durationMinutes,
    durationLabel: formatDurationHm(durationMinutes),
    customerName: row.j.customer_name,
    remark: buildRemark(row.j.service_name, row.j.location_address),
  };
}

/**
 * Lädt die abgeschlossenen Zuweisungen eines Mitarbeiters für einen Monat
 * und baut daraus den vollständigen Stundenzettel.
 *
 * Filter (alle serverseitig, keine Client-seitige Filterung großer Mengen):
 *  - job_assignments.employee_id = der gewählte Mitarbeiter — indiziert über
 *    idx_job_assignments_employee (employee_id, job_id), Migration
 *    20260725000000. Kein neuer Index nötig.
 *  - j.status = 'completed'
 *  - j.job_type = 'single' (schließt Recurring-Parent-Regeln aus; konkrete
 *    Occurrences sind selbst 'single')
 *  - j.started_at / j.completed_at vorhanden
 *  - Arbeitstag (j.started_at, lokal) im gewählten Monat — bewusst weiterhin
 *    über die GETEILTE Job-Uhr eingegrenzt, nicht über employee_started_at:
 *    ein Datumsbereich über zwei mögliche Spalten (eigene ODER geteilte Zeit)
 *    ließe sich nicht als einzelner Index-Scan ausdrücken, und j.started_at
 *    ist für jeden Eintrag in diesem Filter ohnehin vorhanden (siehe oben).
 *    In der ganz seltenen Randlage, in der ein Mitarbeiter über Mitternacht
 *    hinweg arbeitet, kann der individuelle Kalendertag (unten aus
 *    employee_started_at abgeleitet) dadurch theoretisch einen Tag vom
 *    Monatsfilter abweichen — für ein Reinigungs-Business ohne Nachtschicht-
 *    Betrieb kein relevanter Fall.
 *
 * DAUER PRO ZEILE (Phase 2, Worked Time): siehe mapEntry — individuelle Zeit
 * (employee_started_at/employee_completed_at), sonst Fallback auf die
 * geteilte Job-Uhr (j.started_at/completed_at). Sortierung nach dem so
 * gewählten Start passiert client-seitig NACH dem Laden (die Datenmenge ist
 * durch die obigen Filter bereits auf einen Mitarbeiter-Monat begrenzt,
 * keine Firmen-weite Menge).
 *
 * WARUM NICHT jobs.assigned_to:
 * Seit der Mehrfachzuweisung (Phase 6A) kann ein Auftrag mehreren Mitarbeitern
 * gehören. jobs.assigned_to kann aber nur EINEN tragen; welcher das ist,
 * bestimmt compat_primary_assignee() und ist bei gleichzeitig angelegten
 * Zuweisungen ARBITRÄR (gleicher assigned_at → Tiebreak über die zufällige
 * UUID `id`, siehe Migration 20260726000000).
 *
 * WARUM WEITERHIN NICHT counts_for_timesheet:
 * Seit Phase 1 (Migration 20260812000000) pflegen die Start/Complete-RPCs
 * zwar attendance, counts_for_timesheet bleibt aber eine reine
 * Abrechnungs-BERECHTIGUNG (Manager-Review, künftige Phase) — kein Signal
 * dafür, WELCHE Zeitquelle anzuzeigen ist. Ein Filter darauf würde exakt die
 * Zeilen ausblenden, die hier den Fallback brauchen (attendance='assigned',
 * z. B. historische Zeilen vor Phase 1 oder ein Kollege, der nie selbst
 * Start gedrückt hat) — bewusst weiterhin ungefiltert gelassen.
 *
 * Bewusst NICHT gefiltert wird zusätzlich nach:
 *  - attendance / review  → siehe oben
 *  - profiles.is_active   → historische Stundenzettel müssen auch für
 *                           inzwischen deaktivierte Mitarbeiter abrufbar
 *                           bleiben (Abrechnung/Nachweis)
 *
 * @param year   z.B. 2026
 * @param month  1–12
 */
export async function getTimesheet(params: {
  companyName: string;
  employeeId: string;
  employeeName: string;
  year: number;
  month: number;
}): Promise<TimesheetData> {
  const { companyName, employeeId, employeeName, year, month } = params;

  // Lokale Monatsgrenzen → als ISO (UTC) an die Query. So werden Jobs anhand
  // ihres lokalen Start-Zeitpunkts dem richtigen Monat zugeordnet.
  const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const nextMonthStart = new Date(year, month, 1, 0, 0, 0, 0);

  const { data, error } = await supabase
    .from("job_assignments")
    .select(`employee_started_at,employee_completed_at` + JOB_EMBED)
    .eq("employee_id", employeeId)
    .eq("j.status", "completed")
    .eq("j.job_type", "single")
    .not("j.started_at", "is", null)
    .not("j.completed_at", "is", null)
    .gte("j.started_at", monthStart.toISOString())
    .lt("j.started_at", nextMonthStart.toISOString());

  if (error) {
    throw error;
  }

  // Client-seitige Sortierung nach der individuellen Zeitquelle (siehe
  // Dokumentation oben) — "YYYY-MM-DD" + "HH:mm" ist lexikographisch
  // chronologisch sortierbar.
  const entries = (data ?? [])
    .map((row) => mapEntry(row as unknown as TimesheetAssignmentRow))
    .sort((a, b) =>
      a.date + a.beginLabel < b.date + b.beginLabel
        ? -1
        : a.date + a.beginLabel > b.date + b.beginLabel
          ? 1
          : 0,
    );
  const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);

  const monthLabel = monthStart.toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  });

  return {
    companyName,
    employeeId,
    employeeName,
    year,
    month,
    monthLabel,
    entries,
    totalMinutes,
    totalLabel: formatDurationHm(totalMinutes),
    jobCount: entries.length,
  };
}

/**
 * Erzeugt das PDF aus dem Stundenzettel und öffnet den Teilen-Dialog
 * (Speichern/Senden). Mobile-only — auf Web ist expo-sharing nicht verfügbar.
 */
export async function exportTimesheetPdf(data: TimesheetData): Promise<void> {
  const html = buildTimesheetHtml(data);

  const { uri } = await Print.printToFileAsync({ html });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error("Teilen wird auf diesem Gerät nicht unterstützt.");
  }

  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    dialogTitle: "Stundenzettel teilen",
    UTI: "com.adobe.pdf",
  });
}
