// constants/theme.ts – Premium Design System
// Inspiriert von Linear, Stripe, Vercel – dark-first, tiefes Farbsystem

export const Colors = {
  bg: {
    base: "#080809",        // Tiefstes Schwarz – App-Hintergrund
    surface: "#0F0F11",     // Karten, Inputs
    elevated: "#161618",    // Modals, Dropdowns
    overlay: "#1C1C1F",     // Hover / aktive Zustände
    glass: "rgba(22,22,24,0.85)", // Glassmorphism für Header
  },

  accent: {
    default: "#6366F1",     // Indigo – kräftiger, moderner als reines Blau
    hover: "#4F46E5",
    glow: "rgba(99,102,241,0.2)",
    subtle: "rgba(99,102,241,0.12)",
    muted: "rgba(99,102,241,0.08)",
    text: "#A5B4FC",        // Helles Indigo für Text
    border: "rgba(99,102,241,0.35)",
  },

  status: {
    success: "#34D399",
    successBg: "rgba(52,211,153,0.1)",
    successBorder: "rgba(52,211,153,0.25)",
    warning: "#FBBF24",
    warningBg: "rgba(251,191,36,0.1)",
    warningBorder: "rgba(251,191,36,0.25)",
    danger: "#F87171",
    dangerBg: "rgba(248,113,113,0.1)",
    dangerBorder: "rgba(248,113,113,0.25)",
    info: "#60A5FA",
    infoBg: "rgba(96,165,250,0.1)",
  },

  text: {
    primary: "#FAFAFA",
    secondary: "#A0A0A8",
    muted: "#52525B",
    placeholder: "#3F3F46",
    inverse: "#09090B",
  },

  border: {
    default: "rgba(255,255,255,0.07)",
    subtle: "rgba(255,255,255,0.04)",
    strong: "rgba(255,255,255,0.12)",
    focus: "#6366F1",
    focusGlow: "rgba(99,102,241,0.4)",
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
  xxxxl: 40,
};

export const Radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 32,
  full: 9999,
};

export const Typography = {
  size: {
    xs: 11,
    sm: 13,
    base: 15,
    md: 17,
    lg: 20,
    xl: 24,
    xxl: 30,
    xxxl: 36,
  },
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
    extrabold: "800" as const,
  },
  leading: {
    tight: 1.15,
    snug: 1.3,
    normal: 1.5,
    relaxed: 1.7,
  },
  tracking: {
    tight: -0.5,
    normal: 0,
    wide: 0.3,
    wider: 0.6,
  },
};

export const Shadows = {
  sm: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  md: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 8,
  },
  lg: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 28,
    elevation: 14,
  },
  accent: {
    shadowColor: "#6366F1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
};

// Gradient-Tokens (für LinearGradient, falls expo-linear-gradient verwendet wird)
export const Gradients = {
  accentH: ["#6366F1", "#8B5CF6"],
  accentV: ["#6366F1", "#4F46E5"],
  surface: ["#161618", "#0F0F11"],
  subtle: ["rgba(99,102,241,0.15)", "rgba(99,102,241,0)"],
};