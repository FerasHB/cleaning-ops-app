// features/auth/ResetPasswordScreen.tsx
// Ziel des Passwort-Reset-Deep-Links (taskopsmanager://reset-password, im
// Development-Build taskopsmanagerdev://reset-password).
// Die eigentliche Link-Einlösung (PKCE/Implicit, Mehrfachquellen, Watchdog)
// steckt in useAuthLinkSession — dieser Screen kümmert sich nur noch um das
// "neues Passwort setzen"-Formular und die reset-spezifische Copy/CTA.

import { ErrorBanner, PasswordInput } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useAuthLinkSession } from "@/features/auth/useAuthLinkSession";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import { MIN_PASSWORD_LENGTH, validateNewPassword } from "@/utils/passwordValidation";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
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

const DEFAULT_INVALID_MESSAGE =
  "Der Link ist ungültig. Bitte fordere einen neuen Link an.";
const EXPIRED_RESET_MESSAGE =
  "Der Link zum Zurücksetzen des Passworts ist abgelaufen. Bitte fordere einen neuen Link an.";

export default function ResetPasswordScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { endRecoverySession } = useAuth();
  const { status, invalidMessage, recheck } = useAuthLinkSession(
    DEFAULT_INVALID_MESSAGE,
    EXPIRED_RESET_MESSAGE,
    // SICHERHEITSGRENZE: markiert die entstehende Session als reine
    // Reset-Sitzung — siehe services/auth/recoveryMode.ts.
    "recovery",
  );

  // Abbruch des Reset-Flows ("Zurück zum Login"): Recovery-Modus beenden UND
  // die Recovery-Session abmelden. Ohne den Sign-out bliebe eine gültige
  // Session zurück, die nach dem Aufheben des Markers plötzlich als normaler
  // App-Zugang zählen würde.
  const handleAbandonRecovery = async () => {
    await endRecoverySession({ signOutSession: true });
    router.replace("/login");
  };

  const [formSuccess, setFormSuccess] = useState(false);
  // Echter RPC-Fehlschlag (nicht "kein Treffer" für Admins/bereits
  // akzeptierte Mitarbeiter/Legacy — das ist ein erwartetes No-Op ohne
  // Fehler) — hält die Recovery-Session bewusst OFFEN für einen echten Retry
  // statt den Nutzer stillschweigend zum Login zu schicken, wo er ohne
  // gültiges Einladungstoken im selben Umleitungs-Loop wie vor diesem Fix
  // landen könnte (siehe finishAfterPasswordSet).
  const [acceptInviteRetryNeeded, setAcceptInviteRetryNeeded] = useState(false);
  const [retryingAccept, setRetryingAccept] = useState(false);
  // Nur wahr, wenn der Nutzer nach einem fehlgeschlagenen Retry explizit
  // "Trotzdem fortfahren" gewählt hat — steuert die Erfolgsanzeige unten.
  const [acceptInviteGaveUp, setAcceptInviteGaveUp] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const passwordMeetsLength = newPassword.length >= MIN_PASSWORD_LENGTH;

  const handleSubmit = async () => {
    const validationError = validateNewPassword(newPassword, confirmPassword);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setFormError("");
    setSubmitting(true);

    try {
      // VORBEDINGUNG: ohne aktive Recovery-Session darf hier gar nicht erst
      // geschrieben werden. Ohne diese Prüfung lief updateUser() im P0-Fehler
      // gegen eine sachfremde Alt-Session — der Reset meldete Erfolg, das
      // Passwort des Recovery-Kontos blieb aber unverändert.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        setFormError(
          "Deine Sitzung für das Zurücksetzen ist nicht mehr gültig. Bitte fordere einen neuen Link an.",
        );
        return;
      }

      const { data: updated, error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        setFormError(
          toFriendlyAuthErrorMessage(error, "Passwort konnte nicht gesetzt werden."),
        );
        return;
      }

      // Supabase liefert bei Erfolg den aktualisierten User zurück. Fehlt er,
      // wurde NICHTS bestätigt geändert — dann darf hier kein Erfolg erscheinen.
      if (!updated?.user) {
        setFormError("Passwort konnte nicht gesetzt werden.");
        return;
      }

      // Das Passwort ist ab hier UNWIDERRUFLICH gesetzt — wird nicht mehr
      // zurückgerollt, egal was im nächsten Schritt passiert.
      await finishAfterPasswordSet();
    } catch (err) {
      setFormError(toFriendlyAuthErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Schließt eine noch offene Mitarbeiter-Einladung ab: ein Mitarbeiter,
  // dessen accept-invite-Sitzungstoken abgelaufen ist, BEVOR dort ein
  // Passwort gesetzt wurde, hat eine bestätigte E-Mail, aber
  // profiles.invite_accepted_at bleibt NULL — app/index.tsx leitet ihn sonst
  // bei JEDEM Login dauerhaft auf /accept-invite um (Redirect-Loop, siehe
  // 20260906000000_accept_own_invite_recovery_completion.sql). Die RPC
  // grenzt serverseitig auf role='employee' AND invite_accepted_at IS NULL
  // ein — für Admins, bereits akzeptierte Mitarbeiter und Legacy-Konten ist
  // dieser Aufruf ein reines, fehlerfreies No-Op. MUSS vor
  // endRecoverySession() laufen, solange auth.uid() noch die gültige
  // Recovery-Session ist — auch beim Retry unten, deshalb hält
  // handleRetryAcceptInvite die Session bis zum Erfolg bewusst offen.
  //
  // Schlägt der AUFRUF SELBST fehl (Netzwerk/Serverfehler, nicht "kein
  // Treffer" — das ist der oben beschriebene No-Op-Fall ohne Fehler), wird
  // NICHT stillschweigend zum Login weitergeleitet: ein wirklich betroffener
  // Mitarbeiter würde dort ohne gültiges Einladungstoken im selben
  // Umleitungs-Loop wie vor diesem Fix landen. Stattdessen bleibt die Session
  // offen und der Nutzer bekommt einen echten Retry-Bildschirm.
  const finishAfterPasswordSet = async () => {
    const { error: acceptError } = await supabase.rpc("accept_own_invite");

    if (acceptError) {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.warn("accept_own_invite fehlgeschlagen:", acceptError.message);
      }
      setAcceptInviteRetryNeeded(true);
      return;
    }

    setAcceptInviteRetryNeeded(false);

    // SICHERHEITSGRENZE: Recovery-Modus beenden UND abmelden. Der Nutzer
    // soll sich bewusst mit dem NEUEN Passwort anmelden — aus dem
    // Reset-Link heraus entsteht nie eine App-Sitzung.
    await endRecoverySession({ signOutSession: true });

    setFormSuccess(true);
  };

  const handleRetryAcceptInvite = async () => {
    setRetryingAccept(true);
    try {
      await finishAfterPasswordSet();
    } finally {
      setRetryingAccept(false);
    }
  };

  // Ausweg, falls der Abschluss-Schritt wiederholt fehlschlägt (z.B.
  // dauerhafter Verbindungsfehler): der Nutzer hat trotzdem ein gültiges,
  // gespeichertes Passwort und soll nicht auf diesem Bildschirm feststecken.
  const handleContinueAnyway = async () => {
    setAcceptInviteGaveUp(true);
    setAcceptInviteRetryNeeded(false);
    await endRecoverySession({ signOutSession: true });
    setFormSuccess(true);
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
            onPress={recheck}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Link erneut prüfen</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={handleAbandonRecovery}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Zurück zum Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Erfolgreich gesetzt ──
  if (formSuccess) {
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
          {acceptInviteGaveUp ? (
            // Nur nach explizitem "Trotzdem fortfahren" auf dem Retry-
            // Bildschirm (siehe unten): das Passwort ist gesetzt, aber ein
            // abschließender Serverschritt blieb fehlgeschlagen — falls das
            // den Zugang betrifft, soll das nicht stillschweigend als
            // vollständiger Erfolg erscheinen.
            <Text style={styles.centerText}>
              Solltest du dich danach nicht wie gewohnt anmelden können, wende
              dich bitte an deinen Administrator.
            </Text>
          ) : null}

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

  // ── Passwort gesetzt, aber ein abschließender Schritt ist fehlgeschlagen ──
  // Die Recovery-Session bleibt hier bewusst offen (siehe
  // finishAfterPasswordSet) — echter Retry statt stillschweigend zum Login,
  // wo ein wirklich betroffener Mitarbeiter ohne gültiges Einladungstoken im
  // selben Umleitungs-Loop wie vor diesem Fix landen könnte.
  if (acceptInviteRetryNeeded) {
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
          <Text style={styles.centerTitle}>Fast geschafft</Text>
          <Text style={styles.centerText}>
            Dein neues Passwort wurde gespeichert. Ein letzter Schritt zur
            Fertigstellung deines Kontos ist aber fehlgeschlagen. Bitte
            versuche es erneut, solange du hier bist.
          </Text>

          <TouchableOpacity
            style={[styles.primaryBtn, retryingAccept && styles.primaryBtnDisabled]}
            onPress={handleRetryAcceptInvite}
            disabled={retryingAccept}
            activeOpacity={0.82}
          >
            {retryingAccept ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.primaryBtnText}>Erneut versuchen</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={handleContinueAnyway}
            activeOpacity={0.75}
          >
            <Text style={styles.linkBtnText}>Trotzdem fortfahren</Text>
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

            <View style={styles.passwordField}>
              <PasswordInput
                label="Neues Passwort"
                placeholder="Mindestens 10 Zeichen"
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
              <View style={styles.passwordHintRow}>
                <Ionicons
                  name={passwordMeetsLength ? "checkmark-circle" : "ellipse-outline"}
                  size={14}
                  color={passwordMeetsLength ? theme.colors.statusCompleted : theme.colors.outline}
                />
                <Text
                  style={[
                    styles.passwordHintText,
                    passwordMeetsLength && styles.passwordHintTextMet,
                  ]}
                >
                  Mindestens {MIN_PASSWORD_LENGTH} Zeichen
                </Text>
              </View>
            </View>

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

    // Passwort-Feld + Live-Anforderungshinweis
    passwordField: { gap: 6 },
    passwordHintRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingLeft: 2,
    },
    passwordHintText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },
    passwordHintTextMet: {
      color: theme.colors.statusCompleted,
      fontFamily: theme.typography.family.medium,
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
