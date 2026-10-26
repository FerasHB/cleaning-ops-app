# TaskOps Manager – Promo-Video (Remotion)

9:16-Werbevideo (1080×1920, 30 fps, ~43 s, Deutsch). Ausgabe: `../output/app-promo.mp4`.

## Bausteine
- `public/screens/` – echte App-Screenshots aus `docs/screenshots/` (STAGING-Badge per ffmpeg übermalt).
- `public/audio/vo/` – Voice-over, erzeugt mit macOS `say -v Anna -r 192` (Texte siehe unten).
- `public/audio/*.wav` – Musik-Bed und SFX, rein synthetisch: `npm run audio` (`scripts/gen-audio.mjs`).
  Gitignored – vor dem ersten Render erzeugen. Die VO-WAVs in `public/audio/vo/` sind versioniert.
- `src/timeline.ts` – Szenenlängen, abgeleitet aus den VO-Dauern.
- `src/Promo.tsx` – die 9 Szenen + Audio-Mix (Musik-Ducking unter der VO).
- `src/components.tsx` – Phone-Mockup mit Kamera, kinetische Headlines, Chips, Push-Banner.

## Rendern
```bash
npm install
npm run audio    # Musik + SFX erzeugen (nicht versioniert)
npm run render
# danach Lautheit auf -14 LUFS (Social-Standard):
ffmpeg -i ../output/app-promo.mp4 -c:v copy -af "loudnorm=I=-14:TP=-1.0:LRA=9" -c:a aac -b:a 256k -movflags +faststart ../output/app-promo.norm.mp4
```
Vorschau/Feinschliff: `npm run studio`.

## VO-Texte
„Task Ops" ist bewusst getrennt geschrieben, damit die Stimme den Namen richtig ausspricht.

1. Schluss mit Zettelchaos im Reinigungsbetrieb!
2. Das ist Task Ops Manager. Deine komplette Einsatzplanung in einer App.
3. Auf dem Dashboard siehst du sofort, was heute fällig ist und wer gerade arbeitet.
4. Plane Aufträge einmalig oder wiederkehrend, übersichtlich im Kalender.
5. Weise ganze Teams zu. Jeder bekommt sofort eine Push-Benachrichtigung.
6. Dein Team startet und beendet Jobs mit einem Fingertipp. Sogar offline.
7. Die Arbeitszeit läuft automatisch mit. Kommentare und Fotos landen direkt am Auftrag.
8. Dazu Urlaub und Krankmeldungen. Alles an einem Ort.
9. Task Ops Manager. Mehr Kontrolle, weniger Aufwand. Jetzt herunterladen!

Neuer VO-Text → `say` neu ausführen, Dauer mit `ffprobe` messen, `VO_SECONDS`/`frames` in `src/timeline.ts` anpassen.
