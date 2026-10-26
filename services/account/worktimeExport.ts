// services/account/worktimeExport.ts
// Arbeitszeit-Export der eigenen Firma (Export → Bestätigen → Löschen,
// Migration 20261028000000). Wird vor der Firmenlöschung durch den letzten
// Admin angeboten: der Arbeitgeber bleibt für seine Aufbewahrungspflichten
// selbst verantwortlich, NovaFlow hält nach der Löschung kein Archiv.
//
// Datenquelle: RPC get_company_worktime_export() — nur aktive Admins, nur
// die eigene Firma (serverseitig aus dem Profil, nie aus einem Parameter).
// Enthält ausschließlich Arbeitszeit-Fakten; KEINE Abwesenheiten/
// Krankmeldungen, Notizen, Begründungen, Kommentare, Fotos, Kunden- oder
// Kontaktdaten.
//
// Dateien entstehen nur auf dem Gerät (Cache-Verzeichnis), werden über den
// Teilen-Dialog gespeichert/gesendet und danach wieder gelöscht. Es wird
// nichts auf einem Server abgelegt.

import { supabase } from "@/lib/supabase";
import { i18next } from "@/i18n";
import { File, Paths } from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import {
  buildWorktimeCsv,
  buildWorktimeHtml,
  type WorktimeExportRow,
} from "@/services/account/worktimeExportFormat";

export type { WorktimeExportRow };

export async function fetchCompanyWorktimeExport(): Promise<WorktimeExportRow[]> {
  const { data, error } = await supabase.rpc("get_company_worktime_export");
  if (error) throw error;
  return (data ?? []) as WorktimeExportRow[];
}

function exportBaseName(companyName: string, now: Date): string {
  const slug = companyName
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "company";
  return `taskops-worktime-${slug}-${now.toISOString().slice(0, 10)}`;
}

async function shareAndCleanup(file: File, mimeType: string, uti: string): Promise<void> {
  try {
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      throw new Error(i18next.t("timesheets:shareNotSupported"));
    }
    await Sharing.shareAsync(file.uri, {
      mimeType,
      UTI: uti,
      dialogTitle: i18next.t("profile:deleteAccount.export.shareTitle"),
    });
  } finally {
    // Kurzlebige Gerätedatei: nach dem Teilen-Dialog wieder entfernen.
    try {
      if (file.exists) file.delete();
    } catch {
      // Cache-Datei — das System räumt sie notfalls selbst ab.
    }
  }
}

export async function exportWorktimeCsv(
  rows: WorktimeExportRow[],
  companyName: string,
): Promise<void> {
  const now = new Date();
  const file = new File(Paths.cache, `${exportBaseName(companyName, now)}.csv`);
  if (file.exists) file.delete();
  file.create();
  file.write(buildWorktimeCsv(rows));
  await shareAndCleanup(file, "text/csv", "public.comma-separated-values-text");
}

export async function exportWorktimePdf(
  rows: WorktimeExportRow[],
  companyName: string,
): Promise<void> {
  const html = buildWorktimeHtml(rows, companyName, new Date(), (key, opts) =>
    i18next.t(`profile:deleteAccount.export.${key}`, opts),
  );
  const { uri } = await Print.printToFileAsync({ html });
  await shareAndCleanup(new File(uri), "application/pdf", "com.adobe.pdf");
}
