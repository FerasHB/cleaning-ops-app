import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont("normal", {
  weights: ["500", "600", "700", "800", "900"],
  subsets: ["latin", "latin-ext"],
});

export const FONT = fontFamily;

// Markenfarben, abgeleitet aus Logo + Vorstellungsgrafik
export const C = {
  bg: "#050A16",
  bg2: "#0A1630",
  navy: "#0F1E46",
  cyan: "#25C3F5",
  blue: "#2F6BFF",
  orange: "#FF8A3D",
  green: "#22C55E",
  white: "#F5F8FF",
  muted: "#9AA9CB",
};

export const SCREEN_W = 1290;
export const SCREEN_H = 2796;

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const ease = Easing.bezier(0.22, 1, 0.36, 1);

/** Interpoliert über eine Keyframe-Liste mit Ease-Out zwischen den Punkten. */
export const kf = (frame: number, input: number[], output: number[]) =>
  interpolate(frame, input, output, { ...clamp, easing: ease });

// ------------------------------------------------------------ Hintergrund
export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const x1 = 30 + Math.sin(t * 0.5) * 18;
  const y1 = 22 + Math.cos(t * 0.4) * 10;
  const x2 = 75 + Math.cos(t * 0.45) * 15;
  const y2 = 78 + Math.sin(t * 0.35) * 10;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(170deg, ${C.bg2} 0%, ${C.bg} 55%, #03060E 100%)` }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${x1}% ${y1}%, rgba(47,107,255,0.38) 0%, rgba(47,107,255,0) 42%),
                       radial-gradient(circle at ${x2}% ${y2}%, rgba(37,195,245,0.28) 0%, rgba(37,195,245,0) 45%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.10) 1.6px, transparent 1.6px)",
          backgroundSize: "44px 44px",
          backgroundPosition: `0px ${-(frame * 0.6) % 44}px`,
          maskImage: "linear-gradient(180deg, rgba(0,0,0,0.9), rgba(0,0,0,0) 70%)",
          WebkitMaskImage: "linear-gradient(180deg, rgba(0,0,0,0.9), rgba(0,0,0,0) 70%)",
        }}
      />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------ Szenen-Hülle
/** Ein-/Ausblendung jeder Szene: Scale + Blur, damit Szenen weich überlappen. */
export const SceneShell: React.FC<{
  frames: number;
  enter?: boolean;
  children: React.ReactNode;
}> = ({ frames, enter = true, children }) => {
  const frame = useCurrentFrame();
  const inP = enter ? kf(frame, [0, 10], [0, 1]) : 1;
  const outP = kf(frame, [frames - 2, frames + 8], [0, 1]);
  const opacity = inP * (1 - outP);
  const scale = (enter ? interpolate(inP, [0, 1], [1.06, 1]) : 1) * interpolate(outP, [0, 1], [1, 0.94]);
  const blur = (1 - inP) * 14 + outP * 14;
  return (
    <AbsoluteFill style={{ opacity, transform: `scale(${scale})`, filter: blur > 0.2 ? `blur(${blur}px)` : undefined }}>
      {children}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------ Text
type Word = string | { t: string; accent?: string };

/** Kinetische Headline: Wörter steigen gestaffelt mit Spring + Blur ein. */
export const Headline: React.FC<{
  lines: Word[][];
  delay?: number;
  top?: number;
  size?: number;
  align?: "center" | "left";
  exitAt?: number;
}> = ({ lines, delay = 0, top = 170, size = 104, align = "center", exitAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let idx = 0;
  const exit = exitAt !== undefined ? kf(frame, [exitAt, exitAt + 10], [0, 1]) : 0;
  return (
    <div
      style={{
        position: "absolute",
        top,
        left: 60,
        right: 60,
        textAlign: align,
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: size,
        lineHeight: 1.04,
        letterSpacing: -size * 0.035,
        color: C.white,
        opacity: 1 - exit,
        transform: `translateY(${-exit * 40}px)`,
        filter: exit > 0 ? `blur(${exit * 10}px)` : undefined,
      }}
    >
      {lines.map((line, li) => (
        <div key={li} style={{ whiteSpace: "nowrap" }}>
          {line.map((w, wi) => {
            const word = typeof w === "string" ? { t: w } : w;
            const d = delay + idx++ * 3;
            const p = spring({ frame: frame - d, fps, config: { damping: 15, mass: 0.6, stiffness: 140 } });
            return (
              <span
                key={wi}
                style={{
                  display: "inline-block",
                  marginRight: size * 0.24,
                  color: word.accent ?? C.white,
                  opacity: interpolate(p, [0, 0.6], [0, 1], clamp),
                  transform: `translateY(${(1 - p) * 70}px) scale(${0.9 + p * 0.1})`,
                  filter: `blur(${(1 - Math.min(p, 1)) * 12}px)`,
                }}
              >
                {word.t}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** Kleine Großbuchstaben-Pille über der Headline. */
export const Kicker: React.FC<{ text: string; top?: number; delay?: number; color?: string }> = ({
  text,
  top = 100,
  delay = 0,
  color = C.cyan,
}) => {
  const frame = useCurrentFrame();
  const p = kf(frame, [delay, delay + 12], [0, 1]);
  return (
    <div style={{ position: "absolute", top, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 700,
          fontSize: 28,
          letterSpacing: 6,
          color,
          padding: "10px 24px",
          borderRadius: 999,
          border: `2px solid ${color}55`,
          background: `${color}14`,
          opacity: p,
          transform: `translateY(${(1 - p) * -20}px)`,
        }}
      >
        {text}
      </div>
    </div>
  );
};

// ------------------------------------------------------------ Icons (Lucide-Stil)
const ICONS: Record<string, React.ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  repeat: (
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  wifiOff: (
    <>
      <path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76" />
      <path d="m2 2 20 20" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  medical: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  pulse: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  play: <path d="m6 3 14 9-14 9z" />,
  arrow: <path d="M5 12h14M12 5l7 7-7 7" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </>
  ),
};

export const Icon: React.FC<{ name: keyof typeof ICONS | string; size?: number; color?: string; stroke?: number }> = ({
  name,
  size = 32,
  color = "currentColor",
  stroke = 2.4,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    {ICONS[name]}
  </svg>
);

// ------------------------------------------------------------ Chip / Callout
export const Chip: React.FC<{
  text: string;
  icon?: string;
  x: number;
  y: number;
  delay: number;
  color?: string;
  until?: number;
  size?: number;
  anchor?: "left" | "center" | "right";
}> = ({ text, icon, x, y, delay, color = C.cyan, until, size = 38, anchor = "center" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 12, stiffness: 180, mass: 0.6 } });
  const out = until !== undefined ? kf(frame, [until, until + 8], [0, 1]) : 0;
  const tx = anchor === "center" ? "-50%" : anchor === "right" ? "-100%" : "0%";
  const floatY = Math.sin((frame - delay) / 14) * 4;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translate(${tx}, -50%) translateY(${floatY}px) scale(${Math.max(0, p) * (1 - out * 0.3)})`,
        opacity: Math.min(1, p * 2) * (1 - out),
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: `${size * 0.42}px ${size * 0.7}px`,
        borderRadius: 999,
        background: "rgba(10,20,45,0.82)",
        border: `2px solid ${color}88`,
        boxShadow: `0 18px 50px rgba(0,0,0,0.45), 0 0 40px ${color}33`,
        backdropFilter: "blur(14px)",
        fontFamily: FONT,
        fontWeight: 700,
        fontSize: size,
        color: C.white,
        whiteSpace: "nowrap",
      }}
    >
      {icon ? (
        <div
          style={{
            width: size * 1.35,
            height: size * 1.35,
            borderRadius: 999,
            background: color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={size * 0.8} color="#04101F" stroke={2.8} />
        </div>
      ) : null}
      {text}
    </div>
  );
};

// ------------------------------------------------------------ Phone + Kamera
export type Cam = { fx: number; fy: number; cx: number; cy: number; s: number; r?: number };

/**
 * Smartphone mit echtem Screenshot. Die Kamera legt den Screenshot-Punkt (fx, fy)
 * auf die Bildschirmposition (cx, cy) und skaliert um genau diesen Punkt.
 */
export const Phone: React.FC<{
  src: string;
  cam: Cam;
  width?: number;
  overlaySrc?: string;
  overlayOpacity?: number;
  opacity?: number;
  children?: React.ReactNode;
}> = ({ src, cam, width = 720, overlaySrc, overlayOpacity = 0, opacity = 1, children }) => {
  const k = width / SCREEN_W;
  const h = SCREEN_H * k;
  const bezel = width * 0.028;
  const radius = width * 0.135;
  return (
    <div
      style={{
        position: "absolute",
        left: cam.cx,
        top: cam.cy,
        transformOrigin: "0 0",
        transform: `scale(${cam.s}) rotate(${cam.r ?? 0}deg)`,
        opacity,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -cam.fx * k - bezel,
          top: -cam.fy * k - bezel,
          width: width + bezel * 2,
          height: h + bezel * 2,
          borderRadius: radius + bezel,
          background: "linear-gradient(145deg, #2A3348, #0B0F1A 40%, #1C2333)",
          padding: bezel,
          boxShadow: "0 60px 120px rgba(0,0,0,0.65), 0 0 0 2px rgba(255,255,255,0.08), 0 0 90px rgba(47,107,255,0.25)",
        }}
      >
        <div style={{ position: "relative", width, height: h, borderRadius: radius, overflow: "hidden", background: "#EEF1F6" }}>
          <Img src={staticFile(src)} style={{ position: "absolute", width, height: h }} />
          {overlaySrc ? (
            <Img src={staticFile(overlaySrc)} style={{ position: "absolute", width, height: h, opacity: overlayOpacity }} />
          ) : null}
          {/* Dynamic Island */}
          <div
            style={{
              position: "absolute",
              top: width * 0.03,
              left: "50%",
              width: width * 0.29,
              height: width * 0.085,
              marginLeft: -width * 0.145,
              borderRadius: 999,
              background: "#000",
            }}
          />
          {/* Glanz */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(115deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 28%)",
            }}
          />
          {/* Kinder werden in Screenshot-Pixeln positioniert */}
          <div style={{ position: "absolute", left: 0, top: 0, width: SCREEN_W, height: SCREEN_H, transform: `scale(${k})`, transformOrigin: "0 0" }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Interpoliert zwischen Kamera-Keyframes. */
export const camAt = (frame: number, keys: { f: number; cam: Cam }[]): Cam => {
  const fs = keys.map((k) => k.f);
  const pick = (sel: (c: Cam) => number) => kf(frame, fs, keys.map((k) => sel(k.cam)));
  return {
    fx: pick((c) => c.fx),
    fy: pick((c) => c.fy),
    cx: pick((c) => c.cx),
    cy: pick((c) => c.cy),
    s: pick((c) => c.s),
    r: pick((c) => c.r ?? 0),
  };
};

/** Hervorhebungsrahmen in Screenshot-Koordinaten (Kind von <Phone>). */
export const Highlight: React.FC<{ x: number; y: number; w: number; h: number; delay: number; color?: string; radius?: number }> = ({
  x,
  y,
  w,
  h,
  delay,
  color = C.cyan,
  radius = 40,
}) => {
  const frame = useCurrentFrame();
  const p = kf(frame, [delay, delay + 12], [0, 1]);
  const pulse = 0.5 + 0.5 * Math.sin((frame - delay) / 6);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: radius,
        border: `8px solid ${color}`,
        boxShadow: `0 0 ${30 + pulse * 30}px ${color}AA, inset 0 0 30px ${color}33`,
        opacity: p,
        transform: `scale(${1.08 - p * 0.08})`,
      }}
    />
  );
};

/** Tap-Ripple in Screenshot-Koordinaten (Kind von <Phone>). */
export const Tap: React.FC<{ x: number; y: number; at: number }> = ({ x, y, at }) => {
  const frame = useCurrentFrame();
  const f = frame - at;
  if (f < -10 || f > 26) return null;
  const finger = kf(frame, [at - 10, at, at + 6, at + 20], [0, 1, 1, 0]);
  const ring = interpolate(f, [0, 22], [0, 1], clamp);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x - 260 * ring,
          top: y - 260 * ring,
          width: 520 * ring,
          height: 520 * ring,
          borderRadius: 999,
          border: "10px solid rgba(37,195,245,0.9)",
          opacity: f >= 0 ? 1 - ring : 0,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: x - 70,
          top: y - 70,
          width: 140,
          height: 140,
          borderRadius: 999,
          background: "rgba(255,255,255,0.55)",
          border: "6px solid rgba(255,255,255,0.9)",
          opacity: finger,
          transform: `scale(${f >= 0 && f < 6 ? 0.85 : 1})`,
          boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
        }}
      />
    </>
  );
};

/** iOS-artiges Push-Banner. */
export const PushBanner: React.FC<{ delay: number; y: number; title: string; body: string; time?: string }> = ({
  delay,
  y,
  title,
  body,
  time = "jetzt",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 160, mass: 0.7 } });
  return (
    <div
      style={{
        position: "absolute",
        left: 70,
        right: 70,
        top: y,
        transform: `translateY(${(1 - p) * -260}px) scale(${0.92 + p * 0.08})`,
        opacity: Math.min(1, p * 1.5),
        borderRadius: 44,
        padding: "28px 32px",
        display: "flex",
        gap: 26,
        alignItems: "center",
        background: "rgba(245,248,255,0.94)",
        boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
        fontFamily: FONT,
      }}
    >
      <Img src={staticFile("icon-tile.png")} style={{ width: 96, height: 96, borderRadius: 24 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", color: "#5B6478", fontSize: 26, fontWeight: 600 }}>
          <span>TASKOPS MANAGER</span>
          <span>{time}</span>
        </div>
        <div style={{ color: "#0B1220", fontSize: 34, fontWeight: 800, marginTop: 4 }}>{title}</div>
        <div style={{ color: "#2A3347", fontSize: 30, fontWeight: 500, marginTop: 2 }}>{body}</div>
      </div>
    </div>
  );
};

/** App-Icon mit Glow. */
export const AppIcon: React.FC<{ size: number; glow?: number }> = ({ size, glow = 1 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.23,
      overflow: "hidden",
      boxShadow: `0 0 ${120 * glow}px rgba(37,195,245,${0.45 * glow}), 0 40px 80px rgba(0,0,0,0.5)`,
      border: "2px solid rgba(255,255,255,0.12)",
    }}
  >
    <Img src={staticFile("icon-tile.png")} style={{ width: size, height: size }} />
  </div>
);

/** Wortmarke "TaskOps Manager". */
export const Wordmark: React.FC<{ size: number }> = ({ size }) => (
  <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, letterSpacing: -size * 0.04, color: C.white, lineHeight: 1 }}>
    Task<span style={{ color: C.cyan }}>Ops</span>
    <span style={{ fontWeight: 700, marginLeft: size * 0.22 }}>Manager</span>
  </div>
);

/** Dunkler Verlauf oben, damit Headlines über hereinzoomenden Phones lesbar bleiben. */
export const TopScrim: React.FC<{ height?: number }> = ({ height = 560 }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      height,
      background: "linear-gradient(180deg, rgba(5,10,22,0.97) 0%, rgba(5,10,22,0.9) 62%, rgba(5,10,22,0) 100%)",
    }}
  />
);
