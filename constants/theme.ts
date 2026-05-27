// constants/theme.ts
// ─────────────────────────────────────────────────────────────────
// Zentrales Theme-System mit Light- und Dark-Mode-Unterstützung.
//
// NEUE Screens/Komponenten:
//   → import { useAppTheme } from '@/hooks/useAppTheme'
//   → const theme = useAppTheme()
//   → theme.colors.*, theme.spacing.*, theme.radius.*, ...
//
// BESTEHENDE Screens (noch nicht migriert):
//   → nutzen Colors, Spacing, Radius, Typography, Shadows (deprecated)
//   → Diese zeigen immer Light-Mode-Werte, brechen aber nicht
// ─────────────────────────────────────────────────────────────────

import { darkColors, lightColors, type ColorPalette } from './colors';

// ═══════════════════════════════════════════════════════════════
// SHARED — Theme-unabhängige Werte (Spacing, Radius, Typography)
// ═══════════════════════════════════════════════════════════════

export const spacing = {
  xs:        4,
  sm:        8,
  md:        16,
  lg:        24,
  xl:        32,
  xxl:       48,
  gutter:    16, // Standard horizontaler Seitenrand (Mobile)
  tapTarget: 44, // Mindesthöhe interaktiver Elemente (WCAG)
} as const;

export const radius = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   24,
  full: 9999,
} as const;

export const typography = {
  // Größen-Skala
  size: {
    xs:  12,
    sm:  14,
    md:  16,
    lg:  18,
    xl:  22,
    xxl: 28,
  },
  // Gewichte
  weight: {
    regular:   '400' as const,
    medium:    '500' as const,
    semibold:  '600' as const,
    bold:      '700' as const,
    extrabold: '800' as const,
  },
  // Zeilenhöhen (absolut, passend zur Größe)
  lineHeight: {
    xs:  16,
    sm:  20,
    md:  24,
    lg:  28,
    xl:  32,
    xxl: 36,
  },
  // Letter Spacing
  letterSpacing: {
    tight:   -0.5,
    normal:   0,
    wide:     0.3,
    wider:    0.8,
    widest:   1.2,
  },
  // Font-Familien (Inter, nach useFonts-Loading verfügbar)
  family: {
    regular:  'Inter_400Regular',
    medium:   'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold:     'Inter_700Bold',
  },
} as const;

// ═══════════════════════════════════════════════════════════════
// SCHATTEN
// Dark Mode: kein Drop-Shadow (sieht "muddy" auf dunklem Hintergrund aus)
//            → Tiefe wird durch hellere Surfaces + Border erreicht
// Light Mode: subtile Schatten für Tiefenwirkung
// ═══════════════════════════════════════════════════════════════

function buildShadows(isDark: boolean) {
  if (isDark) {
    // Auf dunklen Hintergründen: Tiefe durch Tonal Layering (hellere Surface)
    // Statt Drop-Shadow → 1px Border auf Karten
    return { sm: {}, md: {}, lg: {} };
  }
  return {
    sm: {
      shadowColor: '#0F172A',
      shadowOpacity: 0.04,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    md: {
      shadowColor: '#0F172A',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 2,
    },
    lg: {
      shadowColor: '#0F172A',
      shadowOpacity: 0.10,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 4,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// THEME-TYP
// ═══════════════════════════════════════════════════════════════

export type AppTheme = {
  colors:     ColorPalette;
  spacing:    typeof spacing;
  radius:     typeof radius;
  typography: typeof typography;
  shadows:    ReturnType<typeof buildShadows>;
  isDark:     boolean;
};

// ═══════════════════════════════════════════════════════════════
// THEME-OBJEKTE
// ═══════════════════════════════════════════════════════════════

export const lightTheme: AppTheme = {
  colors:     lightColors,
  spacing,
  radius,
  typography,
  shadows:    buildShadows(false),
  isDark:     false,
};

export const darkTheme: AppTheme = {
  colors:     darkColors,
  spacing,
  radius,
  typography,
  shadows:    buildShadows(true),
  isDark:     true,
};

// ═══════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY
// ─────────────────────────────────────────────────────────────
// Die folgenden Exporte halten bestehende Screens am Laufen.
// Sie zeigen immer Light-Theme-Werte.
// Screens werden in Phase 2+ schrittweise auf useAppTheme() migriert.
// @deprecated — in neuen Screens useAppTheme() nutzen
// ═══════════════════════════════════════════════════════════════

/** @deprecated Nutze useAppTheme().colors */
export const Colors = {
  white: '#FFFFFF',
  black: '#0F172A',

  bg: {
    app:      lightColors.background,
    surface:  lightColors.surface,
    elevated: lightColors.surfaceContainerHigh,
    overlay:  lightColors.surfaceContainer,
    base:     lightColors.background,
  },

  text: {
    primary:   lightColors.onSurface,
    secondary: lightColors.onSurfaceVariant,
    muted:     lightColors.outline,
  },

  border: {
    default:  lightColors.outlineVariant,
    subtle:   lightColors.surfaceContainerHighest,
    strong:   lightColors.outline,
  },

  accent: {
    default: lightColors.primary,
    text:    lightColors.primaryContainer,
    subtle:  lightColors.statusInProgressBg,
    muted:   '#93C5FD',
    border:  lightColors.statusInProgressBorder,
  },

  status: {
    warning:   lightColors.statusOpen,
    warningBg: lightColors.statusOpenBg,
    success:   lightColors.statusCompleted,
    successBg: lightColors.statusCompletedBg,
    neutral:   '#374151',
    neutralBg: '#E5E7EB',
    danger:    lightColors.error,
    dangerBg:  lightColors.errorContainer,
  },
} as const;

/** @deprecated Nutze spacing aus useAppTheme() */
export const Spacing = {
  xs:  6,
  sm:  10,
  md:  14,
  lg:  18,
  xl:  24,
  xxl: 32,
};

/** @deprecated Nutze radius aus useAppTheme() */
export const Radius = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  full: 999,
};

/** @deprecated Nutze typography aus useAppTheme() */
export const Typography = {
  size: {
    xs:   12,
    sm:   14,
    md:   16,
    lg:   18,
    xl:   22,
    xxl:  28,
    base: 16,
  },
  weight: {
    regular:   '400' as const,
    medium:    '500' as const,
    semibold:  '600' as const,
    bold:      '700' as const,
    extrabold: '800' as const,
  },
  leading: {
    tight:   1.2,
    normal:  1.4,
    relaxed: 1.6,
  },
  tracking: {
    tight:  -0.3,
    normal:  0,
    wide:    0.5,
    wider:   0.8,
  },
};

/** @deprecated Nutze theme.shadows aus useAppTheme() */
export const Shadows = {
  sm: {
    shadowColor:  '#000',
    shadowOpacity: 0.04,
    shadowRadius:  4,
    shadowOffset:  { width: 0, height: 2 },
    elevation:     1,
  },
  md: {
    shadowColor:  '#000',
    shadowOpacity: 0.06,
    shadowRadius:  8,
    shadowOffset:  { width: 0, height: 3 },
    elevation:     2,
  },
  lg: {
    shadowColor:  '#000',
    shadowOpacity: 0.08,
    shadowRadius:  14,
    shadowOffset:  { width: 0, height: 6 },
    elevation:     4,
  },
};
