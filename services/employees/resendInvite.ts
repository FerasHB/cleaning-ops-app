import { supabase } from "@/lib/supabase";
import { toFriendlyEdgeFunctionErrorMessage } from "@/utils/authErrorMessages";

const DEFAULT_ERROR_MESSAGE = "Einladung konnte nicht erneut verschickt werden.";

// Verschickt die Einladungs-Mail für einen Mitarbeiter erneut (Edge Function
// resend-invite) — z.B. wenn der ursprüngliche Link abgelaufen ist. Schlägt
// serverseitig fehl, wenn der Mitarbeiter seine Einladung bereits angenommen
// hat (siehe resend-invite/index.ts).
export async function resendInvite(employeeId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("resend-invite", {
    body: { employeeId },
  });

  if (error) {
    throw new Error(await toFriendlyEdgeFunctionErrorMessage(error, DEFAULT_ERROR_MESSAGE));
  }

  if (data?.error) {
    throw new Error(
      typeof data.error === "string" ? data.error : DEFAULT_ERROR_MESSAGE,
    );
  }
}
