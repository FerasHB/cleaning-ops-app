// components/ui/AnimatedSplash.tsx
// ─────────────────────────────────────────────────────────────────
// Premium, markengebundener Splash-/Boot-Screen für "TaskOps Manager".
//
// REIN VISUELL — enthält KEINE Auth-/Profil-Logik. Wann die App bereit ist
// und der Splash verschwinden darf, entscheidet die Bootstrap-Schicht
// (SplashGate in app/_layout.tsx). Diese Komponente kennt nur zwei Signale:
//   • `exiting`        → Exit-Animation abspielen (Fade + leichtes Scale-down)
//   • `onExitComplete` → wird GENAU EINMAL nach Ende der Exit-Animation gerufen
//
// Bewusst THEME-UNABHÄNGIG (immer Dark-Brand) — ein Splash soll wie ein festes
// Markenerlebnis wirken, nicht dem System-Color-Scheme folgen.
//
// Baut ausschließlich auf bereits vorhandenen Abhängigkeiten auf:
//   • react-native (View/Text/Image)
//   • react-native-reanimated (Animationen, useReducedMotion)
//   • das offizielle Logo-Asset assets/images/splash-icon.png
// → KEINE neuen nativen Module (kein Gradient-/Blur-/SVG-Paket).
//
// Reduced Motion (Bedienungshilfen): keine kontinuierliche Partikel-/Rotations-
// Bewegung, stattdessen einfache Fades; der Ladering pulsiert nur noch dezent.
// ─────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Dimensions, Image, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

// Offizielles TaskOps-Manager-Logo (identisch zum nativen Splash → nahtloser
// Übergang). Relativer Pfad, damit Metro das Asset zuverlässig auflöst.
const LOGO = require("../../assets/images/splash-icon.png");

// ── Marken-Palette (fix, unabhängig vom System-Theme) ──────────────
const C = {
  bg: "#0B1220", // sehr dunkler, leicht bläulicher Hintergrund
  primary: "#2563EB", // Blau
  secondary: "#06B6D4", // Cyan
  accent: "#10B981", // Emerald
  textPrimary: "#EEF2FF", // fast-weiß
  textMuted: "#8A97B4", // gedämpftes Slate-Blau
  hairline: "rgba(255,255,255,0.045)",
} as const;

// Farbverlaufs-Stops des Laderings (Blau → Cyan → Emerald)
const RING_STOPS = [C.primary, C.secondary, C.accent] as const;

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const AnimatedView = Animated.View;

// ═══════════════════════════════════════════════════════════════
// Kleine Farb-Helfer (JS-Thread) für den Ladering-Verlauf.
// ═══════════════════════════════════════════════════════════════
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
/** Interpoliert t∈[0,1] über die Ring-Stops (Blau→Cyan→Emerald). */
function ringColor(t: number): string {
  const seg = t * (RING_STOPS.length - 1);
  const i = Math.min(RING_STOPS.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = hexToRgb(RING_STOPS[i]);
  const b = hexToRgb(RING_STOPS[i + 1]);
  return rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

// ═══════════════════════════════════════════════════════════════
// SoftGlow — weicher radialer Lichtschein ohne Gradient-Bibliothek.
// Trick: mehrere konzentrische Kreise mit fallender Deckkraft ergeben
// einen radialen Falloff (weiche Kante) auf dunklem Grund.
// ═══════════════════════════════════════════════════════════════
function SoftGlow({
  size,
  color,
  x,
  y,
  intensity = 0.5,
}: {
  size: number;
  color: string;
  x: number;
  y: number;
  intensity?: number;
}) {
  const rings = [1, 0.78, 0.56, 0.36, 0.2];
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {rings.map((r, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            width: size * r,
            height: size * r,
            borderRadius: (size * r) / 2,
            backgroundColor: color,
            opacity: intensity * (0.12 + i * 0.06),
          }}
        />
      ))}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════
// Particle — leiser, langsam driftender & funkelnder Lichtpunkt.
// Wird nur bei erlaubter Bewegung gerendert (siehe reduceMotion).
// ═══════════════════════════════════════════════════════════════
type ParticleCfg = {
  x: number;
  y: number;
  size: number;
  drift: number;
  duration: number;
  delay: number;
  color: string;
  baseOpacity: number;
};

function Particle({ cfg }: { cfg: ParticleCfg }) {
  const p = useSharedValue(0);

  useEffect(() => {
    p.value = withDelay(
      cfg.delay,
      withRepeat(
        withTiming(1, { duration: cfg.duration, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(p);
  }, [cfg.delay, cfg.duration, p]);

  const style = useAnimatedStyle(() => ({
    opacity: cfg.baseOpacity + p.value * cfg.baseOpacity * 1.6,
    transform: [{ translateY: -cfg.drift * p.value }, { scale: 0.7 + p.value * 0.5 }],
  }));

  return (
    <AnimatedView
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: cfg.x,
          top: cfg.y,
          width: cfg.size,
          height: cfg.size,
          borderRadius: cfg.size / 2,
          backgroundColor: cfg.color,
        },
        style,
      ]}
    />
  );
}

// ═══════════════════════════════════════════════════════════════
// LoadingRing — dezenter, langsam rotierender Ring mit Blau→Cyan→
// Emerald-Verlauf. Ohne SVG: der Verlauf entsteht aus vielen kleinen
// Segmenten (Farbe + Deckkraft interpoliert), die als Kometen-Bogen um
// den Kreis liegen; die ganze Segment-Ebene rotiert.
// Reduced Motion: keine Rotation, nur ein sanftes Opacity-Pulsieren.
// ═══════════════════════════════════════════════════════════════
const RING_D = 58; // Durchmesser
const RING_SEGMENTS = 22;

function LoadingRing({ reduceMotion }: { reduceMotion: boolean }) {
  const spin = useSharedValue(0);
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      pulse.value = withRepeat(
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      spin.value = withRepeat(
        withTiming(1, { duration: 2600, easing: Easing.linear }),
        -1,
        false,
      );
    }
    return () => {
      cancelAnimation(spin);
      cancelAnimation(pulse);
    };
  }, [reduceMotion, spin, pulse]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));
  const pulseStyle = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));

  const segments = useMemo(() => {
    const items: { angle: number; color: string; opacity: number }[] = [];
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const t = i / (RING_SEGMENTS - 1);
      items.push({
        angle: (360 / RING_SEGMENTS) * i,
        color: ringColor(t),
        // Kometen-Rampe: heller "Kopf", weich auslaufender "Schweif"
        opacity: 0.18 + 0.82 * t,
      });
    }
    return items;
  }, []);

  return (
    <View
      style={styles.ringBox}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* dezente Vollkreis-Bahn */}
      <View style={styles.ringTrack} />
      {/* Segment-Ebene (rotiert bzw. pulsiert) */}
      <AnimatedView
        style={[StyleSheet.absoluteFill, reduceMotion ? pulseStyle : spinStyle]}
      >
        {segments.map((s, i) => (
          <View
            key={i}
            style={[styles.segWrap, { transform: [{ rotate: `${s.angle}deg` }] }]}
          >
            <View
              style={[
                styles.segBar,
                {
                  backgroundColor: s.color,
                  opacity: reduceMotion ? Math.max(0.3, s.opacity) : s.opacity,
                },
              ]}
            />
          </View>
        ))}
      </AnimatedView>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════
// AnimatedSplash — Hauptkomponente (rein visuell)
// ═══════════════════════════════════════════════════════════════
type AnimatedSplashProps = {
  /** true → Exit-Animation abspielen. */
  exiting?: boolean;
  /** Wird GENAU EINMAL aufgerufen, wenn die Exit-Animation fertig ist. */
  onExitComplete?: () => void;
};

export function AnimatedSplash({ exiting = false, onExitComplete }: AnimatedSplashProps) {
  const reduceMotion = useReducedMotion();

  // Logo + dunkler Grund erscheinen SOFORT (nahtlos aus dem nativen Splash);
  // nur Wortmarke & Ladebereich animieren dezent ein.
  const wordIn = useSharedValue(0); // Wortmarke: Fade (+ Rise, wenn Motion)
  const uiIn = useSharedValue(0); // Ladebereich: Fade
  const breathe = useSharedValue(0); // Logo-Glow: sanftes Atmen (nur Motion)
  const exit = useSharedValue(0); // Exit: 0 → 1

  const startedRef = useRef(false); // Exit bereits gestartet? (Start-Guard)
  const exitedRef = useRef(false); // Abschluss bereits gemeldet? (Finish-Guard)

  // Meldet den Exit-Abschluss GENAU EINMAL zurück. Bewusst als JS-Callback
  // (nicht im withTiming-Worklet): eine im Worklet gelesene/gesetzte React-Ref
  // liegt dort nur als UI-Thread-Kopie vor — Mutationen wirken NICHT zum
  // JS-Thread zurück, der Guard wäre also wirkungslos.
  const finishExit = useCallback(() => {
    if (exitedRef.current) return;
    exitedRef.current = true;
    onExitComplete?.();
  }, [onExitComplete]);

  // ── Eintritt + Endlos-Loops ────────────────────────────────────
  useEffect(() => {
    wordIn.value = withDelay(
      reduceMotion ? 60 : 200,
      withTiming(1, { duration: reduceMotion ? 260 : 560, easing: Easing.out(Easing.cubic) }),
    );
    uiIn.value = withDelay(
      reduceMotion ? 120 : 460,
      withTiming(1, { duration: reduceMotion ? 260 : 460, easing: Easing.out(Easing.quad) }),
    );
    if (!reduceMotion) {
      breathe.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    }
    return () => {
      cancelAnimation(wordIn);
      cancelAnimation(uiIn);
      cancelAnimation(breathe);
    };
  }, [reduceMotion, wordIn, uiIn, breathe]);

  // ── Exit-Animation (einmalig, meldet Abschluss zurück) ──────────
  useEffect(() => {
    if (!exiting || startedRef.current) return;
    startedRef.current = true;
    exit.value = withTiming(
      1,
      { duration: 420, easing: Easing.inOut(Easing.cubic) },
      (finished) => {
        "worklet";
        if (finished) {
          runOnJS(finishExit)();
        }
      },
    );
  }, [exiting, exit, finishExit]);

  // ── Partikel einmalig deterministisch verteilen (nur bei Motion) ─
  const particles = useMemo<ParticleCfg[]>(() => {
    const palette = [C.primary, C.secondary, C.accent, "#FFFFFF"];
    const items: ParticleCfg[] = [];
    const count = 16;
    for (let i = 0; i < count; i++) {
      const rx = ((i * 97 + 31) % 100) / 100;
      const ry = ((i * 53 + 17) % 100) / 100;
      items.push({
        x: rx * SCREEN_W,
        y: ry * SCREEN_H,
        size: 1.5 + ((i * 7) % 3),
        drift: 18 + ((i * 13) % 26),
        duration: 2600 + ((i * 197) % 2600),
        delay: (i * 173) % 1800,
        color: palette[i % palette.length],
        baseOpacity: 0.1 + ((i * 3) % 5) / 40,
      });
    }
    return items;
  }, []);

  // ── Animierte Styles ────────────────────────────────────────────
  const rootStyle = useAnimatedStyle(() => ({
    opacity: 1 - exit.value,
    transform: [{ scale: reduceMotion ? 1 : 1 - 0.02 * exit.value }],
  }));

  const logoGlowStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.55 : 0.5 + breathe.value * 0.4,
    transform: [{ scale: reduceMotion ? 1 : 0.94 + breathe.value * 0.1 }],
  }));

  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordIn.value,
    transform: [{ translateY: reduceMotion ? 0 : (1 - wordIn.value) * 14 }],
  }));

  const uiStyle = useAnimatedStyle(() => ({ opacity: uiIn.value }));

  const breatheTop = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.8 : 0.75 + breathe.value * 0.25,
  }));
  const breatheBottom = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.65 : 0.55 + (1 - breathe.value) * 0.3,
  }));

  return (
    <AnimatedView
      style={[styles.root, rootStyle]}
      // Ganzer Splash = EIN Screenreader-Element mit einem Label (statt „TaskOps",
      // „MANAGER" u. dekorative Teile einzeln vorzulesen). Kein progressbar-Role:
      // ein unbestimmter Ladezustand ohne Wert würde sonst als „0 %" angesagt.
      // accessibilityViewIsModal hält VoiceOver auf dem Splash, nicht auf der
      // darunter bootenden App.
      accessible
      accessibilityViewIsModal
      accessibilityLabel="TaskOps Manager wird geladen"
    >
      {/* ── Hintergrund: Umgebungs-Glows (atmend bei Motion) ─────── */}
      <AnimatedView
        style={[StyleSheet.absoluteFill, breatheTop]}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
      >
        <SoftGlow
          size={SCREEN_W * 1.5}
          color={C.primary}
          x={SCREEN_W * 0.5}
          y={SCREEN_H * 0.28}
          intensity={0.55}
        />
      </AnimatedView>
      <AnimatedView
        style={[StyleSheet.absoluteFill, breatheBottom]}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
      >
        <SoftGlow
          size={SCREEN_W * 1.15}
          color={C.secondary}
          x={SCREEN_W * 0.18}
          y={SCREEN_H * 0.82}
          intensity={0.4}
        />
        <SoftGlow
          size={SCREEN_W * 1.0}
          color={C.accent}
          x={SCREEN_W * 0.9}
          y={SCREEN_H * 0.72}
          intensity={0.28}
        />
      </AnimatedView>

      {/* ── Faint abstrakte Geometrie (statische Struktur) ───────── */}
      <View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.geoShape,
          { top: SCREEN_H * 0.1, left: -SCREEN_W * 0.28, transform: [{ rotate: "18deg" }] },
        ]}
      />
      <View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.geoShape,
          { bottom: SCREEN_H * 0.06, right: -SCREEN_W * 0.3, transform: [{ rotate: "-14deg" }] },
        ]}
      />

      {/* ── Partikel (nur bei erlaubter Bewegung) ────────────────── */}
      {!reduceMotion && particles.map((cfg, i) => <Particle key={i} cfg={cfg} />)}

      {/* ── Zentrum: Logo + Wortmarke + Ladering ─────────────────── */}
      <View style={styles.center} pointerEvents="none">
        {/* Logo mit restrained Außen-Glow */}
        <View style={styles.logoBlock}>
          <AnimatedView pointerEvents="none" style={[styles.logoGlow, logoGlowStyle]}>
            <SoftGlow size={230} color={C.primary} x={115} y={115} intensity={0.55} />
          </AnimatedView>

          <Image
            source={LOGO}
            style={styles.logo}
            resizeMode="contain"
            // Android blendet Bilder sonst ~300 ms ein — hier unerwünscht, das
            // Logo muss zum nahtlosen Übergang aus dem nativen Splash SOFORT da
            // sein. Dekorativ → aus dem Screenreader-Fokus nehmen (Root gruppiert).
            fadeDuration={0}
            accessible={false}
          />
        </View>

        {/* Wortmarke */}
        <AnimatedView style={[styles.wordWrap, wordStyle]}>
          <Text style={styles.wordTask}>TaskOps</Text>
          <Text style={styles.wordManager}>MANAGER</Text>
        </AnimatedView>

        {/* dünne Trennlinie + Ladering */}
        <AnimatedView style={[styles.loaderWrap, uiStyle]}>
          <View style={styles.divider} />
          <LoadingRing reduceMotion={reduceMotion} />
        </AnimatedView>
      </View>
    </AnimatedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    overflow: "hidden",
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },

  // Faint geometrische Formen im Hintergrund
  geoShape: {
    position: "absolute",
    width: SCREEN_W * 0.9,
    height: SCREEN_W * 0.9,
    borderRadius: 48,
    borderWidth: 1,
    borderColor: C.hairline,
  },

  // Logo (offizielles Asset, resizeMode contain)
  logoBlock: {
    width: 210,
    height: 210,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 26,
  },
  logoGlow: {
    position: "absolute",
    width: 230,
    height: 230,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 210,
    height: 210,
  },

  // Wortmarke
  wordWrap: {
    alignItems: "center",
  },
  wordTask: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 32,
    letterSpacing: -0.6,
    color: C.textPrimary,
  },
  wordManager: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    letterSpacing: 7,
    color: C.textMuted,
    marginTop: 8,
    marginLeft: 7, // optischer Ausgleich zum Letter-Spacing
  },

  // Ladebereich
  loaderWrap: {
    marginTop: 40,
    alignItems: "center",
  },
  divider: {
    width: 44,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginBottom: 22,
  },

  // Ladering
  ringBox: {
    width: RING_D,
    height: RING_D,
    alignItems: "center",
    justifyContent: "center",
  },
  ringTrack: {
    position: "absolute",
    width: RING_D,
    height: RING_D,
    borderRadius: RING_D / 2,
    borderWidth: 2.5,
    borderColor: "rgba(255,255,255,0.06)",
  },
  segWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  segBar: {
    width: 2.5,
    height: 6,
    borderRadius: 2,
  },
});

export default AnimatedSplash;
