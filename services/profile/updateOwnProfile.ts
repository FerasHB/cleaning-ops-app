// services/profile/updateOwnProfile.ts
// Selbstpflege des eigenen Profils (Name + Telefon) — Admin UND Mitarbeiter.
//
// Läuft über die RLS-Policy "update own profile" (id = auth.uid()) mit einem
// direkten .update(). enforce_profile_field_guard schützt nur
// role/company_id/is_active/employment_*/vacation_* — full_name und phone sind
// bewusst NICHT geschützt und damit selbst editierbar. Kein RPC nötig.
//
// Telefon wird nach E.164 normalisiert; leere Eingabe → NULL (Nummer entfernt).
// Der DB-CHECK chk_profiles_phone ist die harte Grenze.

import { supabase } from "@/lib/supabase";
import { normalizePhone } from "@/utils/phone";

type UpdateOwnProfileInput = {
  fullName: string;
  /** Roh-Eingabe oder leer. Leer entfernt die Nummer. */
  phone: string;
};

export async function updateOwnProfile(input: UpdateOwnProfileInput): Promise<void> {
  const fullName = input.fullName.trim();
  if (!fullName) {
    throw new Error("Name ist erforderlich.");
  }

  let phone: string | null = null;
  const rawPhone = input.phone.trim();
  if (rawPhone) {
    phone = normalizePhone(rawPhone);
    if (!phone) {
      throw new Error("Bitte gib eine gültige Telefonnummer ein (z. B. 0170 1234567).");
    }
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error("Kein eingeloggter Benutzer gefunden.");

  const { error } = await supabase
    .from("profiles")
    .update({ full_name: fullName, phone })
    .eq("id", user.id);

  if (error) throw error;
}
