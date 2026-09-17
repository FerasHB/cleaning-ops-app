#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANY_LOADING_EXPORT_ERROR,
  COMPANY_UNAVAILABLE_EXPORT_ERROR,
  getTimesheetExportBlockReason,
  resolveTimesheetCompanyName,
} from "../services/timesheets/timesheetCompany.ts";
import { buildTimesheetHtml } from "../services/timesheets/timesheetHtml.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testCompany = "Test Reinigungsservice GmbH";
const hookSource = readFileSync(
  join(repositoryRoot, "features/timesheets/hooks/useTimesheet.ts"),
  "utf8",
);
const serviceSource = readFileSync(
  join(repositoryRoot, "services/timesheets/timesheet.service.ts"),
  "utf8",
);

// 1. Der echte Firmenname wird unverändert in TimesheetData übernommen.
const companyName = resolveTimesheetCompanyName({ name: `  ${testCompany}  ` });
assert.equal(companyName, testCompany);

const timesheetData = {
  companyName,
  employeeId: "employee-test-id",
  employeeName: "Test Mitarbeiterin",
  year: 2026,
  month: 9,
  monthLabel: "September 2026",
  entries: [],
  totalMinutes: 0,
  totalLabel: "0:00",
  jobCount: 0,
  needsAttention: [],
};
assert.equal(timesheetData.companyName, testCompany);
assert.match(hookSource, /const companyName = resolveTimesheetCompanyName\(company\)/);
assert.match(hookSource, /getTimesheet\(\{[\s\S]*companyName: companyName \?\? ""/);
assert.match(serviceSource, /return \{\s*companyName,/);

// 2. Der PDF-HTML-Builder schreibt genau diesen Namen neben "Firma".
const html = buildTimesheetHtml(timesheetData);
assert.match(
  html,
  /<td class="label">Firma<\/td><td>Test Reinigungsservice GmbH<\/td>/,
);

// 3. Der frühere Produktivwert darf in Anwendungscode nicht mehr vorkommen.
// Zusammensetzen verhindert, dass der Regressionstest selbst zum Treffer wird.
const forbiddenCompanyName = ["Cleaning", "Ops"].join(" ");
const productionExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirectories = new Set([
  ".expo",
  ".git",
  "dist",
  "node_modules",
  "scripts",
]);
const forbiddenOccurrences = [];

function scanDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      scanDirectory(path);
    } else if (
      productionExtensions.has(extname(entry)) &&
      readFileSync(path, "utf8").includes(forbiddenCompanyName)
    ) {
      forbiddenOccurrences.push(path);
    }
  }
}

scanDirectory(repositoryRoot);
assert.deepEqual(forbiddenOccurrences, []);

// 4. Export bleibt während des Ladens und bei fehlenden Firmendaten gesperrt.
assert.equal(
  getTimesheetExportBlockReason({
    companyLoading: true,
    companyLoadError: null,
    companyName: null,
  }),
  COMPANY_LOADING_EXPORT_ERROR,
);
assert.equal(
  getTimesheetExportBlockReason({
    companyLoading: false,
    companyLoadError: "Firmendaten konnten nicht geladen werden.",
    companyName: null,
  }),
  COMPANY_UNAVAILABLE_EXPORT_ERROR,
);
assert.equal(
  getTimesheetExportBlockReason({
    companyLoading: false,
    companyLoadError: null,
    companyName: null,
  }),
  COMPANY_UNAVAILABLE_EXPORT_ERROR,
);
assert.equal(
  getTimesheetExportBlockReason({
    companyLoading: false,
    companyLoadError: null,
    companyName: testCompany,
  }),
  null,
);
const guardPosition = hookSource.indexOf("if (exportBlockReason)");
const exportPosition = hookSource.indexOf("await exportTimesheetPdf(data)");
assert.ok(guardPosition >= 0 && guardPosition < exportPosition);

console.log("PASS: Timesheet-Firmenname und PDF-Exportsperre");
