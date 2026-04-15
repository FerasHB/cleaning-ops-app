import { supabase } from "@/lib/supabase";

export async function setupCompanyForAdmin(companyName: string): Promise<string> {
  const trimmedName = companyName.trim();

  if (!trimmedName) {
    throw new Error("Firmenname fehlt.");
  }

  const { data, error } = await supabase.rpc("setup_company_for_admin", {
    company_name: trimmedName,
  });

  if (error) {
    console.error("setupCompanyForAdmin RPC error:", error);
    throw new Error(error.message || "Firma konnte nicht erstellt werden.");
  }

  if (typeof data !== "string" || !data) {
    throw new Error("Keine gültige Company-ID zurückbekommen.");
  }

  return data;
}