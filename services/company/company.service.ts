// services/company/company.service.ts
// Supabase-Operationen für die eigene Firma.
//
// LESEN läuft über die RLS-Policy "read own company" (id = current_user_company_id()).
// SCHREIBEN läuft AUSSCHLIESSLICH über die SECURITY-DEFINER-RPC
// `update_own_company` — companies hat bewusst KEINE UPDATE-RLS-Policy
// (Migration 20260912000000). Die RPC hat eine explizite 3-Feld-Allowlist
// (name/contact_email/contact_phone) und prüft Rolle + Firmen-Zugehörigkeit
// serverseitig.

import { supabase } from "@/lib/supabase";
import type { Company, CompanyContactInput } from "@/types/company";
import { normalizeEmail } from "@/utils/email";
import { normalizePhone } from "@/utils/phone";

type CompanyRow = {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  timezone: string | null;
  locale: string | null;
};

function mapCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    timezone: row.timezone ?? "Europe/Berlin",
    locale: row.locale ?? "de",
  };
}

const COMPANY_SELECT = "id, name, contact_email, contact_phone, timezone, locale";

/** Lädt die eigene Firma (RLS-gescoped). Null, wenn der Nutzer keiner Firma angehört. */
export async function getOwnCompany(): Promise<Company | null> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();
  if (profileError) throw profileError;
  if (!profile?.company_id) return null;

  const { data, error } = await supabase
    .from("companies")
    .select(COMPANY_SELECT)
    .eq("id", profile.company_id)
    .single();
  if (error) throw error;

  return mapCompany(data as CompanyRow);
}

/**
 * Aktualisiert Name + Kontaktdaten der eigenen Firma (nur Admin — serverseitig
 * erzwungen). Telefon wird nach E.164 normalisiert, E-Mail lowercased; leere
 * Felder werden zu NULL. Wirft mit deutscher Meldung bei ungültigen Werten.
 */
export async function updateOwnCompany(
  input: CompanyContactInput,
): Promise<Company> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Firmenname ist erforderlich.");
  }

  const rawEmail = input.contactEmail.trim();
  const rawPhone = input.contactPhone.trim();

  let email: string | null = null;
  if (rawEmail) {
    email = normalizeEmail(rawEmail);
  }

  let phone: string | null = null;
  if (rawPhone) {
    phone = normalizePhone(rawPhone);
    if (!phone) {
      throw new Error("Bitte gib eine gültige Telefonnummer ein (z. B. 0170 1234567).");
    }
  }

  const { data, error } = await supabase.rpc("update_own_company", {
    p_name: name,
    p_contact_email: email,
    p_contact_phone: phone,
  });

  if (error) throw error;

  // RETURNS public.companies → PostgREST liefert je nach Version ein Objekt
  // oder ein 1-elementiges Array. Beides abfangen.
  const row = (Array.isArray(data) ? data[0] : data) as CompanyRow;
  return mapCompany(row);
}
