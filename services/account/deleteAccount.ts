import { supabase } from "@/lib/supabase";

// Ergebnis der Kontolöschung. Klar getrennt, damit die UI den Sonderfall
// „letzter Admin" (409) mit einem erklärenden Hinweis behandeln kann, statt
// nur eine generische Fehlermeldung zu zeigen.
export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: DeleteAccountErrorCode; message: string };

export type DeleteAccountErrorCode =
  | "unauthenticated"
  | "profile_not_found"
  | "last_admin"
  | "delete_failed"
  | "server_error"
  | "unknown";

const DEFAULT_ERROR =
  "Dein Konto konnte nicht gelöscht werden. Bitte versuche es später erneut.";

// Ruft die Edge Function delete-account auf. Der Server ermittelt die zu
// löschende Identität ausschließlich aus der Session (kein Body-Parameter) —
// ein Nutzer kann so nur sein eigenes Konto löschen.
export async function requestAccountDeletion(): Promise<DeleteAccountResult> {
  try {
    const { data, error } = await supabase.functions.invoke("delete-account", {
      body: {},
    });

    if (error) {
      // Bei non-2xx liefert supabase-js einen FunctionsHttpError, dessen
      // context die rohe Response ist — daraus den strukturierten Fehlercode
      // lesen (z. B. "last_admin"), damit die UI passend reagieren kann.
      const parsed = await parseFunctionError(error);
      return {
        ok: false,
        code: parsed.code,
        message: parsed.message,
      };
    }

    // 2xx, aber Function meldet fachlich einen Fehler (defensiv).
    if (data && typeof data === "object" && "error" in data && data.error) {
      const body = data as { code?: DeleteAccountErrorCode; error?: string };
      return {
        ok: false,
        code: body.code ?? "unknown",
        message: body.error ?? DEFAULT_ERROR,
      };
    }

    return { ok: true };
  } catch {
    return { ok: false, code: "unknown", message: DEFAULT_ERROR };
  }
}

async function parseFunctionError(
  error: unknown,
): Promise<{ code: DeleteAccountErrorCode; message: string }> {
  const context = (error as { context?: unknown })?.context;

  // context ist bei FunctionsHttpError eine Response — Body einmalig auslesen.
  if (
    context &&
    typeof context === "object" &&
    "json" in context &&
    typeof (context as { json?: unknown }).json === "function"
  ) {
    try {
      const body = (await (context as Response).json()) as {
        code?: DeleteAccountErrorCode;
        error?: string;
      };
      return {
        code: body?.code ?? "unknown",
        message: body?.error ?? DEFAULT_ERROR,
      };
    } catch {
      // Body nicht lesbar/kein JSON → generischer Fehler.
    }
  }

  return { code: "unknown", message: DEFAULT_ERROR };
}
