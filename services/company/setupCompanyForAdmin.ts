import { supabase } from "@/lib/supabase";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import { normalizeEmail } from "@/utils/email";
import { normalizePhone } from "@/utils/phone";

type SetupCompanyInput = {
  companyName: string;
  /** Firmen-Kontakt-E-Mail (Pflicht in der neuen Registrierungs-UX). */
  contactEmail?: string | null;
  /** Firmen-Rufnummer, roh oder E.164. */
  contactPhone?: string | null;
  /** Persönliche Rufnummer des Admins (optional), roh oder E.164. */
  adminPhone?: string | null;
};

/**
 * Legt die Firma an und macht den aktuellen Nutzer zum Admin (RPC
 * `setup_company_for_admin`, seit Migration 20260912000000 4-argig).
 * Telefonnummern werden vor dem Aufruf nach E.164 normalisiert; ungültige
 * Eingaben führen zu einer deutschen Fehlermeldung, bevor der Server läuft.
 */
export async function setupCompanyForAdmin(
  input: string | SetupCompanyInput,
): Promise<string> {
  const opts: SetupCompanyInput =
    typeof input === "string" ? { companyName: input } : input;

  const trimmedName = opts.companyName.trim();
  if (!trimmedName) {
    throw new Error("Firmenname fehlt.");
  }

  const contactEmail = opts.contactEmail?.trim()
    ? normalizeEmail(opts.contactEmail)
    : null;

  let contactPhone: string | null = null;
  if (opts.contactPhone?.trim()) {
    contactPhone = normalizePhone(opts.contactPhone);
    if (!contactPhone) {
      throw new Error("Bitte gib eine gültige Firmen-Telefonnummer ein.");
    }
  }

  let adminPhone: string | null = null;
  if (opts.adminPhone?.trim()) {
    adminPhone = normalizePhone(opts.adminPhone);
    if (!adminPhone) {
      throw new Error("Bitte gib eine gültige Telefonnummer ein.");
    }
  }

  const { data, error } = await supabase.rpc("setup_company_for_admin", {
    company_name: trimmedName,
    p_contact_email: contactEmail,
    p_contact_phone: contactPhone,
    p_admin_phone: adminPhone,
  });

  if (error) {
    console.error("setupCompanyForAdmin RPC error:", error);
    throw new Error(
      toFriendlyAuthErrorMessage(error, "Firma konnte nicht erstellt werden."),
    );
  }

  if (typeof data !== "string" || !data) {
    throw new Error("Keine gültige Company-ID zurückbekommen.");
  }

  return data;
}
