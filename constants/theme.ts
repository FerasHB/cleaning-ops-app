// constants/theme.ts
export const Colors = {
  white: "#FFFFFF",
  black: "#111827",

  bg: {
    app: "#F7F8FA",
    surface: "#FFFFFF",
    elevated: "#F3F4F6",
    overlay: "#F9FAFB",
    base: "#F3F4F6",
  },

  text: {
    primary: "#111827",
    secondary: "#4B5563",
    muted: "#6B7280",
  },

  border: {
    default: "#E5E7EB",
    subtle: "#EEF0F3",
    strong: "#D1D5DB",
  },

  accent: {
    default: "#2563EB",
    text: "#1D4ED8",
    subtle: "#DBEAFE",
    muted: "#93C5FD",
    border: "#BFDBFE",
  },

  status: {
  warning: "#B45309",
  warningBg: "#FEF3C7",
  success: "#166534",
  successBg: "#DCFCE7",
  neutral: "#374151",
  neutralBg: "#E5E7EB",
  danger: "#DC2626",
  dangerBg: "#FEE2E2",
}
};

export const Spacing = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 32,
};

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
};

export const Typography = {
  size: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 22,
    xxl: 28,
    base: 16,
  },
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
    extrabold: "800" as const,
  },
  leading: {
    tight: 1.2,
    normal: 1.4,
    relaxed: 1.6,
  },
  tracking: {
    tight: -0.3,
    normal: 0,
    wide: 0.5,
    wider: 0.8,
  },
};

export const Shadows = {
  sm: {
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  md: {
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  lg: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
};