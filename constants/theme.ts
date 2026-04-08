// theme.ts – Zentrales Design-System
// Alle Werte nur hier ändern, nicht in den einzelnen Screens

export const Colors = {
  // Hintergründe (von dunkel → weniger dunkel)
  bg: {
    base: "#0A0A0B",       // App-Hintergrund
    surface: "#111113",    // Karten, Inputs
    elevated: "#18181B",   // Dropdowns, Modals
    overlay: "#222226",    // Hover-Zustände
  },

  // Akzentfarbe (Blau)
  accent: {
    default: "#3B82F6",    // Primärer Button, Links
    hover: "#2563EB",      // Hover-Zustand
    subtle: "#1D3461",     // Subtiler Hintergrund
    text: "#93C5FD",       // Text auf dunklem Hintergrund
  },

  // Status-Farben
  status: {
    success: "#22C55E",
    successBg: "#14532D",
    warning: "#F59E0B",
    warningBg: "#78350F",
    danger: "#EF4444",
    dangerBg: "#7F1D1D",
  },

  // Text-Hierarchie
  text: {
    primary: "#F4F4F5",    // Haupttext
    secondary: "#A1A1AA",  // Nebentext
    muted: "#52525B",      // Sehr schwach
    inverse: "#09090B",    // Text auf hellem Hintergrund
  },

  // Rahmen
  border: {
    default: "#27272A",    // Standard-Border
    subtle: "#1C1C1F",     // Sehr schwache Border
    focus: "#3B82F6",      // Fokus-Zustand
  },

  white: "#FFFFFF",
  transparent: "transparent",
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
};

export const Typography = {
  // Größen
  size: {
    xs: 11,
    sm: 13,
    base: 15,
    md: 17,
    lg: 20,
    xl: 24,
    xxl: 28,
    xxxl: 34,
  },

  // Gewichte
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
    extrabold: "800" as const,
  },

  // Zeilenhöhen
  leading: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.7,
  },
};

// Wiederverwendbare Schatten-Presets
export const Shadows = {
  sm: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
};