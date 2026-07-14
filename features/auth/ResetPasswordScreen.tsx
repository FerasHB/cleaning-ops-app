// features/auth/ResetPasswordScreen.tsx
// Ziel des Passwort-Reset-Deep-Links (taskopsmanager://reset-password).
// Unterstützt beide Redirect-Formate:
//   • PKCE:     taskopsmanager://reset-password?code=...
//               → supabase.auth.exchangeCodeForSession(code)
//   • Implicit: taskopsmanager://reset-password#access_token=...&refresh_token=...&type=recovery
//               → supabase.auth.setSession(...)
// Die Parameter können aus drei Quellen kommen (expo-router useLocalSearchParams,
// Linking.getInitialURL beim Kaltstart, Linking-"url"-Event bei laufender App).
// Damit derselbe Link nicht mehrfach eingelöst wird, verarbeitet attemptedRef
// nur den ersten verwertbaren Treffer. Zustände: checking → ready → success,
// oder invalid bei ungültigem/abgelaufenem Link bzw. Timeout.

import { ErrorBanner, PasswordInput } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type ScreenStatus = "checking" | "ready" | "invalid" | "success";

// Kein endloser Spinner: nach dieser Zeit ohne verwertbaren Parameter → invalid.
const RECHECK_TIMEOUT_MS = 10_000;
const DEFAULT_INVALID_MESSAGE =
  "Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen Link an.";

type RecoveryParams = {
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  type?: string;
  errorCode?: string;
  errorDescription?: string;
};

// Nur in Entwicklung loggen — niemals vollständige Tokens/Codes ausgeben.
function devLog(...args: unknown[]) {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log("[ResetPassword]", ...args);
  }
}

// Parst Query (?a=b) UND Hash (#a=b) einer Deep-Link-URL und merged beide.
// PKCE liefert den Code im Query, Implicit die Tokens im Hash-Fragment.
function parseUrlParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");

  const segments: string[] = [];
  if (queryIndex !== -1) {
    const end = hashIndex > queryIndex ? hashIndex : url.length;
    segments.push(url.substring(queryIndex + 1, end));
  }
  if (hashIndex !== -1) {
    segments.push(url.substring(hashIndex + 1));
  }

  for (const segment of segments) {
    for (const pair of segment.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.substring(0, eq);
      const rawValue = eq === -1 ? "" : pair.substring(eq + 1);
      if (!rawKey) continue;
      try {
        out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
      } catch {
        out[rawKey] = rawValue;
      }
    }
  }
  return out;
}

function toRecoveryParams(raw: Record<string, string>): RecoveryParams {
  return {
    code: raw.code || undefined,
    accessToken: raw.access_token || undefined,
    refreshToken: raw.refresh_token || undefined,
    type: raw.type || undefined,
    errorCode: raw.error_code || raw.error || undefined,
    errorDescription: raw.error_description || undefined,
  };
}

// Fasst eine URL für Logs zusammen, ohne Geheimwerte: nur Schema+Pfad und die
// vorhandenen Parameter-Schlüssel (Werte werden bewusst weggelassen).
function safeUrlSummary(url: string): string {
  const base = url.split(/[?#]/)[0];
  const keys = Object.keys(parseUrlParams(url));
  return `${base} [params: ${keys.length ? keys.join(", ") : "keine"}]`;
}

function firstString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function ResetPasswordScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [status, setStatus] = useState<ScreenStatus>("checking");
  const [invalidMessage, setInvalidMessage] = useState(DEFAULT_INVALID_MESSAGE);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const params = useLocalSearchParams<{
    code?: string;
    access_token?: string;
    refresh_token?: string;
    type?: string;
    error?: string;
    error_code?: string;
    error_description?: string;
  }>();

  const mountedRef = useRef(true);
  // Sobald ein verwertbarer Link (Code/Token/Fehler) eingelöst wird → true.
  // Verhindert doppelte Verarbeitung, wenn mehrere Quellen dieselbe URL liefern.
  const attemptedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback((next: ScreenStatus, message?: string) => {
    if (!mountedRef.current) return;
    if (message) setInvalidMessage(message);
    setStatus(next);
  }, []);

  // Nach einem Fehler beim Code-/Token-Tausch trotzdem prüfen, ob bereits eine
  // gültige (Recovery-)Session existiert — z.B. wenn detectSessionInUrl (Web)
  // den Code schon eingelöst hat. Nur dann ready, sonst invalid.
  const readySessionOrInvalid = useCallback(
    async (message?: string) => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        finish("ready");
        return;
      }
      finish("invalid", message ?? DEFAULT_INVALID_MESSAGE);
    },
    [finish],
  );

  const processParams = useCallback(
    async (recovery: RecoveryParams, source: string) => {
      const hasError = !!(recovery.errorCode || recovery.errorDescription);
      const hasCode = !!recovery.code;
      const hasTokens = !!(recovery.accessToken && recovery.refreshToken);

      // Diese Quelle enthält nichts Verwertbares → anderen Quellen die Chance
      // lassen (attemptedRef NICHT setzen).
      if (!hasError && !hasCode && !hasTokens) return;

      // Nur den ersten Treffer einlösen (Code ist ohnehin einmalig gültig).
      if (attemptedRef.current) return;
      attemptedRef.current = true;

      if (hasError) {
        devLog(
          `Fehler im Link (Quelle: ${source}):`,
          recovery.errorCode ?? "?",
          recovery.errorDescription ?? "",
        );
        finish(
          "invalid",
          recovery.errorDescription
            ? recovery.errorDescription.replace(/\+/g, " ")
            : DEFAULT_INVALID_MESSAGE,
        );
        return;
      }

      try {
        if (hasCode) {
          devLog(`Erkannter Flow: pkce (Quelle: ${source})`);
          const { data, error } = await supabase.auth.exchangeCodeForSession(
            recovery.code!,
          );
          if (error) {
            devLog("exchangeCodeForSession Fehler:", error.message);
            await readySessionOrInvalid();
            return;
          }
          if (!data.session) {
            await readySessionOrInvalid();
            return;
          }
          devLog("PKCE-Session hergestellt.");
          finish("ready");
          return;
        }

        // Implicit: Tokens direkt aus Hash/Query.
        devLog(`Erkannter Flow: implicit (Quelle: ${source})`);
        const { data, error } = await supabase.auth.setSession({
          access_token: recovery.accessToken!,
          refresh_token: recovery.refreshToken!,
        });
        if (error) {
          devLog("setSession Fehler:", error.message);
          await readySessionOrInvalid();
          return;
        }
        if (!data.session) {
          await readySessionOrInvalid();
          return;
        }
        devLog("Implicit-Session hergestellt.");
        finish("ready");
      } catch (err) {
        devLog(
          "Unerwarteter Fehler bei Recovery:",
          err instanceof Error ? err.message : String(err),
        );
        finish("invalid", DEFAULT_INVALID_MESSAGE);
      }
    },
    [finish, readySessionOrInvalid],
  );

  const armTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (!attemptedRef.current) {
        devLog("Timeout: kein gültiger Recovery-Parameter empfangen.");
        finish("invalid", DEFAULT_INVALID_MESSAGE);
      }
    }, RECHECK_TIMEOUT_MS);
  }, [finish]);

  // ── Quelle A: expo-router Query-Parameter (deckt PKCE ?code= ab) ──
  useEffect(() => {
    const routerParams = toRecoveryParams({
      code: firstString(params.code),
      access_token: firstString(params.access_token),
      refresh_token: firstString(params.refresh_token),
      type: firstString(params.type),
      error: firstString(params.error),
      error_code: firstString(params.error_code),
      error_description: firstString(params.error_description),
    });
    void processParams(routerParams, "router-params");
  }, [
    params.code,
    params.access_token,
    params.refresh_token,
    params.error,
    params.error_code,
    params.error_description,
    params.type,
    processParams,
  ]);

  // ── Quelle B: Kaltstart-URL + Quelle C: Laufzeit-Deep-Links + Timeout ──
  useEffect(() => {
    mountedRef.current = true;

    (async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          devLog("Initiale URL:", safeUrlSummary(initialUrl));
          void processParams(
            toRecoveryParams(parseUrlParams(initialUrl)),
            "getInitialURL",
          );
        }
      } catch (err) {
        devLog(
          "getInitialURL Fehler:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();

    const subscription = Linking.addEventListener("url", ({ url }) => {
      devLog("Deep-Link Event:", safeUrlSummary(url));
      void processParams(toRecoveryParams(parseUrlParams(url)), "url-event");
    });

    armTimeout();

    return () => {
      mountedRef.current = false;
      subscription.remove();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [processParams, armTimeout]);

  // "Link erneut prüfen" — nochmals die Kaltstart-URL auswerten (z.B. wenn der
  // Deep-Link verzögert ankam). Ein bereits verbrauchter Code führt erneut zu
  // invalid, das ist gewollt.
  const handleRecheck = useCallback(() => {
    attemptedRef.current = false;
    setStatus("checking");
    (async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          void processParams(
            toRecoveryParams(parseUrlParams(initialUrl)),
            "recheck",
          );
        }
      } catch {
        // Ignorieren — der Timeout unten fängt den Fehlerfall ab.
      }
      armTimeout();
    })();
  }, [processParams, armTimeout]);

  const validate = (): string | null => {
    if (!newPassword.trim()) return "Bitte ein neues Passwort eingeben.";
    if (newPassword.length < 6)
      return "Das Passwort muss mindestens 6 Zeichen lang sein.";
    if (newPassword !== confirmPassword)
      return "Die Passwörter stimmen nicht überein.";
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setFormError("");
    setSubmitting(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        devLog("updateUser Fehler:", error.message);
        setFormError(error.message || "Passwort konnte nicht gesetzt werden.");
        return;
      }

      // Recovery-Session beenden — der Nutzer soll sich bewusst mit dem
      // neuen Passwort neu anmelden, keine automatische App-Sitzung aus
      // dem Reset-Link heraus.
      await supabase.auth.signOut().catch(() => {});

      setStatus("success");
    } catch {
      setFormError(
        "Ein unbekannter Fehler ist aufgetreten. Bitte versuche es erneut.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── Wird geprüft ──
  if (status === "checking") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.centerHint}>Link wird geprüft …</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Ungültiger/abgelaufener Link ──
  if (status === "invalid") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <View style={styles.centerState}>
          <View style={styles.errorIconWrap}>
            <Ionicons name="alert-circle" size={44} color={theme.colors.error} />
          </View>
          <Text style={styles.centerTitle}>Link ungültig</Text>
          <Text style={styles.centerText}>{invalidMessage}</Text>

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace("/forgot-password")}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryBtnText}>Neuen Link anfordern</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={handleRecheck}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Link erneut prüfen</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => router.replace("/login")}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Zurück zum Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Erfolgreich gesetzt ──
  if (status === "success") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerState}>
          <View style={styles.successIconWrap}>
            <Ionicons
              name="checkmark-circle"
              size={48}
              color={theme.colors.statusCompleted}
            />
          </View>
          <Text style={styles.centerTitle}>Passwort gesetzt</Text>
          <Text style={styles.centerText}>
            Dein neues Passwort wurde gespeichert. Bitte melde dich damit an.
          </Text>

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace("/login")}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryBtnText}>Zum Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Neues Passwort setzen ──
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.heroArea}>
            <View style={styles.iconWrap}>
              <Ionicons
                name="key-outline"
                size={30}
                color={theme.colors.onPrimaryContainer}
              />
            </View>
            <Text style={styles.title}>Neues Passwort festlegen</Text>
            <Text style={styles.subtitle}>
              Vergib ein neues Passwort für dein Konto.
            </Text>
          </View>

          <View style={styles.card}>
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            <PasswordInput
              label="Neues Passwort"
              placeholder="Mindestens 6 Zeichen"
              value={newPassword}
              onChangeText={(text) => {
                setNewPassword(text);
                if (formError) setFormError("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              editable={!submitting}
            />

            <PasswordInput
              label="Passwort bestätigen"
              placeholder="Passwort wiederholen"
              value={confirmPassword}
              onChangeText={(text) => {
                setConfirmPassword(text);
                if (formError) setFormError("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
              editable={!submitting}
            />

            <TouchableOpacity
              style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
              activeOpacity={0.82}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={theme.colors.onPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Passwort speichern</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.background },
    flex: { flex: 1 },
    scroll: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.gutter,
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.xl,
    },

    heroArea: { alignItems: "center", gap: theme.spacing.md },
    iconWrap: {
      width: 68,
      height: 68,
      borderRadius: theme.radius.xl,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
      maxWidth: 300,
    },

    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.xl,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.xl,
      gap: theme.spacing.lg,
      ...theme.shadows.md,
    },

    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      minHeight: theme.spacing.tapTarget,
      paddingVertical: 14,
      marginTop: theme.spacing.sm,
    },
    primaryBtnDisabled: { opacity: 0.6 },
    primaryBtnText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.onPrimaryContainer,
    },

    linkBtn: { marginTop: theme.spacing.sm, alignItems: "center" },
    linkBtnText: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
      fontFamily: theme.typography.family.semibold,
      color: theme.colors.primary,
    },

    centerState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.xl,
      gap: theme.spacing.sm,
    },
    centerHint: {
      marginTop: theme.spacing.md,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    centerTitle: {
      fontSize: theme.typography.size.xl,
      fontWeight: theme.typography.weight.bold,
      fontFamily: theme.typography.family.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
    },
    centerText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
      maxWidth: 320,
    },
    errorIconWrap: {
      width: 80,
      height: 80,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.errorContainer,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.sm,
    },
    successIconWrap: {
      width: 80,
      height: 80,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusCompletedBg,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.sm,
    },
  });
}
