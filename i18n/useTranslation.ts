import { translations } from "./translations";

let currentLang: "de" | "en" = "de";

export const setLanguage = (lang: "de" | "en") => {
  currentLang = lang;
};

export const getLanguage = () => currentLang;

export const useTranslation = () => {
  const t = (key: keyof typeof translations.de) => {
    return translations[currentLang][key];
  };

  return { t };
};