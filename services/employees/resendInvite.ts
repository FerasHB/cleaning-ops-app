import { supabase } from "@/lib/supabase";
import { toFriendlyEdgeFunctionErrorMessage } from "@/utils/authErrorMessages";

const DEFAULT_ERROR_MESSAGE = "Einladung konnte nicht erneut verschickt werden.";

// "invite"   — normale Einladungs-Mail erneut verschickt (unbestätigtes Konto).
// "recovery" — Konto ist bereits bestätigt, aber invite_accepted_at war noch
//              NULL (abgelaufene Einladungs-Sitzung, siehe resend-invite/
//              index.ts) — es wurde stattdessen ein Passwort-Reset-Link
//              verschickt, keine neue Einladung.
export type ResendInviteMode = "invite" | "recovery";

// Verschickt für einen Mitarbeiter erneut entweder die Einladungs-Mail oder —
// falls sein Konto bereits bestätigt, aber die Einladung nie abgeschlossen
// wurde — einen Passwort-Reset-Link (Edge Function resend-invite entscheidet
// serverseitig, siehe dortiger Kommentar). Schlägt serverseitig fehl, wenn
// der Mitarbeiter seine Einladung bereits angenommen hat.
export async function resendInvite(
  employeeId: string,
): Promise<ResendInviteMode> {
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

  return data?.mode === "recovery" ? "recovery" : "invite";
}
