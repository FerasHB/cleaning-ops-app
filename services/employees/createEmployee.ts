import { supabase } from "@/lib/supabase";
import { toFriendlyEdgeFunctionErrorMessage } from "@/utils/authErrorMessages";

type CreateEmployeeInput = {
  fullName: string;
  email: string;
  /** Optionale Rufnummer, roh oder E.164 — die Edge Function normalisiert. */
  phone?: string | null;
};

const DEFAULT_ERROR_MESSAGE = "Einladung konnte nicht verschickt werden.";

// Legt den Mitarbeiter an und verschickt eine Einladungs-Mail (Edge Function
// create-employee, admin.inviteUserByEmail) — kein Passwort wird hier
// vergeben. Der Mitarbeiter setzt sein eigenes Passwort über den
// accept-invite-Link (siehe features/auth/AcceptInviteScreen.tsx).
export async function createEmployee(input: CreateEmployeeInput) {
  const { data, error } = await supabase.functions.invoke("create-employee", {
    body: {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone?.trim() || undefined,
    },
  });

  if (error) {
    throw new Error(await toFriendlyEdgeFunctionErrorMessage(error, DEFAULT_ERROR_MESSAGE));
  }

  if (data?.error) {
    throw new Error(
      typeof data.error === "string" ? data.error : DEFAULT_ERROR_MESSAGE,
    );
  }

  return data;
}
