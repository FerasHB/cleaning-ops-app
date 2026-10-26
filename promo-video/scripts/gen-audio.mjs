// Erzeugt Musik-Bed und Sound-Effekte rein synthetisch (keine externen Samples).
// Ausgabe: public/audio/*.wav (48 kHz, 16 bit).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");
mkdirSync(OUT, { recursive: true });

// Deterministisches Rauschen, damit jeder Render identisch klingt.
let seed = 1337;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296 * 2 - 1;
};

function writeWav(name, L, R = L) {
  const n = L.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const gain = peak > 0 ? 0.89 / peak : 1;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i] * gain));
    const r = Math.max(-1, Math.min(1, R[i] * gain));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  writeFileSync(join(OUT, name), buf);
  console.log("wrote", name, (n / SR).toFixed(2) + "s");
}

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Bandbegrenzter Saw per additiver Synthese (wenige Obertöne = weich).
const saw = (ph, harm) => {
  let s = 0;
  for (let k = 1; k <= harm; k++) s += Math.sin(ph * k) / k;
  return s * 0.6;
};

// ---------------------------------------------------------------- Musik
const BPM = 120;
const BEAT = 60 / BPM;
const DUR = 46;
const DROP = 3.0; // Beat setzt nach dem Hook ein
const OUTRO = 41.5; // ab hier ausklingen
const N = Math.floor(DUR * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);

// Am – F – C – G, je ein Takt (4 Beats)
const chords = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [55, 60, 64], // C
  [55, 59, 62], // G
];
const roots = [45, 41, 48, 43];
const barOf = (t) => Math.floor(t / (BEAT * 4)) % 4;

// Sidechain-Hüllkurve aus Kick-Positionen
const duck = (t) => {
  if (t < DROP || t > OUTRO + 2) return 1;
  const sinceBeat = (t - DROP) % BEAT;
  return 0.45 + 0.55 * Math.min(1, sinceBeat / 0.22);
};
const masterEnv = (t) => {
  let g = 1;
  if (t > OUTRO) g *= Math.max(0, 1 - (t - OUTRO) / (DUR - OUTRO));
  return g;
};

// Pad (ganze Zeit, vor dem Drop gefiltert/leiser)
{
  const phases = [0, 0, 0, 0, 0, 0];
  let lp = 0, lp2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const ch = chords[barOf(t)];
    let s = 0;
    for (let v = 0; v < 3; v++) {
      for (let d = 0; d < 2; d++) {
        const idx = v * 2 + d;
        phases[idx] += (2 * Math.PI * midi(ch[v]) * (d ? 1.004 : 0.996)) / SR;
        s += saw(phases[idx], 6);
      }
    }
    const cutoff = t < DROP ? 0.02 + 0.06 * (t / DROP) : 0.09;
    lp += cutoff * (s - lp);
    lp2 += cutoff * (lp - lp2);
    const amp = 0.09 * duck(t) * masterEnv(t) * Math.min(1, t / 0.6);
    L[i] += lp2 * amp;
    R[i] += lp2 * amp * 0.92;
  }
}

// Kick, Clap, Hats, Bass, Pluck – erst ab dem Drop
const addAt = (start, len, fn, pan = 0) => {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const v = fn(i / SR) * masterEnv((s0 + i) / SR);
    L[s0 + i] += v * (1 - Math.max(0, pan));
    R[s0 + i] += v * (1 + Math.min(0, pan));
  }
};

for (let t = DROP; t < OUTRO + 1.5; t += BEAT) {
  const beatIdx = Math.round((t - DROP) / BEAT);
  // Kick
  let ph = 0;
  addAt(t, 0.4, (x) => {
    const f = 45 + 110 * Math.exp(-x * 30);
    ph += (2 * Math.PI * f) / SR;
    return Math.sin(ph) * Math.exp(-x * 8) * 0.9 + (x < 0.004 ? rnd() * 0.3 : 0);
  });
  // Clap auf 2 und 4
  if (beatIdx % 2 === 1) {
    let hp = 0, prev = 0;
    addAt(t, 0.25, (x) => {
      const n = rnd();
      hp = 0.85 * (hp + n - prev); prev = n;
      const env = Math.exp(-x * 22) * (x < 0.012 ? 0.6 : 1) + (x > 0.01 && x < 0.02 ? 0.4 : 0);
      return hp * env * 0.32;
    });
  }
  // Offbeat-Hat
  let hp2 = 0, prev2 = 0;
  addAt(t + BEAT / 2, 0.08, (x) => {
    const n = rnd();
    hp2 = 0.6 * (hp2 + n - prev2); prev2 = n;
    return hp2 * Math.exp(-x * 60) * 0.18;
  }, 0.3);
  // 16tel-Hat leise
  let hp3 = 0, prev3 = 0;
  addAt(t + BEAT / 4, 0.04, (x) => {
    const n = rnd();
    hp3 = 0.5 * (hp3 + n - prev3); prev3 = n;
    return hp3 * Math.exp(-x * 90) * 0.07;
  }, -0.3);
}

// Bass: Achtel auf dem Grundton
for (let t = DROP; t < OUTRO + 1; t += BEAT / 2) {
  const f = midi(roots[barOf(t)]);
  let ph = 0, lp = 0;
  addAt(t, BEAT / 2, (x) => {
    ph += (2 * Math.PI * f) / SR;
    const s = saw(ph, 5);
    lp += 0.08 * (s - lp);
    const env = Math.min(1, x / 0.005) * Math.exp(-x * 5);
    return (lp * 1.2 + Math.sin(ph) * 0.5) * env * 0.38 * duck(t + x);
  });
}

// Pluck-Arpeggio (16tel), Stereo-Pingpong
{
  let step = 0;
  for (let t = DROP; t < OUTRO + 1; t += BEAT / 4, step++) {
    const ch = chords[barOf(t)];
    const pattern = [0, 1, 2, 1, 2, 0, 1, 2];
    const note = ch[pattern[step % 8]] + 12;
    const f = midi(note);
    let ph = 0;
    addAt(t, 0.3, (x) => {
      ph += (2 * Math.PI * f) / SR;
      const s = Math.sin(ph) + 0.35 * Math.sin(ph * 2) + 0.12 * Math.sin(ph * 3);
      return s * Math.exp(-x * 14) * Math.min(1, x / 0.002) * 0.075;
    }, step % 2 ? 0.45 : -0.45);
  }
}

writeWav("music.wav", L, R);

// ---------------------------------------------------------------- SFX
function sfx(name, len, fn) {
  const n = Math.floor(len * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(i / SR, i);
  writeWav(name, a);
}

// Whoosh: Rauschen durch wandernden Bandpass (State-Variable-Filter)
{
  let low = 0, band = 0;
  sfx("whoosh.wav", 0.7, (t) => {
    const p = t / 0.7;
    const fc = 300 + 4200 * Math.sin(Math.PI * p);
    const f = 2 * Math.sin((Math.PI * fc) / SR);
    const input = rnd();
    low += f * band;
    const high = input - low - 0.6 * band;
    band += f * high;
    return band * Math.pow(Math.sin(Math.PI * p), 2) * 0.8;
  });
}

// Pop: kurzer, abfallender Sinus (UI-Tap)
{
  let ph = 0;
  sfx("pop.wav", 0.12, (t) => {
    const f = 1100 * Math.exp(-t * 18) + 380;
    ph += (2 * Math.PI * f) / SR;
    return Math.sin(ph) * Math.exp(-t * 40) * Math.min(1, t / 0.001);
  });
}

// Riser: Rauschen + steigender Ton für den Hook
{
  let ph = 0, low = 0, band = 0;
  sfx("riser.wav", 2.8, (t) => {
    const p = t / 2.8;
    ph += (2 * Math.PI * (180 + 900 * p * p)) / SR;
    const fc = 500 + 6000 * p * p;
    const f = 2 * Math.sin((Math.PI * Math.min(fc, 12000)) / SR);
    low += f * band;
    const high = rnd() - low - 0.5 * band;
    band += f * high;
    return (band * 0.6 + Math.sin(ph) * 0.25) * p * p;
  });
}

// Impact: tiefer Boom + Rauschstoß (Logo-Reveal / CTA)
{
  let ph = 0, lp = 0;
  sfx("impact.wav", 1.6, (t) => {
    const f = 32 + 70 * Math.exp(-t * 9);
    ph += (2 * Math.PI * f) / SR;
    lp += 0.15 * (rnd() - lp);
    return Math.sin(ph) * Math.exp(-t * 2.6) + lp * Math.exp(-t * 10) * 1.2;
  });
}

// Ding: Notification-Glocke (Push-Szene)
sfx("ding.wav", 1.0, (t) => {
  const a = Math.sin(2 * Math.PI * 1318.5 * t) * Math.exp(-t * 5);
  const b = t > 0.09 ? Math.sin(2 * Math.PI * 1975.5 * (t - 0.09)) * Math.exp(-(t - 0.09) * 5) : 0;
  return (a + b * 0.8) * Math.min(1, t / 0.002) * 0.6;
});
