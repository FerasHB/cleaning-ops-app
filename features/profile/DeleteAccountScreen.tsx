// features/profile/DeleteAccountScreen.tsx
// In-App-Kontolöschung (DSGVO / Google-Play-Account-Deletion-Policy).
// Vollständig theme-aware (Light + Dark). Zweistufige Bestätigung gegen
// versehentliche Löschung: (1) Pflicht-Checkbox „Ich verstehe …", (2) nativer
// Bestätigungsdialog vor der eigentlichen Löschung.
//
// Letzter aktiver Admin (Store-Compliance, Migrationen 20261026000000 +
// 20261028000000, Export → Bestätigen → Löschen): die Löschung entfernt die
// Firma, alle Firmendaten und alle Mitarbeiterkonten; NovaFlow behält kein
// Archiv. Vorher bietet der Screen den Arbeitszeit-Export (PDF/CSV) an, und
// der Admin bestätigt, dass er für seine Aufbewahrungspflichten selbst
// verantwortlich ist. Der Screen lädt dafür zuerst den Lösch-Kontext vom Server und zeigt
// dann einen eigenen, eindeutigen Firmenlösch-Modus mit DREI Pflicht-
// Checkboxen (Konto, Firma, Aufbewahrungspflichten) und einem
// Bestätigungsdialog mit Firmennamen.
//
// Backend: services/account/deleteAccount.ts → Edge Function delete-account.
// Nach Erfolg: lokale Caches leeren, lokal abmelden, zurück zum Login.

import { AppHeader, Card } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { supabase } from "@/lib/supabase";
import {
  getAccountDeletionContext,
  requestAccountDeletion,
  type AccountDeletionContext,
} from "@/services/account/deleteAccount";
import {
  exportWorktimeCsv,
  exportWorktimePdf,
  fetchCompanyWorktimeExport,
} from "@/services/account/worktimeExport";
import { clearPendingJobActions } from "@/services/offline/jobs.queue";
import { clearCachedJobs } from "@/services/offline/jobs.storage";
import { clearCachedProfile } from "@/services/offline/profile.storage";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();

  const { user } = useAuth();

  const [context, setContext] = useState<AccountDeletionContext | null>(null);
  const [contextError, setContextError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedCompany, setConfirmedCompany] = useState(false);
  const [acknowledgedRetention, setAcknowledgedRetention] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [exported, setExported] = useState(false);
  const [loading, setLoading] = useState(false);

  const isAdmin = context?.role === "admin";
  // Firmenlösch-Modus nur, wenn der Server den Aufrufer als letzten aktiven
  // Admin meldet UND eine Firma existiert.
  const companyId = context?.isLastAdmin ? context.companyId : null;
  const isCompanyDeletion = companyId !== null;
  const companyName = context?.companyName ?? "";
  const canDelete =
    context !== null &&
    confirmed &&
    (!isCompanyDeletion || (confirmedCompany && acknowledgedRetention)) &&
    !loading &&
    exporting === null;

  // Arbeitszeit-Export (nur Firmenlösch-Modus). Erzeugt die Datei auf dem
  // Gerät und öffnet den Teilen-Dialog; nichts wird serverseitig abgelegt.
  const handleExport = async (format: "pdf" | "csv") => {
    if (exporting || loading) return;
    setExporting(format);
    try {
      const rows = await fetchCompanyWorktimeExport();
      if (format === "pdf") {
        await exportWorktimePdf(rows, companyName);
      } else {
        await exportWorktimeCsv(rows, companyName);
      }
      setExported(true);
    } catch {
      Alert.alert(t("common:errors.title"), t("profile:deleteAccount.company.exportFailed"));
    } finally {
      setExporting(null);
    }
  };

  const loadContext = useCallback(async () => {
    setContextError(false);
    try {
      setContext(await getAccountDeletionContext());
    } catch {
      setContextError(true);
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  // Pfad hat sich serverseitig geändert (weiterer Admin dazugekommen bzw.
  // weggefallen): Bestätigungen zurücksetzen und Kontext neu laden, damit der
  // Nutzer nie etwas anderes bestätigt, als tatsächlich gelöscht wird.
  const resetAfterPathChange = (message: string) => {
    setConfirmed(false);
    setConfirmedCompany(false);
    setAcknowledgedRetention(false);
    setContext(null);
    void loadContext();
    Alert.alert(t("profile:deleteAccount.notPossibleTitle"), message);
  };

  const email = user?.email ?? t("profile:fallback.myAccount");

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

    const result = await requestAccountDeletion(
      isCompanyDeletion && companyId ? { confirmCompanyId: companyId } : {},
    );

    if (!result.ok) {
      setLoading(false);

      // last_admin: Server sieht den Aufrufer inzwischen als letzten Admin
      // (Firmenlöschung nicht bestätigt). not_last_admin: umgekehrt — es gibt
      // wieder einen weiteren aktiven Admin, die Firma wird NICHT gelöscht.
      // In beiden Fällen nichts gelöscht; Kontext neu laden.
      if (result.code === "last_admin" || result.code === "not_last_admin") {
        resetAfterPathChange(t("profile:deleteAccount.lastAdminChangedMessage"));
        return;
      }

      // result.message kommt aus der Edge Function delete-account (siehe
      // services/account/deleteAccount.ts) — server-seitig formulierter
      // Text, bislang ausschließlich Deutsch. Server-seitige Lokalisierung
      // ist eine spätere Phase (außerhalb des Scopes hier); der Dialog-TITEL
      // ist client-seitig und deshalb übersetzt.
      Alert.alert(t("common:errors.title"), result.message);
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
    if (!canDelete) {
      return;
    }

    Alert.alert(
      isCompanyDeletion
        ? t("profile:deleteAccount.company.confirmDialogTitle", { company: companyName })
        : t("profile:deleteAccount.confirmDialogTitle"),
      isCompanyDeletion
        ? [
            t("profile:deleteAccount.company.confirmDialogMessage"),
            exported ? null : t("profile:deleteAccount.company.notExportedWarning"),
          ]
            .filter(Boolean)
            .join("\n\n")
        : t("profile:deleteAccount.confirmDialogMessage"),
      [
        { text: t("common:actions.cancel"), style: "cancel" },
        {
          text: isCompanyDeletion
            ? t("profile:deleteAccount.company.confirmDialogConfirm")
            : t("profile:deleteAccount.confirmDialogConfirm"),
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

      <AppHeader
        title={t("profile:deleteAccount.headerTitle")}
        showBack
        onBack={() => {
          if (loading) return;
          if (router.canGoBack()) {
            router.back();
            return;
          }
          router.replace("/");
        }}
      />

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
          <Text style={styles.warnTitle}>
            {isCompanyDeletion
              ? t("profile:deleteAccount.company.heroTitle")
              : t("profile:deleteAccount.heroTitle")}
          </Text>
          <Text style={styles.warnSubtitle}>
            {isCompanyDeletion
              ? t("profile:deleteAccount.company.heroSubtitle", { company: companyName })
              : t("profile:deleteAccount.heroSubtitle")}
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

        {context === null ? (
          // ── Kontext lädt / Fehler ──
          contextError ? (
            <View style={styles.contextState}>
              <Text style={styles.contextErrorText}>
                {t("profile:deleteAccount.contextError")}
              </Text>
              <TouchableOpacity
                style={styles.retryButton}
                activeOpacity={0.8}
                onPress={() => void loadContext()}
              >
                <Text style={styles.retryButtonText}>{t("common:actions.retry")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.contextState}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          )
        ) : isCompanyDeletion ? (
          <>
            {/* ── Firmenlöschung: was wird gelöscht ── */}
            <Section
              title={t("profile:deleteAccount.company.whatHappensTitle")}
              theme={theme}
              styles={styles}
            >
              <Bullet
                icon="person-remove-outline"
                text={t("profile:deleteAccount.company.bulletAccount")}
                theme={theme}
                styles={styles}
              />
              <Bullet
                icon="business-outline"
                text={t("profile:deleteAccount.company.bulletCompany", { company: companyName })}
                theme={theme}
                styles={styles}
              />
              <Bullet
                icon="documents-outline"
                text={t("profile:deleteAccount.company.bulletData")}
                theme={theme}
                styles={styles}
              />
              <Bullet
                icon="people-outline"
                text={
                  (context?.otherMemberCount ?? 0) > 0
                    ? t("profile:deleteAccount.company.bulletEmployees", {
                        count: context?.otherMemberCount ?? 0,
                      })
                    : t("profile:deleteAccount.company.bulletNoEmployees")
                }
                theme={theme}
                styles={styles}
                isLast
              />
            </Section>

            {/* ── Arbeitszeit-Export vor der Löschung ── */}
            <Section
              title={t("profile:deleteAccount.company.exportTitle")}
              theme={theme}
              styles={styles}
            >
              <View style={styles.exportBlock}>
                <Text style={styles.exportText}>
                  {t("profile:deleteAccount.company.exportText")}
                </Text>
                <TouchableOpacity
                  style={styles.exportPrimary}
                  activeOpacity={0.85}
                  onPress={() => void handleExport("pdf")}
                  disabled={exporting !== null || loading}
                  accessibilityRole="button"
                >
                  {exporting === "pdf" ? (
                    <ActivityIndicator size="small" color={theme.colors.onPrimary} />
                  ) : (
                    <>
                      <Ionicons name="download-outline" size={18} color={theme.colors.onPrimary} />
                      <Text style={styles.exportPrimaryText}>
                        {t("profile:deleteAccount.company.exportPdfButton")}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.exportSecondary}
                  activeOpacity={0.8}
                  onPress={() => void handleExport("csv")}
                  disabled={exporting !== null || loading}
                  accessibilityRole="button"
                >
                  {exporting === "csv" ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : (
                    <Text style={styles.exportSecondaryText}>
                      {t("profile:deleteAccount.company.exportCsvButton")}
                    </Text>
                  )}
                </TouchableOpacity>
                {exported && (
                  <View style={styles.exportDoneRow}>
                    <Ionicons name="checkmark-circle" size={16} color={theme.colors.statusCompleted} />
                    <Text style={styles.exportDoneText}>
                      {t("profile:deleteAccount.company.exportDone")}
                    </Text>
                  </View>
                )}
              </View>
            </Section>

            <ConfirmCheckbox
              checked={confirmed}
              onToggle={() => setConfirmed((v) => !v)}
              label={t("profile:deleteAccount.checkboxLabel")}
              disabled={loading}
              theme={theme}
              styles={styles}
            />
            <ConfirmCheckbox
              checked={confirmedCompany}
              onToggle={() => setConfirmedCompany((v) => !v)}
              label={t("profile:deleteAccount.company.checkboxCompanyLabel", { company: companyName })}
              disabled={loading}
              theme={theme}
              styles={styles}
            />
            <ConfirmCheckbox
              checked={acknowledgedRetention}
              onToggle={() => setAcknowledgedRetention((v) => !v)}
              label={t("profile:deleteAccount.company.acknowledgeLabel")}
              disabled={loading}
              theme={theme}
              styles={styles}
            />
          </>
        ) : (
          <>
            {/* ── Was passiert ── */}
            <Section title={t("profile:deleteAccount.whatHappensTitle")} theme={theme} styles={styles}>
              <Bullet
                icon="person-remove-outline"
                text={t("profile:deleteAccount.whatHappensBullet1")}
                theme={theme}
                styles={styles}
              />
              <Bullet
                icon="id-card-outline"
                text={t("profile:deleteAccount.whatHappensBullet2")}
                theme={theme}
                styles={styles}
              />
              <Bullet
                icon="log-out-outline"
                text={t("profile:deleteAccount.whatHappensBullet3")}
                theme={theme}
                styles={styles}
                isLast
              />
            </Section>

            {/* ── Verbleibende Daten ── */}
            <Section
              title={t("profile:deleteAccount.remainingDataTitle")}
              theme={theme}
              styles={styles}
            >
              <Bullet
                icon="briefcase-outline"
                text={t("profile:deleteAccount.remainingDataBullet1")}
                theme={theme}
                styles={styles}
              />
              <Bullet
                icon="document-text-outline"
                text={t("profile:deleteAccount.remainingDataBullet2")}
                theme={theme}
                styles={styles}
                isLast
              />
            </Section>

            {/* ── Hinweis für Admins (es gibt weitere aktive Admins) ── */}
            {isAdmin && (
              <View style={styles.adminNote}>
                <Ionicons
                  name="information-circle-outline"
                  size={18}
                  color={theme.colors.statusInProgress}
                />
                <Text style={styles.adminNoteText}>
                  {t("profile:deleteAccount.adminNote")}
                </Text>
              </View>
            )}

            <ConfirmCheckbox
              checked={confirmed}
              onToggle={() => setConfirmed((v) => !v)}
              label={t("profile:deleteAccount.checkboxLabel")}
              disabled={loading}
              theme={theme}
              styles={styles}
            />
          </>
        )}

        {/* ── Löschen-Button ── */}
        <TouchableOpacity
          style={[
            styles.deleteButton,
            !canDelete && styles.deleteButtonDisabled,
          ]}
          activeOpacity={0.85}
          onPress={handleDeletePress}
          disabled={!canDelete}
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
              <Text style={styles.deleteButtonText}>
                {isCompanyDeletion
                  ? t("profile:deleteAccount.company.deleteButton")
                  : t("profile:deleteAccount.deleteButton")}
              </Text>
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
          <Text style={styles.cancelButtonText}>{t("common:actions.cancel")}</Text>
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
// ConfirmCheckbox
// ─────────────────────────────────────────────
function ConfirmCheckbox({
  checked,
  onToggle,
  label,
  disabled,
  theme,
  styles,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  disabled: boolean;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      style={styles.checkboxRow}
      activeOpacity={0.8}
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked && (
          <Ionicons name="checkmark" size={15} color={theme.colors.onPrimary} />
        )}
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </TouchableOpacity>
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
      marginStart: theme.spacing.xs,
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

    // ── Arbeitszeit-Export (Firmenlöschung)
    exportBlock: {
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.md,
    },
    exportText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },
    exportPrimary: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    exportPrimaryText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
      flexShrink: 1,
      textAlign: "center",
    },
    exportSecondary: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outline,
    },
    exportSecondaryText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.primary,
    },
    exportDoneRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    exportDoneText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },

    // ── Kontext lädt / Fehler
    contextState: {
      alignItems: "center",
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.lg,
    },
    contextErrorText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
      lineHeight: theme.typography.lineHeight.sm,
    },
    retryButton: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      minHeight: theme.spacing.tapTarget,
      justifyContent: "center",
    },
    retryButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
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
