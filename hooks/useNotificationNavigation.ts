// hooks/useNotificationNavigation.ts
// ─────────────────────────────────────────────────────────────────
// Öffnet beim Antippen einer Push-Benachrichtigung direkt den betroffenen
// Job. Deckt beide Fälle ab:
//   * App im Vorder-/Hintergrund (addNotificationResponseReceivedListener über
//     useLastNotificationResponse)
//   * App war komplett geschlossen (Cold Start) — useLastNotificationResponse
//     liefert auch die Notification, die die App gestartet hat.
//
// Die Navigation passiert nur, wenn der Nutzer voll eingeloggt ist (Session +
// company_id). Kommt der Tap, bevor das Profil geladen ist (Cold Start), wird
// die jobId gemerkt und nachgeholt, sobald der eingeloggte Zustand steht.
//
// Der Payload wird serverseitig gesetzt (Edge Function dispatch-notifications):
//   data = { type, jobId, companyId, employeeId, status }
// ─────────────────────────────────────────────────────────────────

// PLATTFORM-GUARD (Web): expo-notifications hat im Web KEINE Implementierung
// für useLastNotificationResponse — der Hook ruft intern
// getLastNotificationResponseAsync auf und wirft dort ERR_UNAVAILABLE
// ("The method or property ExpoNotifications.getLastNotificationResponseAsync
// is not available on web"). Da dieser Hook in app/_layout.tsx im
// RootNavigator hängt, hat das die GESAMTE Web-App vor dem ersten Render in
// die AppErrorBoundary geworfen ("Etwas ist schiefgelaufen") — Login war im
// Browser überhaupt nicht erreichbar.
//
// Gelöst über zwei Implementierungen, die beim Modul-Laden EINMAL ausgewählt
// werden (siehe Export unten). Bewusst NICHT über ein `if (Platform.OS ===
// "web") return;` INNERHALB des Hooks: das wäre ein bedingter Hook-Aufruf und
// verstößt gegen die Rules of Hooks. Platform.OS ist zur Laufzeit konstant,
// die Hook-Reihenfolge bleibt damit über alle Renders stabil.
//
// iOS/Android bleiben unverändert: dort wird exakt die bisherige
// Implementierung exportiert.

import { useAuth } from "@/context/AuthContext";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

// Ziel eines angetippten Push. `job` öffnet den Auftrag direkt; `absence`
// öffnet die passende Abwesenheits-LISTE, weil es (noch) keine Detail-Route
// pro Abwesenheit gibt — die absenceId wird trotzdem mitgeführt, damit ein
// späterer Detail-Screen ohne Änderung am Payload angesprungen werden kann.
type NotificationTarget =
  | { kind: "job"; id: string }
  | { kind: "absence"; id: string };

function extractTarget(
  response: Notifications.NotificationResponse | null,
): NotificationTarget | null {
  const data = response?.notification?.request?.content?.data as
    | Record<string, unknown>
    | undefined;

  if (!data) return null;

  // Job zuerst: Job-Events tragen niemals eine absenceId, Abwesenheits-Events
  // niemals eine jobId — die Reihenfolge ist damit unkritisch, aber stabil.
  if (typeof data.jobId === "string" && data.jobId.length > 0) {
    return { kind: "job", id: data.jobId };
  }

  if (typeof data.absenceId === "string" && data.absenceId.length > 0) {
    return { kind: "absence", id: data.absenceId };
  }

  return null;
}

function useNotificationNavigationNative() {
  const { session, profile } = useAuth();
  const lastResponse = Notifications.useLastNotificationResponse();

  // Merkt sich einen Tap, dessen Ziel noch nicht geöffnet werden konnte
  // (z. B. weil beim Cold Start das Profil noch lädt).
  const pendingTargetRef = useRef<NotificationTarget | null>(null);
  // Verhindert, dass dieselbe Notification-Response mehrfach verarbeitet wird
  // (useLastNotificationResponse liefert bei jedem Render denselben Wert).
  const handledIdentifierRef = useRef<string | null>(null);

  // Eingehende Response auslesen und die jobId als "pending" vormerken.
  useEffect(() => {
    if (!lastResponse) {
      return;
    }

    const identifier = lastResponse.notification.request.identifier;
    if (handledIdentifierRef.current === identifier) {
      return;
    }
    handledIdentifierRef.current = identifier;

    const target = extractTarget(lastResponse);
    if (target) {
      pendingTargetRef.current = target;
    }
  }, [lastResponse]);

  // Sobald ein Tap vorgemerkt ist UND der Nutzer voll eingeloggt ist, den Job
  // öffnen. Läuft auch, wenn sich der Auth-Zustand nach einem Cold-Start-Tap
  // erst noch stabilisiert.
  useEffect(() => {
    const target = pendingTargetRef.current;
    if (!target) {
      return;
    }

    const isAuthed = !!session && !!profile?.company_id;
    if (!isAuthed) {
      return;
    }

    pendingTargetRef.current = null;

    if (target.kind === "job") {
      router.push({ pathname: "/jobs/[id]", params: { id: target.id } });
      return;
    }

    // Abwesenheit: Admin und Mitarbeiter haben getrennte Listen. Die Rolle
    // entscheidet — ein Mitarbeiter darf die Admin-Liste nicht sehen (und
    // käme dort per RLS ohnehin nicht an Daten).
    router.push(profile?.role === "admin" ? "/admin/absences" : "/absences");
  }, [session, profile?.company_id, profile?.role, lastResponse]);
}

// Web-Variante: bewusst ein No-Op. Im Browser gibt es keine Push-Tokens
// (registerForPushNotifications liefert dort seit jeher null) und damit auch
// keine Notification, die angetippt werden könnte — es geht also keine
// Funktion verloren. Die Signatur bleibt identisch, damit der Aufrufer in
// app/_layout.tsx plattformunabhängig bleibt.
function useNotificationNavigationWeb() {
  // absichtlich leer
}

export const useNotificationNavigation =
  Platform.OS === "web"
    ? useNotificationNavigationWeb
    : useNotificationNavigationNative;
