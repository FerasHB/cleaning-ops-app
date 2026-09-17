// services/offline/appConfig.storage.ts
// Lokaler Cache für app_config (AsyncStorage) — gleiche Konvention wie
// profile.storage.ts. Rein UX: ein Ladefehler hier darf die App nie
// blockieren, die serverseitige RPC-Durchsetzung (enforce_min_client_version)
// bleibt in jedem Fall die Autorität, unabhängig vom Zustand dieses Caches.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AppConfig } from "@/services/appConfig.service";

const CACHE_KEY = "cached_app_config_v1";

export async function saveCachedAppConfig(config: AppConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(config));
  } catch {
    // Best-effort — ein Schreibfehler hier darf nichts blockieren.
  }
}

export async function getCachedAppConfig(): Promise<AppConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppConfig) : null;
  } catch {
    return null;
  }
}
