// types/company.ts
// Firma (companies) im App-Format (camelCase). DB nutzt snake_case — Mapping
// in services/company/company.service.ts.
//
// Kontaktfelder-Fundament: Phase 15 (Migration 20260912000000). `timezone`
// und `locale` sind bereits vorhanden (sichere Defaults Europe/Berlin / de),
// haben aber noch kein UI — die App liest sie nur.

export type Company = {
  id: string;
  name: string;
  /** Firmen-Kontakt-/Absenderadresse. KEINE Auth-Identität. Null = nicht hinterlegt. */
  contactEmail: string | null;
  /** Firmen-Rufnummer in E.164. Null = nicht hinterlegt. */
  contactPhone: string | null;
  /** IANA-Zeitzone, Default 'Europe/Berlin'. Reserve — noch kein UI. */
  timezone: string;
  /** 'de' | 'en', Default 'de'. Reserve — noch kein UI. */
  locale: string;
};

/** Vom Admin über die Firmen-Einstellungen editierbare Felder. */
export type CompanyContactInput = {
  name: string;
  /** Roh-Eingabe oder leer — Service normalisiert + validiert. */
  contactEmail: string;
  /** Roh-Eingabe oder leer — Service normalisiert nach E.164. */
  contactPhone: string;
};
