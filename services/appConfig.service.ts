// services/appConfig.service.ts
// Liest das globale Plattform-Konfigurationsfundament (app_config,
// Migration 20260916120000). Rein lesend — Schreiben ist bewusst nur per
// SQL Editor/service_role möglich (siehe RLS-Policy auf app_config), das
// ist ein Betreiber-Hebel, kein firmenspezifisches Setting.

import { supabase } from "@/lib/supabase";

export type AppConfig = {
  enforcementEnabled: boolean;
  minBuildIos: number;
  minBuildAndroid: number;
  forceCompleteEnabled: boolean;
  pauseResumeEnabled: boolean;
  updateUrlIos: string | null;
  updateUrlAndroid: string | null;
};

// Sichere Startwerte, falls einzelne Schlüssel in der Tabelle fehlen sollten
// (defensiv statt eines harten Fehlers — die Tabelle selbst ist Pflicht).
const DEFAULTS: AppConfig = {
  enforcementEnabled: false,
  minBuildIos: 1,
  minBuildAndroid: 1,
  forceCompleteEnabled: false,
  pauseResumeEnabled: false,
  updateUrlIos: null,
  updateUrlAndroid: null,
};

export async function fetchAppConfig(): Promise<AppConfig> {
  const { data, error } = await supabase.from("app_config").select("key, value");

  if (error) throw error;

  const map = new Map<string, unknown>((data ?? []).map((row) => [row.key, row.value]));

  return {
    enforcementEnabled: Boolean(
      map.get("enforcement_enabled") ?? DEFAULTS.enforcementEnabled,
    ),
    minBuildIos: Number(map.get("min_build_ios") ?? DEFAULTS.minBuildIos),
    minBuildAndroid: Number(map.get("min_build_android") ?? DEFAULTS.minBuildAndroid),
    forceCompleteEnabled: Boolean(
      map.get("force_complete_enabled") ?? DEFAULTS.forceCompleteEnabled,
    ),
    pauseResumeEnabled: Boolean(
      map.get("pause_resume_enabled") ?? DEFAULTS.pauseResumeEnabled,
    ),
    updateUrlIos: (map.get("update_url_ios") as string | null) ?? null,
    updateUrlAndroid: (map.get("update_url_android") as string | null) ?? null,
  };
}
