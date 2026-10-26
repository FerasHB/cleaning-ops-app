import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  AppIcon,
  Background,
  C,
  camAt,
  Chip,
  clamp,
  FONT,
  Headline,
  Highlight,
  Icon,
  kf,
  Kicker,
  Phone,
  PushBanner,
  SceneShell,
  Tap,
  TopScrim,
  Wordmark,
} from "./components";
import { OVERLAP, SCENES, sceneStarts, TOTAL_FRAMES, VO_OFFSET, voWindows } from "./timeline";

const S = (name: string) => `screens/${name}.png`;

// ================================================================ 1 · Hook
const NOTES = [
  { t: "Mo 8:00 Büro??", x: 70, y: 260, r: -9, c: "#FFE27A" },
  { t: "Wer hat den Schlüssel?", x: 600, y: 180, r: 7, c: "#FFFFFF" },
  { t: "Treppenhaus B – wer?", x: 640, y: 1380, r: -6, c: "#FF9FB2" },
  { t: "Stunden?!", x: 110, y: 1500, r: 8, c: "#9FD8FF" },
  { t: "Anna krank", x: 40, y: 1240, r: -4, c: "#FFE27A" },
  { t: "Fenster 2. OG", x: 700, y: 520, r: 11, c: "#B9F5C8" },
  { t: "Termin verschoben!", x: 380, y: 1650, r: -3, c: "#FFFFFF" },
  { t: "Zettel weg …", x: 720, y: 1230, r: -12, c: "#FFE27A" },
];

const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shake = frame < 10 ? Math.sin(frame * 3.1) * (10 - frame) * 2.2 : 0;
  const slam = interpolate(frame, [0, 6], [1.15, 1], { ...clamp });
  const strike = kf(frame, [26, 38], [0, 1]);
  const sub = spring({ frame: frame - 34, fps, config: { damping: 14 } });
  const sweep = kf(frame, [62, 84], [0, 1]);
  return (
    <AbsoluteFill style={{ transform: `translate(${shake}px, ${shake * 0.6}px)` }}>
      {NOTES.map((n, i) => {
        const p = spring({ frame: frame - i * 2, fps, config: { damping: 10, stiffness: 200, mass: 0.5 } });
        const wobble = Math.sin((frame + i * 13) / 4) * 3;
        // Am Ende werden die Zettel zur Mitte gesaugt und verschwinden
        const tx = (540 - (n.x + 170)) * sweep;
        const ty = (960 - (n.y + 80)) * sweep;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: n.x,
              top: n.y,
              width: 340,
              padding: "34px 28px",
              background: n.c,
              borderRadius: 8,
              boxShadow: "0 25px 50px rgba(0,0,0,0.45)",
              fontFamily: FONT,
              fontWeight: 700,
              fontSize: 36,
              color: "#1C2333",
              transform: `translate(${tx}px, ${ty}px) rotate(${n.r + wobble + sweep * 90}deg) scale(${p * (1 - sweep)})`,
              opacity: 0.95 * (1 - sweep * 0.6),
            }}
          >
            {n.t}
            <div style={{ height: 5, width: "70%", background: "rgba(0,0,0,0.12)", marginTop: 16, borderRadius: 3 }} />
            <div style={{ height: 5, width: "45%", background: "rgba(0,0,0,0.12)", marginTop: 10, borderRadius: 3 }} />
          </div>
        );
      })}
      <AbsoluteFill
        style={{
          background: "radial-gradient(circle at 50% 50%, rgba(5,10,22,0.92) 0%, rgba(5,10,22,0.6) 38%, rgba(5,10,22,0) 65%)",
        }}
      />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: FONT, transform: `scale(${slam})` }}>
        <div style={{ fontSize: 100, fontWeight: 800, color: C.white, letterSpacing: -3 }}>Schluss mit</div>
        <div style={{ position: "relative", fontSize: 146, fontWeight: 900, color: C.orange, letterSpacing: -6, lineHeight: 1.05 }}>
          Zettelchaos.
          <div
            style={{
              position: "absolute",
              left: -10,
              top: "54%",
              height: 18,
              width: `${strike * 104}%`,
              background: C.cyan,
              borderRadius: 9,
              transform: "rotate(-3deg)",
              boxShadow: `0 0 30px ${C.cyan}`,
            }}
          />
        </div>
        <div
          style={{
            marginTop: 30,
            fontSize: 50,
            fontWeight: 600,
            color: C.muted,
            opacity: sub,
            transform: `translateY(${(1 - sub) * 30}px)`,
          }}
        >
          im Reinigungsbetrieb
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ================================================================ 2 · Logo
const LogoScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const icon = spring({ frame, fps, config: { damping: 9, stiffness: 120, mass: 0.8 } });
  const word = spring({ frame: frame - 10, fps, config: { damping: 15 } });
  const ring = interpolate(frame, [0, 40], [0, 1], clamp);
  const shine = interpolate(frame, [22, 52], [-30, 130], clamp);
  const features = ["Planen", "Zuweisen", "Erledigen"];
  return (
    <AbsoluteFill style={{ alignItems: "center", fontFamily: FONT }}>
      <div
        style={{
          position: "absolute",
          top: 710 - 300 * ring,
          width: 600 * ring,
          height: 600 * ring,
          left: 540 - 300 * ring,
          borderRadius: 999,
          border: `4px solid ${C.cyan}`,
          opacity: 1 - ring,
        }}
      />
      <div style={{ position: "absolute", top: 530, transform: `scale(${icon}) rotate(${(1 - icon) * -20}deg)` }}>
        <AppIcon size={360} />
      </div>
      <div
        style={{
          position: "absolute",
          top: 970,
          opacity: word,
          transform: `translateY(${(1 - word) * 60}px)`,
          WebkitMaskImage: `linear-gradient(100deg, #000 ${shine - 10}%, rgba(0,0,0,0.65) ${shine}%, #000 ${shine + 10}%)`,
        }}
      >
        <Wordmark size={118} />
      </div>
      <Headline
        top={1140}
        size={56}
        delay={26}
        lines={[["Deine", "Einsatzplanung"], ["in", { t: "einer App.", accent: C.cyan }]]}
      />
      <div style={{ position: "absolute", top: 1390, display: "flex", gap: 22 }}>
        {features.map((f, i) => {
          const p = spring({ frame: frame - 60 - i * 7, fps, config: { damping: 12, stiffness: 170 } });
          return (
            <div
              key={f}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "18px 30px",
                borderRadius: 999,
                background: "rgba(37,195,245,0.10)",
                border: `2px solid ${C.cyan}55`,
                color: C.white,
                fontSize: 36,
                fontWeight: 700,
                transform: `scale(${p})`,
              }}
            >
              <Icon name="check" size={30} color={C.cyan} stroke={3} />
              {f}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ================================================================ 3 · Dashboard
const DashboardScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camAt(frame, [
    { f: 0, cam: { fx: 645, fy: 0, cx: 540, cy: 1500, s: 1 } },
    { f: 20, cam: { fx: 645, fy: 0, cx: 540, cy: 580, s: 1 } },
    { f: 52, cam: { fx: 645, fy: 0, cx: 540, cy: 580, s: 1 } },
    { f: 72, cam: { fx: 636, fy: 1110, cx: 540, cy: 1150, s: 1.5 } },
    { f: 100, cam: { fx: 636, fy: 1110, cx: 540, cy: 1150, s: 1.5 } },
    { f: 120, cam: { fx: 645, fy: 2150, cx: 540, cy: 1150, s: 1.45 } },
  ]);
  return (
    <AbsoluteFill>
      <Phone src={S("admin-dashboard")} cam={cam}>
        <Highlight x={40} y={790} w={1196} h={640} delay={72} />
      </Phone>
      <TopScrim />
      <Kicker text="DASHBOARD" />
      <Headline lines={[["Alles", "auf"], [{ t: "einen Blick.", accent: C.cyan }]]} delay={2} />
      <Chip text="Heute fällig" icon="calendar" x={330} y={1560} delay={78} until={104} />
      <Chip text="In Arbeit" icon="clock" x={760} y={1660} delay={86} until={104} color={C.orange} />
      <Chip text="Wer arbeitet gerade?" icon="pulse" x={540} y={1640} delay={118} color={C.green} />
    </AbsoluteFill>
  );
};

// ================================================================ 4 · Planung
const PlanningScene: React.FC = () => {
  const frame = useCurrentFrame();
  const front = camAt(frame, [
    { f: 0, cam: { fx: 645, fy: 1000, cx: 1500, cy: 1160, s: 1, r: 8 } },
    { f: 22, cam: { fx: 645, fy: 1000, cx: 640, cy: 1160, s: 1, r: -3 } },
    { f: 78, cam: { fx: 645, fy: 1000, cx: 640, cy: 1160, s: 1, r: -3 } },
    { f: 100, cam: { fx: 820, fy: 1240, cx: 600, cy: 1180, s: 1.6, r: 0 } },
  ]);
  const back = camAt(frame, [
    { f: 0, cam: { fx: 645, fy: 900, cx: -500, cy: 1260, s: 1, r: -18 } },
    { f: 26, cam: { fx: 645, fy: 900, cx: 290, cy: 1260, s: 1, r: -11 } },
    { f: 78, cam: { fx: 645, fy: 900, cx: 290, cy: 1260, s: 1, r: -11 } },
    { f: 100, cam: { fx: 645, fy: 900, cx: -300, cy: 1260, s: 1, r: -16 } },
  ]);
  return (
    <AbsoluteFill>
      <Phone src={S("job-detail")} cam={back} width={560} opacity={0.9} />
      <Phone src={S("admin-calendar")} cam={front} width={640}>
        <Highlight x={724} y={1020} w={192} h={440} delay={100} radius={36} />
      </Phone>
      <TopScrim />
      <Kicker text="PLANUNG" />
      <Headline lines={[["Aufträge"], [{ t: "planen.", accent: C.cyan }]]} delay={2} />
      <Chip text="Einmalig" icon="calendar" x={320} y={560} delay={36} />
      <Chip text="Wiederkehrend" icon="repeat" x={720} y={560} delay={48} color={C.orange} />
      <Chip text="Alles im Kalender" icon="calendar" x={540} y={1720} delay={108} color={C.blue} />
    </AbsoluteFill>
  );
};

// ================================================================ 5 · Team
const TeamScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camAt(frame, [
    { f: 0, cam: { fx: 645, fy: 1400, cx: 540, cy: 1900, s: 1 } },
    { f: 20, cam: { fx: 645, fy: 1400, cx: 540, cy: 1360, s: 1 } },
    { f: 34, cam: { fx: 645, fy: 1400, cx: 540, cy: 1360, s: 1 } },
    { f: 54, cam: { fx: 648, fy: 1844, cx: 540, cy: 1250, s: 1.45 } },
  ]);
  return (
    <AbsoluteFill>
      <Phone src={S("admin-jobs")} cam={cam}>
        <Highlight x={60} y={1630} w={1170} h={430} delay={50} color={C.orange} />
      </Phone>
      <TopScrim />
      <Kicker text="TEAM" />
      <Headline lines={[["Ganze", "Teams"], [{ t: "zuweisen.", accent: C.cyan }]]} delay={2} />
      <PushBanner delay={64} y={470} title="Neuer Auftrag für dich" body="Rheinblick Kanzlei · heute 16:00" />
      <Chip text="Mehrere Mitarbeiter pro Job" icon="users" x={540} y={1700} delay={92} />
    </AbsoluteFill>
  );
};

// ================================================================ 6 · Mitarbeiter
const EmployeeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camAt(frame, [
    { f: 0, cam: { fx: 645, fy: 2626, cx: 540, cy: 1700, s: 1 } },
    { f: 20, cam: { fx: 645, fy: 2626, cx: 540, cy: 1330, s: 1 } },
    { f: 60, cam: { fx: 645, fy: 2626, cx: 540, cy: 1330, s: 1 } },
    { f: 90, cam: { fx: 645, fy: 2300, cx: 540, cy: 1150, s: 1.15 } },
  ]);
  const switchP = kf(frame, [44, 52], [0, 1]);
  return (
    <AbsoluteFill>
      <Phone src={S("employee-job-detail")} cam={cam} overlaySrc={S("employee-job-active")} overlayOpacity={switchP}>
        <Tap x={644} y={2626} at={40} />
      </Phone>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,10,22,0) 66%, rgba(5,10,22,0.95) 76%)" }} />
      <Kicker text="FÜR DEIN TEAM" top={1470} delay={2} />
      <Headline top={1540} size={100} lines={[["Start", "per"], [{ t: "Fingertipp.", accent: C.cyan }]]} delay={4} />
      <Chip text="Job gestartet" icon="play" x={540} y={170} delay={50} color={C.green} />
      <Chip text="Funktioniert auch offline" icon="wifiOff" x={540} y={300} delay={84} color={C.orange} />
    </AbsoluteFill>
  );
};

// ================================================================ 7 · Zeit + Kommentare
const TimeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const camA = camAt(frame, [
    { f: 0, cam: { fx: 644, fy: 2060, cx: 540, cy: 1300, s: 1 } },
    { f: 18, cam: { fx: 644, fy: 2060, cx: 540, cy: 1300, s: 1 } },
    { f: 42, cam: { fx: 644, fy: 2250, cx: 540, cy: 1220, s: 1.6 } },
    { f: 84, cam: { fx: 644, fy: 2250, cx: -500, cy: 1220, s: 1.6 } },
  ]);
  const camB = camAt(frame, [
    { f: 80, cam: { fx: 644, fy: 1300, cx: 1600, cy: 1330, s: 1.25 } },
    { f: 100, cam: { fx: 644, fy: 1300, cx: 540, cy: 1330, s: 1.25 } },
  ]);
  return (
    <AbsoluteFill>
      {frame < 92 ? (
        <Phone src={S("employee-job-active")} cam={camA}>
          <Highlight x={80} y={2120} w={1130} h={380} delay={40} />
        </Phone>
      ) : null}
      {frame >= 78 ? (
        <Phone src={S("job-comments")} cam={camB}>
          <Highlight x={40} y={1150} w={1210} h={520} delay={108} />
        </Phone>
      ) : null}
      <TopScrim />
      <AbsoluteFill style={{ opacity: 1 - kf(frame, [74, 84], [0, 1]) }}>
        <Kicker text="ZEITERFASSUNG" />
        <Headline lines={[["Arbeitszeit"], [{ t: "läuft mit.", accent: C.cyan }]]} delay={2} exitAt={76} />
      </AbsoluteFill>
      <Chip text="Eine Uhr fürs ganze Team" icon="clock" x={540} y={1760} delay={48} until={76} />
      <Sequence from={84} layout="none">
        <Kicker text="KOMMUNIKATION" color={C.orange} />
        <Headline lines={[["Kommentare"], [{ t: "& Fotos.", accent: C.orange }]]} delay={2} />
      </Sequence>
      <Chip text="Foto hinzufügen" icon="camera" x={330} y={1770} delay={124} color={C.orange} />
      <Chip text="Direkt am Auftrag" icon="chat" x={720} y={1870} delay={136} />
    </AbsoluteFill>
  );
};

// ================================================================ 8 · Abwesenheiten
const AbsenceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camAt(frame, [
    { f: 0, cam: { fx: 645, fy: 1880, cx: 540, cy: 2200, s: 1 } },
    { f: 20, cam: { fx: 645, fy: 1880, cx: 540, cy: 1580, s: 1 } },
    { f: 70, cam: { fx: 645, fy: 1880, cx: 540, cy: 1620, s: 1.15 } },
  ]);
  return (
    <AbsoluteFill>
      <Phone src={S("admin-absences")} cam={cam}>
        <Highlight x={30} y={1620} w={1230} h={560} delay={30} color={C.green} />
      </Phone>
      <TopScrim />
      <Kicker text="ABWESENHEITEN" color={C.green} />
      <Headline size={96} lines={[["Urlaub", "&"], [{ t: "Krankmeldung.", accent: C.green }]]} delay={2} />
      <Chip text="Urlaub genehmigt" icon="check" x={340} y={1810} delay={40} color={C.green} />
      <Chip text="Krank melden per App" icon="medical" x={700} y={560} delay={58} color={C.orange} />
    </AbsoluteFill>
  );
};

// ================================================================ 9 · CTA
const CtaScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const icon = spring({ frame, fps, config: { damping: 11, stiffness: 140 } });
  const word = spring({ frame: frame - 8, fps, config: { damping: 15 } });
  const btn = spring({ frame: frame - 44, fps, config: { damping: 10, stiffness: 160 } });
  const pulse = 1 + Math.sin(Math.max(0, frame - 60) / 6) * 0.025;
  const shine = ((frame - 50) % 60) / 60;
  const fadeOut = interpolate(frame, [SCENES[8].frames - 10, SCENES[8].frames], [1, 0], clamp);
  const phones = [
    { src: "employee-overview", cx: 250, r: -12, d: 18 },
    { src: "admin-calendar", cx: 830, r: 12, d: 22 },
    { src: "admin-dashboard", cx: 540, r: 0, d: 26 },
  ];
  return (
    <AbsoluteFill style={{ opacity: fadeOut, fontFamily: FONT }}>
      {phones.map((p) => {
        const rise = spring({ frame: frame - p.d, fps, config: { damping: 16, stiffness: 90 } });
        const cy = interpolate(rise, [0, 1], [2300, p.cx === 540 ? 1240 : 1330]);
        return <Phone key={p.src} src={S(p.src)} width={500} cam={{ fx: 645, fy: 0, cx: p.cx, cy, s: 1, r: p.r }} />;
      })}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,10,22,0.0) 55%, rgba(5,10,22,0.85) 100%)" }} />
      <div style={{ position: "absolute", top: 120, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <div style={{ transform: `scale(${icon})` }}>
          <AppIcon size={200} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 360,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          opacity: word,
          transform: `translateY(${(1 - word) * 40}px)`,
        }}
      >
        <Wordmark size={92} />
      </div>
      <Headline
        top={500}
        size={84}
        delay={16}
        lines={[["Mehr", "Kontrolle."], [{ t: "Weniger", accent: C.cyan }, { t: "Aufwand.", accent: C.cyan }]]}
      />
      <div style={{ position: "absolute", top: 760, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            gap: 20,
            padding: "34px 64px",
            borderRadius: 999,
            background: `linear-gradient(100deg, ${C.cyan}, ${C.blue})`,
            color: "#fff",
            fontSize: 54,
            fontWeight: 800,
            boxShadow: `0 20px 60px rgba(47,107,255,0.55), 0 0 ${40 + 30 * Math.sin(frame / 6)}px rgba(37,195,245,0.5)`,
            transform: `scale(${btn * pulse})`,
          }}
        >
          <Icon name="download" size={52} color="#fff" stroke={2.8} />
          Jetzt herunterladen
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              width: 120,
              left: `${-20 + shine * 140}%`,
              background: "linear-gradient(100deg, rgba(255,255,255,0), rgba(255,255,255,0.45), rgba(255,255,255,0))",
              transform: "skewX(-20deg)",
            }}
          />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 930,
          left: 0,
          right: 0,
          textAlign: "center",
          color: C.muted,
          fontSize: 38,
          fontWeight: 600,
          opacity: interpolate(frame, [56, 70], [0, 1], clamp),
        }}
      >
        Für iPhone & Android
      </div>
    </AbsoluteFill>
  );
};

const SCENE_COMPONENTS: Record<string, React.FC> = {
  hook: HookScene,
  logo: LogoScene,
  dashboard: DashboardScene,
  planning: PlanningScene,
  team: TeamScene,
  employee: EmployeeScene,
  time: TimeScene,
  absences: AbsenceScene,
  cta: CtaScene,
};

// ================================================================ Audio
/** Musik unter der VO absenken (Ducking) und am Ende ausblenden. */
const musicVolume = (f: number) => {
  let duck = 0;
  for (const [s, e] of voWindows) {
    duck = Math.max(duck, interpolate(f, [s - 6, s, e, e + 10], [0, 1, 1, 0], clamp));
  }
  const fade = interpolate(f, [TOTAL_FRAMES - 45, TOTAL_FRAMES], [1, 0], clamp);
  return (0.55 - 0.32 * duck) * fade;
};

const at = (scene: number, offset: number) => sceneStarts[scene] + offset;

const SFX: { src: string; from: number; volume: number }[] = [
  { src: "impact.wav", from: 0, volume: 0.55 },
  { src: "riser.wav", from: 4, volume: 0.32 },
  { src: "pop.wav", from: 2, volume: 0.25 },
  { src: "pop.wav", from: 8, volume: 0.2 },
  { src: "pop.wav", from: 14, volume: 0.2 },
  { src: "whoosh.wav", from: at(1, -8), volume: 0.5 },
  { src: "impact.wav", from: at(1, 0), volume: 0.8 },
  { src: "whoosh.wav", from: at(2, -8), volume: 0.4 },
  { src: "pop.wav", from: at(2, 78), volume: 0.3 },
  { src: "pop.wav", from: at(2, 86), volume: 0.25 },
  { src: "whoosh.wav", from: at(3, -8), volume: 0.4 },
  { src: "pop.wav", from: at(3, 36), volume: 0.3 },
  { src: "pop.wav", from: at(3, 48), volume: 0.3 },
  { src: "whoosh.wav", from: at(4, -8), volume: 0.4 },
  { src: "ding.wav", from: at(4, 64), volume: 0.45 },
  { src: "whoosh.wav", from: at(5, -8), volume: 0.4 },
  { src: "pop.wav", from: at(5, 40), volume: 0.5 },
  { src: "pop.wav", from: at(5, 84), volume: 0.25 },
  { src: "whoosh.wav", from: at(6, -8), volume: 0.4 },
  { src: "whoosh.wav", from: at(6, 78), volume: 0.35 },
  { src: "pop.wav", from: at(6, 124), volume: 0.25 },
  { src: "whoosh.wav", from: at(7, -8), volume: 0.4 },
  { src: "pop.wav", from: at(7, 40), volume: 0.25 },
  { src: "whoosh.wav", from: at(8, -8), volume: 0.45 },
  { src: "impact.wav", from: at(8, 0), volume: 0.6 },
  { src: "pop.wav", from: at(8, 46), volume: 0.35 },
];

// ================================================================ Komposition
export const Promo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Background />
    {SCENES.map((scene, i) => {
      const Comp = SCENE_COMPONENTS[scene.id];
      return (
        <Sequence key={scene.id} from={sceneStarts[i]} durationInFrames={scene.frames + OVERLAP} name={scene.id}>
          <SceneShell frames={scene.frames} enter={i !== 0}>
            <Comp />
          </SceneShell>
        </Sequence>
      );
    })}

    <Audio src={staticFile("audio/music.wav")} volume={musicVolume} />
    {SCENES.map((scene, i) => (
      <Sequence key={`vo-${i}`} from={sceneStarts[i] + (i === 0 ? 0 : VO_OFFSET)} name={`VO ${i + 1}`}>
        <Audio src={staticFile(`audio/vo/${scene.vo}`)} volume={1} />
      </Sequence>
    ))}
    {SFX.map((s, i) => (
      <Sequence key={`sfx-${i}`} from={Math.max(0, s.from)} name={`SFX ${s.src}`}>
        <Audio src={staticFile(`audio/${s.src}`)} volume={s.volume} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
