// services/account/worktimeExportFormat.ts
// Reine Formatierung des Arbeitszeit-Exports (CSV + druckbares HTML) — ohne
// React-Native-/Supabase-Importe, damit sie in Node testbar ist
// (scripts/check-worktime-export.mjs). Datenquelle und Teilen:
// services/account/worktimeExport.ts.

export type WorktimeExportRow = {
  record_kind: "session" | "assignment";
  employee_id: string | null;
  employee_name: string | null;
  work_date: string | null;
  start_local: string | null;
  end_local: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  raw_started_at: string | null;
  raw_ended_at: string | null;
  corrected: boolean;
  correction_count: number;
  last_correction_origin: string | null;
  last_corrected_at: string | null;
  time_adjustment_count: number;
  job_id: string | null;
  assignment_id: string | null;
  timezone: string;
};

// Spaltenreihenfolge der CSV — stabile, englische Schlüssel (maschinenlesbar).
const CSV_COLUMNS: (keyof WorktimeExportRow)[] = [
  "employee_name",
  "employee_id",
  "work_date",
  "start_local",
  "end_local",
  "duration_minutes",
  "record_kind",
  "corrected",
  "correction_count",
  "last_correction_origin",
  "last_corrected_at",
  "raw_started_at",
  "raw_ended_at",
  "started_at",
  "ended_at",
  "time_adjustment_count",
  "job_id",
  "assignment_id",
  "timezone",
];

// RFC-4180-Quoting mit ";" als Trennzeichen (Excel in DE). Werte, die mit
// = + - @ beginnen, werden entschärft (CSV-/Formel-Injection über Namen).
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[";\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildWorktimeCsv(rows: WorktimeExportRow[]): string {
  const lines = [
    CSV_COLUMNS.join(";"),
    ...rows.map((row) => CSV_COLUMNS.map((col) => csvCell(row[col])).join(";")),
  ];
  // BOM, damit Excel UTF-8 (Umlaute) korrekt erkennt.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// t: Übersetzer für die Schlüssel unter profile:deleteAccount.export.* —
// als Parameter, damit dieses Modul frei von RN-/i18n-Laufzeit bleibt
// (Node-Test scripts/check-worktime-export.mjs).
export type ExportTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function buildWorktimeHtml(
  rows: WorktimeExportRow[],
  companyName: string,
  generatedAt: Date,
  t: ExportTranslate,
): string {

  const groups = new Map<string, WorktimeExportRow[]>();
  for (const row of rows) {
    const key = row.employee_name?.trim() || t("unknownEmployee");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const sections = [...groups.entries()]
    .map(([name, entries]) => {
      const total = entries.reduce((sum, e) => sum + (e.duration_minutes ?? 0), 0);
      const body = entries
        .map((e) => {
          const flags = [
            e.corrected ? t("flagCorrected") : "",
            e.time_adjustment_count > 0 ? t("flagAdjusted") : "",
            e.ended_at === null ? t("flagOpen") : "",
          ]
            .filter(Boolean)
            .join(", ");
          return `<tr>
            <td>${escapeHtml(e.work_date ?? "")}</td>
            <td>${escapeHtml(e.start_local ?? "")}</td>
            <td>${escapeHtml(e.end_local ?? "")}</td>
            <td class="num">${e.duration_minutes === null ? "" : formatMinutes(e.duration_minutes)}</td>
            <td>${escapeHtml(flags)}</td>
          </tr>`;
        })
        .join("");
      return `<h2>${escapeHtml(name)}</h2>
        <table>
          <thead><tr>
            <th>${escapeHtml(t("colDate"))}</th>
            <th>${escapeHtml(t("colStart"))}</th>
            <th>${escapeHtml(t("colEnd"))}</th>
            <th class="num">${escapeHtml(t("colDuration"))}</th>
            <th>${escapeHtml(t("colNotes"))}</th>
          </tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td colspan="3">${escapeHtml(t("total"))}</td>
            <td class="num">${formatMinutes(total)}</td><td></td></tr></tfoot>
        </table>`;
    })
    .join("");

  const timezone = rows[0]?.timezone ?? "";

  return `<!doctype html><html><head><meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 11px; color: #111; margin: 24px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    h2 { font-size: 13px; margin: 18px 0 6px; }
    .meta { color: #555; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; }
    th { background: #f3f3f3; }
    tfoot td { font-weight: bold; }
    .num { text-align: right; }
  </style></head><body>
    <h1>${escapeHtml(t("pdfTitle"))}</h1>
    <div class="meta">${escapeHtml(companyName)}</div>
    <div class="meta">${escapeHtml(t("pdfGenerated", { date: generatedAt.toISOString().slice(0, 16).replace("T", " ") }))} UTC</div>
    ${timezone ? `<div class="meta">${escapeHtml(t("pdfTimezone", { timezone }))}</div>` : ""}
    <div class="meta">${escapeHtml(t("pdfScope"))}</div>
    ${rows.length === 0 ? `<p>${escapeHtml(t("pdfEmpty"))}</p>` : sections}
  </body></html>`;
}
