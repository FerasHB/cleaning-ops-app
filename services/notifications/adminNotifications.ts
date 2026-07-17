import { supabase } from "@/lib/supabase";
import { isNetworkError } from "@/utils/networkError";

// Optionale BESCHLEUNIGUNG des serverseitigen Versands (Edge Function
// dispatch-notifications, Client-Modus: nur die eigene Firma). Der Client
// "kickt" nur — WELCHE Admins benachrichtigt werden, entscheidet ausschließlich
// die Edge Function serverseitig anhand der Outbox/Deliveries.
//
// WICHTIG: Dieser Kick ist NICHT die einzige Auslösung. Der verlässliche,
// geräteunabhängige Pfad läuft serverseitig (Database Webhook auf INSERT +
// pg_cron-Sweeper, siehe supabase/functions/dispatch-notifications/DEPLOY.md).
// Geht die App unmittelbar nach dem Statuswechsel offline oder wird geschlossen,
// stellt der Server-Dispatcher die Benachrichtigung trotzdem zu.
//
// Best effort: Diese Funktion wirft NIE. Ein fehlgeschlagener Kick darf weder
// den Job-Statuswechsel noch die Offline-Synchronisierung beeinflussen.
export async function dispatchAdminNotifications(): Promise<void> {
  try {
    const { error } = await supabase.functions.invoke("dispatch-notifications", {
      body: {},
    });

    if (error && !isNetworkError(error)) {
      console.error("[adminNotifications] Dispatch fehlgeschlagen:", error);
    }
  } catch (err) {
    if (!isNetworkError(err)) {
      console.error("[adminNotifications] Dispatch-Aufruf fehlgeschlagen:", err);
    }
  }
}
