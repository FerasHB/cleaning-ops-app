// features/profile/DeleteAccountScreen.tsx
// In-App-Kontolöschung (DSGVO / Google-Play-Account-Deletion-Policy).
// Vollständig theme-aware (Light + Dark). Zweistufige Bestätigung gegen
// versehentliche Löschung: (1) Pflicht-Checkbox „Ich verstehe …", (2) nativer
// Bestätigungsdialog vor der eigentlichen Löschung.
//
// Backend: services/account/deleteAccount.ts → Edge Function delete-account.
// Nach Erfolg: lokale Caches leeren, lokal abmelden, zurück zum Login.

import { Card } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import { requestAccountDeletion } from "@/services/account/deleteAccount";
import { clearPendingJobActions } from "@/services/offline/jobs.queue";
import { clearCachedJobs } from "@/services/offline/jobs.storage";
import { clearCachedProfile } from "@/services/offline/profile.storage";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function DeleteAccountScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { user, role } = useAuth();
  const isAdmin = role === "admin";

  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);

  const email = user?.email ?? "dein Konto";

  // Leert ALLE lokalen persistenten Caches, damit auf einem geteilten Gerät
  // keine Daten des gelöschten Kontos zurückbleiben.
  const clearAllLocalData = async () => {
    await Promise.all([
      clearCachedProfile(),
      clearCachedJobs(),
      clearPendingJobActions(),
    ]);
  };

  // Führt die Löschung aus (nach der nativen Bestätigung). Wirft nie.
  const runDeletion = async () => {
    setLoading(true);

    const result = await requestAccountDeletion();

    if (!result.ok) {
      setLoading(false);

      if (result.code === "last_admin") {
        Alert.alert("Löschung nicht möglich", result.message);
        return;
      }

      Alert.alert("Fehler", result.message);
      return;
    }

    // ── Erfolg: lokal aufräumen und abmelden. ──
    // Wichtig: scope "local" verwenden — ein serverseitiger Logout würde für
    // das bereits gelöschte Konto fehlschlagen. Der lokale Logout löst den
    // SIGNED_OUT-Auth-Event aus → AuthContext setzt Session/Profil zurück,
    // die authentifizierten Screens werden verlassen.
    await clearAllLocalData();
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});

    // Auf das Routing-Gate zurück; ohne Session leitet es nach /welcome.
    router.replace("/");
  };

  // Erste Stufe: nur mit gesetzter Checkbox; zweite Stufe = nativer Dialog.
  const handleDeletePress = () => {
    if (!confirmed || loading) {
      return;
    }

    Alert.alert(
      "Konto endgültig löschen?",
      "Diese Aktion kann nicht rückgängig gemacht werden. Dein Konto und dein " +
        "Profil werden dauerhaft gelöscht.",
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Endgültig löschen",
          style: "destructive",
          onPress: () => {
            void runDeletion();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          activeOpacity={0.8}
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace("/");
          }}
          disabled={loading}
        >
          <Ionicons
            name="chevron-back"
            size={18}
            color={theme.colors.onSurface}
          />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Konto löschen</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Warn-Header ── */}
        <View style={styles.warnHero}>
          <View style={styles.warnIcon}>
            <Ionicons
              name="warning-outline"
              size={26}
              color={theme.colors.error}
            />
          </View>
          <Text style={styles.warnTitle}>Konto dauerhaft löschen</Text>
          <Text style={styles.warnSubtitle}>
            Diese Aktion ist unwiderruflich und kann nicht rückgängig gemacht
            werden.
          </Text>
          <View style={styles.emailChip}>
            <Ionicons
              name="mail-outline"
              size={13}
              color={theme.colors.onSurfaceVariant}
            />
            <Text style={styles.emailChipText} numberOfLines={1}>
              {email}
            </Text>
          </View>
        </View>

        {/* ── Was passiert ── */}
        <Section title="Was passiert bei der Löschung?" theme={theme} styles={styles}>
          <Bullet
            icon="person-remove-outline"
            text="Dein Anmeldekonto (E-Mail und Passwort) wird dauerhaft entfernt."
            theme={theme}
            styles={styles}
          />
          <Bullet
            icon="id-card-outline"
            text="Dein Profil (Name, Telefonnummer, Push-Token) wird gelöscht."
            theme={theme}
            styles={styles}
          />
          <Bullet
            icon="log-out-outline"
            text="Du wirst sofort abgemeldet und verlierst den Zugriff auf die App."
            theme={theme}
            styles={styles}
            isLast
          />
        </Section>

        {/* ── Verbleibende Daten (anonymisiert) ── */}
        <Section
          title="Welche Daten bleiben erhalten?"
          theme={theme}
          styles={styles}
        >
          <Bullet
            icon="briefcase-outline"
            text={
              "Aufträge, Kommentare und Fotos, die du erstellt oder bearbeitet " +
              "hast, bleiben aus betrieblichen und rechtlichen Gründen bei " +
              "deinem Unternehmen erhalten."
            }
            theme={theme}
            styles={styles}
          />
          <Bullet
            icon="eye-off-outline"
            text={
              "Diese Einträge werden jedoch anonymisiert – sie sind danach nicht " +
              "mehr mit deinem Namen oder Konto verknüpft."
            }
            theme={theme}
            styles={styles}
            isLast
          />
        </Section>

        {/* ── Hinweis für Admins ── */}
        {isAdmin && (
          <View style={styles.adminNote}>
            <Ionicons
              name="information-circle-outline"
              size={18}
              color={theme.colors.statusInProgress}
            />
            <Text style={styles.adminNoteText}>
              Als Administrator kannst du dein Konto nur löschen, wenn ein
              weiterer aktiver Administrator existiert. Bist du der einzige
              Administrator deiner Firma, löse zuerst die Firma auf oder ernenne
              einen weiteren Administrator.
            </Text>
          </View>
        )}

        {/* ── Bestätigungs-Checkbox ── */}
        <TouchableOpacity
          style={styles.checkboxRow}
          activeOpacity={0.8}
          onPress={() => setConfirmed((v) => !v)}
          disabled={loading}
        >
          <View
            style={[styles.checkbox, confirmed && styles.checkboxChecked]}
          >
            {confirmed && (
              <Ionicons
                name="checkmark"
                size={15}
                color={theme.colors.onPrimary}
              />
            )}
          </View>
          <Text style={styles.checkboxLabel}>
            Ich verstehe, dass diese Aktion unwiderruflich ist und mein Konto
            dauerhaft gelöscht wird.
          </Text>
        </TouchableOpacity>

        {/* ── Löschen-Button ── */}
        <TouchableOpacity
          style={[
            styles.deleteButton,
            (!confirmed || loading) && styles.deleteButtonDisabled,
          ]}
          activeOpacity={0.85}
          onPress={handleDeletePress}
          disabled={!confirmed || loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color={theme.colors.error} />
          ) : (
            <>
              <Ionicons
                name="trash-outline"
                size={18}
                color={theme.colors.error}
              />
              <Text style={styles.deleteButtonText}>Konto endgültig löschen</Text>
            </>
          )}
        </TouchableOpacity>

        {/* ── Abbrechen ── */}
        <TouchableOpacity
          style={styles.cancelButton}
          activeOpacity={0.7}
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace("/");
          }}
          disabled={loading}
        >
          <Text style={styles.cancelButtonText}>Abbrechen</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// Section
// ─────────────────────────────────────────────
function Section({
  title,
  children,
  theme,
  styles,
}: {
  title: string;
  children: React.ReactNode;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Card padding={0}>
        <View style={styles.sectionInner}>{children}</View>
      </Card>
    </View>
  );
}

// ─────────────────────────────────────────────
// Bullet
// ─────────────────────────────────────────────
function Bullet({
  icon,
  text,
  theme,
  styles,
  isLast = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  text: string;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.bulletRow, !isLast && styles.bulletDivider]}>
      <View style={styles.bulletIcon}>
        <Ionicons name={icon} size={16} color={theme.colors.onSurfaceVariant} />
      </View>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },

    // ── Header
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    backButton: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      textAlign: "center",
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    headerSpacer: {
      width: 36,
    },

    // ── Content
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
      gap: theme.spacing.xl,
    },

    // ── Warn hero
    warnHero: {
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    warnIcon: {
      width: 56,
      height: 56,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.errorContainer,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.xs,
    },
    warnTitle: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      textAlign: "center",
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    warnSubtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
      maxWidth: 300,
    },
    emailChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 5,
      marginTop: theme.spacing.xs,
      maxWidth: "100%",
    },
    emailChipText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },

    // ── Section
    section: {
      gap: theme.spacing.sm,
    },
    sectionTitle: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wider,
      textTransform: "uppercase",
      marginLeft: theme.spacing.xs,
    },
    sectionInner: {
      paddingHorizontal: theme.spacing.md,
    },

    // ── Bullet
    bulletRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.md,
      paddingVertical: 14,
    },
    bulletDivider: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    bulletIcon: {
      width: 30,
      height: 30,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    bulletText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // ── Admin note
    adminNote: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    adminNoteText: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // ── Checkbox
    checkboxRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    checkbox: {
      width: 24,
      height: 24,
      borderRadius: theme.radius.sm,
      borderWidth: 2,
      borderColor: theme.colors.outline,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: {
      backgroundColor: theme.colors.error,
      borderColor: theme.colors.error,
    },
    checkboxLabel: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // ── Delete button
    deleteButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.colors.errorContainer,
      borderWidth: 1,
      borderColor: theme.colors.error,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    deleteButtonDisabled: {
      opacity: 0.45,
    },
    deleteButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.error,
    },

    // ── Cancel
    cancelButton: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: theme.spacing.sm,
      minHeight: theme.spacing.tapTarget,
    },
    cancelButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
