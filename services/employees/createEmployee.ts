import { supabase } from "@/lib/supabase";

type CreateEmployeeInput = {
  fullName: string;
  email: string;
};

// Legt den Mitarbeiter an und verschickt eine Einladungs-Mail (Edge Function
// create-employee, admin.inviteUserByEmail) — kein Passwort wird hier
// vergeben. Der Mitarbeiter setzt sein eigenes Passwort über den
// accept-invite-Link (siehe features/auth/AcceptInviteScreen.tsx).
export async function createEmployee(input: CreateEmployeeInput) {
  const { data, error } = await supabase.functions.invoke("create-employee", {
    body: {
      fullName: input.fullName,
      email: input.email,
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data;
}
