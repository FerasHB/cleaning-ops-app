// hooks/useAppTheme.ts
// ─────────────────────────────────────────────────────────────────
// Zentraler Theme-Hook für die gesamte App.
//
// Gibt das aktive Theme (light oder dark) basierend auf der
// System-Einstellung des Geräts zurück.
//
// Alle neuen Screens und Komponenten nutzen diesen Hook.
// Bestehende Screens nutzen noch die deprecated Colors/Spacing-Exports
// und werden in Phase 2+ schrittweise migriert.
//
// Verwendung:
//   const theme = useAppTheme();
//   <View style={{ backgroundColor: theme.colors.background }} />
//   <Text style={{ color: theme.colors.onSurface, fontSize: theme.typography.size.md }} />
// ─────────────────────────────────────────────────────────────────

import { darkTheme, lightTheme, type AppTheme } from '@/constants/theme';
import { useColorScheme } from 'react-native';

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkTheme : lightTheme;
}
