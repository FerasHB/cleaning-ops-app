// services/timesheets/timesheetHtml.ts
// Baut das druckbare HTML für den Arbeitszeitnachweis (Stundenzettel).
// Bewusst eigenes, neutrales Layout — KEIN DATEV-Branding, kein Logo, keine
// fremden Marken. Reines Inline-CSS, optimiert für expo-print (A4).

import type { TimesheetData, TimesheetEntry } from "@/types/timesheet";

// In Version 1 gibt es keine Pausenerfassung — Spalte zeigt fest "0:00".
const PAUSE_PLACEHOLDER = "0:00";

// Minimal-Escaping gegen kaputtes HTML durch Kunden-/Service-Texte.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// "YYYY-MM-DD" → "Mo 03.06." (Wochentag-Kurzform + Tag.Monat) ohne Zeitzonen-Drift.
function formatDayCell(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return escapeHtml(isoDate);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("de-DE", { weekday: "short" });
  const dd = String(d).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${escapeHtml(weekday)} ${dd}.${mm}.`;
}

// Heutiges Datum als "dd.mm.yyyy" für den Export-Stempel.
function todayLabel(): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${now.getFullYear()}`;
}

function renderRow(entry: TimesheetEntry): string {
  return `
    <tr>
      <td class="day">${formatDayCell(entry.date)}</td>
      <td class="num">${escapeHtml(entry.beginLabel)}</td>
      <td class="num">${PAUSE_PLACEHOLDER}</td>
      <td class="num">${escapeHtml(entry.endLabel)}</td>
      <td class="num">${escapeHtml(entry.durationLabel)}</td>
      <td>${escapeHtml(entry.customerName)}</td>
      <td class="remark">${escapeHtml(entry.remark)}</td>
    </tr>`;
}

function renderEmptyRow(): string {
  return `
    <tr>
      <td colspan="7" class="empty">Keine abgeschlossenen Aufträge in diesem Zeitraum.</td>
    </tr>`;
}

export function buildTimesheetHtml(data: TimesheetData): string {
  const rows =
    data.entries.length > 0
      ? data.entries.map(renderRow).join("")
      : renderEmptyRow();

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    margin: 0;
    padding: 28px 32px;
    font-size: 12px;
    line-height: 1.45;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 4px 0;
    letter-spacing: -0.2px;
  }
  .subtitle {
    color: #666;
    font-size: 11px;
    margin: 0 0 20px 0;
  }
  .meta {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
  }
  .meta td {
    padding: 3px 0;
    vertical-align: top;
  }
  .meta .label {
    color: #666;
    width: 120px;
    font-weight: 600;
  }
  table.entries {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 18px;
  }
  table.entries th,
  table.entries td {
    border: 1px solid #d0d0d0;
    padding: 6px 8px;
    text-align: left;
  }
  table.entries th {
    background: #f2f2f2;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #444;
  }
  table.entries td.num,
  table.entries th.num { text-align: right; white-space: nowrap; }
  table.entries td.day { white-space: nowrap; }
  table.entries td.remark { color: #555; }
  table.entries td.empty {
    text-align: center;
    color: #888;
    padding: 18px 8px;
    font-style: italic;
  }
  tfoot td {
    border: 1px solid #d0d0d0;
    background: #fafafa;
    font-weight: 700;
    padding: 8px;
  }
  .summary {
    display: flex;
    justify-content: space-between;
    margin-bottom: 36px;
    font-size: 12px;
  }
  .summary .box {
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    padding: 10px 16px;
  }
  .summary .box .k { color: #666; font-size: 10px; text-transform: uppercase; }
  .summary .box .v { font-size: 16px; font-weight: 700; }
  .signatures {
    display: flex;
    justify-content: space-between;
    gap: 40px;
    margin-top: 48px;
  }
  .signatures .sig {
    flex: 1;
    border-top: 1px solid #333;
    padding-top: 6px;
    font-size: 10px;
    color: #555;
  }
  .hint {
    margin-top: 32px;
    font-size: 10px;
    color: #999;
    text-align: center;
  }
</style>
</head>
<body>
  <h1>Arbeitszeitnachweis</h1>
  <p class="subtitle">Dokumentation der täglichen Arbeitszeit</p>

  <table class="meta">
    <tr><td class="label">Firma</td><td>${escapeHtml(data.companyName)}</td></tr>
    <tr><td class="label">Mitarbeiter</td><td>${escapeHtml(data.employeeName)}</td></tr>
    <tr><td class="label">Monat / Jahr</td><td>${escapeHtml(data.monthLabel)}</td></tr>
    <tr><td class="label">Erstellt am</td><td>${todayLabel()}</td></tr>
  </table>

  <table class="entries">
    <thead>
      <tr>
        <th>Tag</th>
        <th class="num">Beginn</th>
        <th class="num">Pause</th>
        <th class="num">Ende</th>
        <th class="num">Dauer</th>
        <th>Auftrag / Kunde</th>
        <th>Bemerkungen</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="text-align:right;">Summe der Stunden</td>
        <td class="num" style="text-align:right;">${escapeHtml(data.totalLabel)}</td>
        <td colspan="2"></td>
      </tr>
    </tfoot>
  </table>

  <div class="summary">
    <div class="box">
      <div class="k">Summe der Stunden</div>
      <div class="v">${escapeHtml(data.totalLabel)} h</div>
    </div>
    <div class="box">
      <div class="k">Anzahl Jobs</div>
      <div class="v">${data.jobCount}</div>
    </div>
  </div>

  <div class="signatures">
    <div class="sig">Datum / Unterschrift Arbeitnehmer</div>
    <div class="sig">Datum / Unterschrift Arbeitgeber</div>
  </div>

  <p class="hint">Automatisch erstellt aus abgeschlossenen Aufträgen.</p>
</body>
</html>`;
}
