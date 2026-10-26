// Zentrale Zeitachse: Szenenlängen leiten sich aus den gemessenen VO-Dauern ab
// (say -v Anna -r 192, siehe README). Ändert sich ein VO-Text, hier anpassen.
export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

/** Vorlauf, bevor die VO einer Szene einsetzt (Frames). */
export const VO_OFFSET = 4;
/** Überlappung zwischen zwei Szenen für den Übergang (Frames). */
export const OVERLAP = 8;

export const SCENES = [
  { id: "hook", frames: 90, vo: "vo1.wav" },
  { id: "logo", frames: 142, vo: "vo2.wav" },
  { id: "dashboard", frames: 146, vo: "vo3.wav" },
  { id: "planning", frames: 139, vo: "vo4.wav" },
  { id: "team", frames: 141, vo: "vo5.wav" },
  { id: "employee", frames: 136, vo: "vo6.wav" },
  { id: "time", frames: 180, vo: "vo7.wav" },
  { id: "absences", frames: 112, vo: "vo8.wav" },
  { id: "cta", frames: 204, vo: "vo9.wav" },
] as const;

/** VO-Dauern in Sekunden (ffprobe). */
export const VO_SECONDS = [2.64, 4.43, 4.55, 4.33, 4.39, 4.22, 5.7, 3.43, 5.0];

export const sceneStarts = SCENES.reduce<number[]>((acc, s, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + SCENES[i - 1].frames);
  return acc;
}, []);

export const TOTAL_FRAMES = SCENES.reduce((sum, s) => sum + s.frames, 0);

/** VO-Fenster [start, end] in Frames (für das Musik-Ducking). */
export const voWindows = SCENES.map((_, i) => {
  const start = sceneStarts[i] + (i === 0 ? 0 : VO_OFFSET);
  return [start, start + Math.ceil(VO_SECONDS[i] * FPS)] as const;
});
