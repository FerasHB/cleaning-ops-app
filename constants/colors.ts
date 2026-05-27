// constants/colors.ts
// ─────────────────────────────────────────────────────────────────
// Rohe Farbwerte für Light- und Dark-Theme.
// Diese Datei NICHT direkt in Screens oder Komponenten importieren.
// Stattdessen immer useAppTheme() verwenden → theme.colors.*
// ─────────────────────────────────────────────────────────────────

/**
 * Gemeinsamer Typ für beide Color-Paletten.
 * Definiert als Interface mit string-Typen — kompatibel mit light & dark.
 */
export interface ColorPalette {
  // Hintergründe (Tonal Layering: von dunkel → hell)
  background:               string;
  surface:                  string;
  surfaceContainer:         string;
  surfaceContainerHigh:     string;
  surfaceContainerHighest:  string;

  // Text
  onSurface:        string;
  onSurfaceVariant: string;
  outline:          string;
  outlineVariant:   string;

  // Brand / Primär
  primary:            string;
  primaryContainer:   string;
  onPrimary:          string;
  onPrimaryContainer: string;

  // Status: Offen (Amber/Orange)
  statusOpen:       string;
  statusOpenBg:     string;
  statusOpenBorder: string;

  // Status: In Arbeit (Blau)
  statusInProgress:       string;
  statusInProgressBg:     string;
  statusInProgressBorder: string;

  // Status: Erledigt (Grün)
  statusCompleted:       string;
  statusCompletedBg:     string;
  statusCompletedBorder: string;

  // Fehler
  error:          string;
  errorContainer: string;
  onError:        string;

  // Utility
  white:       string;
  black:       string;
  transparent: string;
}

// ── Dark Palette (basiert auf Stitch CleanOps Utility System)
export const darkColors: ColorPalette = {
  background:               '#0B1326',
  surface:                  '#131B2E',
  surfaceContainer:         '#171F33',
  surfaceContainerHigh:     '#222A3D',
  surfaceContainerHighest:  '#2D3449',

  onSurface:        '#DAE2FD',
  onSurfaceVariant: '#C2C6D6',
  outline:          '#8C909F',
  outlineVariant:   '#424754',

  primary:            '#ADC6FF',
  primaryContainer:   '#4D8EFF',
  onPrimary:          '#002E6A',
  onPrimaryContainer: '#FFFFFF',

  statusOpen:       '#F59E0B',
  statusOpenBg:     'rgba(245,158,11,0.12)',
  statusOpenBorder: 'rgba(245,158,11,0.30)',

  statusInProgress:       '#ADC6FF',
  statusInProgressBg:     'rgba(173,198,255,0.12)',
  statusInProgressBorder: 'rgba(173,198,255,0.30)',

  statusCompleted:       '#22C55E',
  statusCompletedBg:     'rgba(34,197,94,0.12)',
  statusCompletedBorder: 'rgba(34,197,94,0.30)',

  error:          '#FFB4AB',
  errorContainer: '#93000A',
  onError:        '#690005',

  white:       '#FFFFFF',
  black:       '#000000',
  transparent: 'transparent',
};

// ── Light Palette (professionelle SaaS-Ableitung des Dark Themes)
export const lightColors: ColorPalette = {
  background:               '#F0F2F5',
  surface:                  '#FFFFFF',
  surfaceContainer:         '#F7F8FA',
  surfaceContainerHigh:     '#ECEEF2',
  surfaceContainerHighest:  '#E2E5EB',

  onSurface:        '#0F172A',
  onSurfaceVariant: '#475569',
  outline:          '#94A3B8',
  outlineVariant:   '#CBD5E1',

  primary:            '#2563EB',
  primaryContainer:   '#1E40AF',
  onPrimary:          '#FFFFFF',
  onPrimaryContainer: '#FFFFFF',

  statusOpen:       '#D97706',
  statusOpenBg:     '#FEF3C7',
  statusOpenBorder: '#FDE68A',

  statusInProgress:       '#2563EB',
  statusInProgressBg:     '#DBEAFE',
  statusInProgressBorder: '#BFDBFE',

  statusCompleted:       '#16A34A',
  statusCompletedBg:     '#DCFCE7',
  statusCompletedBorder: '#BBF7D0',

  error:          '#DC2626',
  errorContainer: '#FEE2E2',
  onError:        '#FFFFFF',

  white:       '#FFFFFF',
  black:       '#000000',
  transparent: 'transparent',
};
