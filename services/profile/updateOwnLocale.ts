// services/profile/updateOwnLocale.ts
// Synchronisiert die eigene Sprachpräferenz zum Server (profiles.locale,
// 20260915000000) — NUR relevant für server-seitig erzeugte Inhalte
// (Push-Benachrichtigungen); die Client-UI-Sprache bleibt weiterhin separat
// in AsyncStorage (i18n/storage.ts) und ist bereits vor diesem Aufruf aktiv.
//
// Bewusst NICHT aus initI18n() (Kaltstart) aufgerufen — nur aus dem
// EXPLIZITEN Sprachwechsel (changeAppLanguage()-Aufrufer, siehe
// ProfileScreen.tsx). Ein Fehler hier (offline, Server down) darf den
// bereits vollzogenen lokalen Wechsel NIE rückgängig machen oder blockieren
// — der Aufrufer ruft dies deshalb "fire and forget" mit eigenem try/catch.

import { supabase } from "@/lib/supabase";
import type { AppLocale } from "@/i18n/config";
import { SUPPORTED_LOCALES } from "@/i18n/config";

export async function updateOwnLocale(locale: AppLocale): Promise<void> {
  // Verteidigung in der Tiefe — der eigentliche Schutz ist die CHECK-
  // Constraint chk_profiles_locale in der DB.
  if (!SUPPORTED_LOCALES.includes(locale)) return;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { error } = await supabase
    .from("profiles")
    .update({ locale })
    .eq("id", user.id);

  if (error) throw error;
}
