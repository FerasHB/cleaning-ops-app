import { translations } from "./translations";

// Aktuelle Sprache (Standard: Deutsch)
let currentLang: "de" | "en" = "de";

// Sprache setzen (z.B. beim Wechsel in Settings)
export const setLanguage = (lang: "de" | "en") => {
  currentLang = lang;
};

// Aktuelle Sprache zurückgeben
export const getLanguage = () => currentLang;

// Kleiner "Hook" für Übersetzungen
export const useTranslation = () => {
  // Funktion zum Übersetzen eines Keys
  const t = (key: keyof typeof translations.de) => {
    // Holt den passenden Text aus dem translations-Objekt
    // je nachdem welche Sprache aktuell gesetzt ist
    return translations[currentLang][key];
  };

  // Wir geben nur die t-Funktion zurück,
  // damit sie in den Components benutzt werden kann
  return { t };
};