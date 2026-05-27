// hooks/use-theme-color.ts
// ─────────────────────────────────────────────────────────────────
// Expo-Template-Kompatibilitätshook.
// Nicht direkt verwenden — nutze stattdessen useAppTheme().
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from '@/hooks/useAppTheme';

/**
 * @deprecated Nutze useAppTheme() für das neue Theme-System.
 * Dieser Hook ist nur für Expo-Template-Kompatibilität vorhanden.
 */
export function useThemeColor(
  props: { light?: string; dark?: string },
  _colorName?: string
): string {
  const theme = useAppTheme();
  const key = theme.isDark ? 'dark' : 'light';
  return props[key] ?? theme.colors.onSurface;
}
