import { supabase } from "@/lib/supabase";
import { i18next } from "@/i18n";

// Ergebnis der Kontolöschung. Klar getrennt, damit die UI die Sonderfälle
// „letzter Admin" / „doch nicht letzter Admin" (409) gezielt behandeln kann,
// statt nur eine generische Fehlermeldung zu zeigen.
export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: DeleteAccountErrorCode; message: string };

export type DeleteAccountErrorCode =
  | "unauthenticated"
  | "profile_not_found"
  | "inactive_account"
  | "last_admin"
  | "not_last_admin"
  | "company_mismatch"
  | "purge_failed"
  | "prepare_failed"
  | "delete_failed"
  | "rollback_failed"
  | "server_error"
  | "unknown";

// Welcher Löschpfad gilt (RPC get_account_deletion_context, Migration
// 20261026000000). Rein informativ für die UI — die Edge Function prüft beim
// Löschen alles erneut.
export type AccountDeletionContext = {
  role: "admin" | "employee" | null;
  companyId: string | null;
  companyName: string | null;
  // Einziger aktiver Admin → Kontolöschung löscht auch die Firma.
  isLastAdmin: boolean;
  // Weitere Konten der Firma (werden beim Firmen-Purge mitgelöscht).
  otherMemberCount: number;
};

export async function getAccountDeletionContext(): Promise<AccountDeletionContext> {
  const { data, error } = await supabase.rpc("get_account_deletion_context");
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    role: row.role === "admin" || row.role === "employee" ? row.role : null,
    companyId: typeof row.company_id === "string" ? row.company_id : null,
    companyName: typeof row.company_name === "string" ? row.company_name : null,
    isLastAdmin: row.is_last_admin === true,
    otherMemberCount: typeof row.other_member_count === "number" ? row.other_member_count : 0,
  };
}

// Ruft die Edge Function delete-account auf. Der Server ermittelt die zu
// löschende Identität ausschließlich aus der Session (kein Body-Parameter) —
// ein Nutzer kann so nur sein eigenes Konto löschen.
//
// confirmCompanyId: nur für den letzten Admin, nach doppelter Bestätigung in
// der UI. Bestätigt "Firma + alle Firmendaten mitlöschen"; der Server prüft,
// dass es wirklich die eigene Firma ist und der Aufrufer letzter Admin ist.
export async function requestAccountDeletion(
  options: { confirmCompanyId?: string } = {},
): Promise<DeleteAccountResult> {
  try {
    const body = options.confirmCompanyId
      ? { confirmCompanyDeletion: true, confirmCompanyId: options.confirmCompanyId }
      : {};
    const { data, error } = await supabase.functions.invoke("delete-account", {
      body,
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
        message: body.error ?? i18next.t("profile:deleteAccount.genericError"),
      };
    }

    return { ok: true };
  } catch {
    return { ok: false, code: "unknown", message: i18next.t("profile:deleteAccount.genericError") };
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
        message: body?.error ?? i18next.t("profile:deleteAccount.genericError"),
      };
    } catch {
      // Body nicht lesbar/kein JSON → generischer Fehler.
    }
  }

  return { code: "unknown", message: i18next.t("profile:deleteAccount.genericError") };
}
