// services/timesheets/timesheet.service.ts
// Stundenzettel-Operationen: Laden der abgeschlossenen Jobs eines Mitarbeiters
// für einen Monat sowie PDF-Export (expo-print) + Teilen (expo-sharing).
//
// Quelle ist ausschließlich die jobs-Tabelle — keine eigene Timesheet-Tabelle,
// keine RPC. Lesezugriff ist durch die RLS-Policy "admin read jobs in own company"
// abgesichert (Admin sieht nur Jobs der eigenen Firma).

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

// So sehen die für den Stundenzettel benötigten Job-Spalten aus der DB aus.
type TimesheetJobRow = {
  id: string;
  customer_name: string;
  service_name: string;
  location_address: string;
  started_at: string;
  completed_at: string;
};

// Zusätzlicher Embed, der AUSSCHLIESSLICH als Filter-Prädikat dient:
// „nur Aufträge, denen dieser Mitarbeiter zugewiesen ist".
//
// Identisches Muster wie ASSIGNEE_FILTER_EMBED in services/jobs/jobs.service.ts
// (dort als duplikatfrei verifiziert). Der Alias `f` verhindert eine Kollision
// mit anderen Embeds und macht sichtbar, dass die Menge nie GELESEN wird.
//
// KEINE DUPLIKATE: Der Filter unten bindet `f.employee_id` auf GENAU EINEN
// Mitarbeiter, und job_assignments trägt die Bedingung
// `unique (job_id, employee_id)` (Migration 20260725000000). Pro Auftrag kann
// also höchstens EINE Zuweisungszeile matchen — ein Auftrag erscheint damit
// niemals doppelt im Stundenzettel, auch nicht bei mehreren Zugewiesenen.
const ASSIGNEE_FILTER_EMBED = `,f:job_assignments!inner(employee_id)`;

// Baut die Bemerkung aus Service + Ort: "Fensterreinigung · Hauptstr. 1".
function buildRemark(service: string | null, location: string | null): string {
  const parts = [service?.trim(), location?.trim()].filter(
    (part): part is string => !!part,
  );
  return parts.join(" · ");
}

// Wandelt eine DB-Zeile in einen Stundenzettel-Eintrag um.
// Der Arbeitstag wird lokal aus started_at abgeleitet (timestamptz ist UTC).
function mapEntry(row: TimesheetJobRow): TimesheetEntry {
  const startedAt = new Date(row.started_at);
  const durationMinutes = diffInMinutes(row.started_at, row.completed_at);

  return {
    jobId: row.id,
    date: formatDateISO(startedAt) ?? row.started_at.slice(0, 10),
    beginLabel: formatTimeHHmm(startedAt) ?? "--:--",
    endLabel: formatTimeHHmm(new Date(row.completed_at)) ?? "--:--",
    durationMinutes,
    durationLabel: formatDurationHm(durationMinutes),
    customerName: row.customer_name,
    remark: buildRemark(row.service_name, row.location_address),
  };
}

/**
 * Lädt die abgeschlossenen Jobs eines Mitarbeiters für einen Monat und baut
 * daraus den vollständigen Stundenzettel.
 *
 * Filter:
 *  - Mitarbeiter ist dem Auftrag ZUGEWIESEN (job_assignments.employee_id),
 *    NICHT mehr der Legacy-Zeiger jobs.assigned_to — siehe Begründung unten
 *  - status = 'completed'
 *  - started_at / completed_at vorhanden
 *  - job_type = 'single' (schließt Recurring-Parent-Regeln aus; konkrete
 *    Occurrences sind selbst 'single')
 *  - Arbeitstag (started_at, lokal) im gewählten Monat
 *
 * WARUM NICHT MEHR jobs.assigned_to:
 * Seit der Mehrfachzuweisung (Phase 6A) kann ein Auftrag mehreren Mitarbeitern
 * gehören. jobs.assigned_to kann aber nur EINEN tragen; welcher das ist,
 * bestimmt compat_primary_assignee() und ist bei gleichzeitig angelegten
 * Zuweisungen ARBITRÄR (gleicher assigned_at → Tiebreak über die zufällige
 * UUID `id`, siehe Migration 20260726000000). Der alte Filter schloss damit
 * alle übrigen Zugewiesenen aus dem Stundenzettel aus — sie wurden für
 * geleistete Arbeit nicht erfasst.
 *
 * WARUM (NOCH) NICHT counts_for_timesheet:
 * Die Spalte ist als künftige Berechtigungsquelle vorgesehen, wird aber
 * derzeit von NICHTS gepflegt: set_job_assignments legt Zeilen mit dem
 * Default attendance='assigned' an, und start_own_job/complete_own_job fassen
 * job_assignments überhaupt nicht an (Phase 7 offen). counts_for_timesheet ist
 * für neu angelegte Zuweisungen deshalb dauerhaft false — ein Filter darauf
 * lieferte heute LEERE Stundenzettel. Der Umstieg gehört zu Phase 7/9, wenn
 * attendance serverseitig gesetzt wird.
 *
 * Bewusst NICHT gefiltert wird zusätzlich nach:
 *  - attendance / review  → siehe oben, werden aktuell nicht gepflegt
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
    .from("jobs")
    .select(
      `
      id,
      customer_name,
      service_name,
      location_address,
      started_at,
      completed_at
      ` + ASSIGNEE_FILTER_EMBED,
    )
    .eq("f.employee_id", employeeId)
    .eq("status", "completed")
    .eq("job_type", "single")
    .not("started_at", "is", null)
    .not("completed_at", "is", null)
    .gte("started_at", monthStart.toISOString())
    .lt("started_at", nextMonthStart.toISOString())
    .order("started_at", { ascending: true });

  if (error) {
    throw error;
  }

  // Der Filter-Embed `f` ist Teil der Zeile, wird aber nie gelesen — gleiche
  // Cast-Konvention wie bei den gebundenen Abfragen in jobs.service.ts.
  const entries = (data ?? []).map((row) =>
    mapEntry(row as unknown as TimesheetJobRow),
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
