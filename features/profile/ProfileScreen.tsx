// features/profile/ProfileScreen.tsx
// Profile / Settings Tab (Employee + Admin) im SaaS-Settings-Stil.
// Vollständig theme-aware (Light + Dark Mode).
// Business-Logik unverändert: nutzt nur profile/role/user/signOut aus AuthContext.
//
// JEDE Zeile mit Chevron führt auch wirklich irgendwohin. Früher waren sieben
// der elf Zeilen reine Attrappen ("Bald"): sie sahen aus wie Navigation, ein
// Tap brachte aber nur ein "Diese Funktion kommt später."-Alert — das im Web
// nicht einmal erschien (Alert.alert ist dort eine leere Attrappe). Die
// Attrappen sind entfernt; rein informative Werte (E-Mail, Sprache) stehen
// jetzt als nicht tippbare Info-Zeilen ohne Chevron.

import { ActionMenuSheet, Card, InitialsAvatar } from "@/components/ui";
import type { ActionMenuItem } from "@/components/ui";
import { alertDialog, callPhone, confirmDialog } from "@/utils/dialogs";
import { useAuth } from "@/context/AuthContext";
import { useOwnCompany } from "@/features/company/hooks/useOwnCompany";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useIsRTL } from "@/hooks/useIsRTL";
import { formatPhoneForDisplay } from "@/utils/phone";
import type { AppTheme } from "@/constants/theme";
import {
  changeAppLanguage,
  LANGUAGE_NAMES,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/i18n";
import { updateOwnLocale } from "@/services/profile/updateOwnLocale";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";

const APP_VERSION =
  Constants.expoConfig?.version ??
  (Constants as any).manifest?.version ??
  "1.0.0";

export default function ProfileScreen({
  showBack = false,
}: {
  showBack?: boolean;
}) {
  const theme = useAppTheme();
  const isRTL = useIsRTL();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { user, profile, role, signOut } = useAuth();
  const { company } = useOwnCompany();
  const { t, i18n } = useTranslation();
  const [languageSheetVisible, setLanguageSheetVisible] = useState(false);

  const activeLocale = (i18n.language as AppLocale) ?? "de";
  const languageItems: ActionMenuItem[] = SUPPORTED_LOCALES.map((locale) => ({
    key: locale,
    label: LANGUAGE_NAMES[locale],
    icon: locale === activeLocale ? "checkmark-circle" : "ellipse-outline",
  }));

  // Sprachwechsel: i18next + Persistenz laufen in changeAppLanguage()
  // (i18n/index.ts). Ein geändertes natives RTL-Flag (aktuell nur bei
  // Arabisch) wirkt erst nach einem vollständigen Neustart — siehe
  // i18n/rtl.ts. Wir lösen den Neustart hier bewusst NICHT selbst aus
  // (kein expo-updates in diesem Projekt, kein Risiko einer Neustart-
  // Schleife), sondern zeigen nur einen klaren Hinweis.
  //
  // updateOwnLocale() synchronisiert die Sprache zusätzlich zum Server
  // (profiles.locale) — ausschließlich relevant für Push-Benachrichtigungen
  // (Phase E). Bewusst NACH dem lokalen Wechsel und in eigenem try/catch:
  // ein Server-/Offline-Fehler darf den bereits vollzogenen lokalen
  // Sprachwechsel nie rückgängig machen oder verzögern.
  const handleSelectLanguage = async (key: string) => {
    setLanguageSheetVisible(false);
    const locale = key as AppLocale;
    if (locale === activeLocale) return;

    const { restartRequired } = await changeAppLanguage(locale);
    if (restartRequired) {
      await alertDialog(t("common:language.restartTitle"), t("common:language.restartMessage"));
    }

    try {
      await updateOwnLocale(locale);
    } catch {
      // Best effort — die lokale UI-Sprache ist bereits gewechselt.
    }
  };

  const email = user?.email ?? t("profile:fallback.noEmail");
  const fullName = profile?.full_name?.trim() || email;
  const phone = profile?.phone?.trim() || null;
  const isAdmin = role === "admin";
  const hasCompany = !!profile?.company_id;
  const companyLabel =
    company?.name?.trim() || (hasCompany ? t("profile:fallback.companyConnected") : null);

  // ── Logout mit Bestätigung
  // Läuft über confirmDialog/alertDialog statt direkt über Alert.alert:
  // Alert ist im Web eine leere Attrappe, der onPress-Callback wurde dort nie
  // ausgeführt und das Abmelden war damit unmöglich (siehe utils/dialogs.ts).
  // Die signOut-Logik selbst ist unverändert — sie wurde nur nie erreicht.
  const handleLogout = async () => {
    const bestaetigt = await confirmDialog({
      title: t("profile:dialogs.logout"),
      message: t("profile:dialogs.logoutMessage"),
      confirmLabel: t("profile:dialogs.logout"),
      destructive: true,
    });

    if (!bestaetigt) {
      return;
    }

    try {
      await signOut();
    } catch (error) {
      // Fehler NICHT verschlucken: vorher lief dieser Zweig in ein Alert, das
      // im Web nichts anzeigte — ein fehlgeschlagener Logout sah damit aus wie
      // gar keine Reaktion. Der Nutzer bleibt bewusst angemeldet, statt in
      // einen halb abgemeldeten Zustand zu geraten.
      const grund = toFriendlyAuthErrorMessage(error, t("common:errors.unknown"));
      await alertDialog(
        t("profile:dialogs.logoutFailedTitle"),
        `${grund}\n\n${t("profile:dialogs.logoutFailedSuffix")}`,
      );
      return;
    }

    // Nach dem Abmelden immer zur Anmeldung (Login). router.replace ersetzt die
    // aktuelle Route und die geschützten Gruppen werden durch die Auth-Gates
    // entfernt → kein Zurück in geschützte Screens.
    router.replace("/login");
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Optionaler Zurück-Button (außerhalb der Tabs) ── */}
        {showBack && (
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
          >
            <Ionicons
              name={isRTL ? "chevron-forward" : "chevron-back"}
              size={18}
              color={theme.colors.onSurface}
            />
            <Text style={styles.backButtonText}>{t("common:actions.back")}</Text>
          </TouchableOpacity>
        )}

        {/* ── Profile Header ── */}
        <Card style={styles.profileCard}>
          <InitialsAvatar name={fullName} size={64} />
          <View style={styles.profileInfo}>
            <Text style={styles.profileName} numberOfLines={1}>
              {fullName}
            </Text>
            <Text style={styles.profileEmail} numberOfLines={1}>
              {email}
            </Text>

            <View style={styles.badgeRow}>
              <View style={styles.roleBadge}>
                <View style={styles.roleDot} />
                <Text style={styles.roleText}>
                  {isAdmin ? t("profile:roles.admin") : t("profile:roles.employee")}
                </Text>
              </View>

              {companyLabel && (
                <View style={styles.companyBadge}>
                  <Ionicons
                    name="business-outline"
                    size={12}
                    color={theme.colors.onSurfaceVariant}
                  />
                  <Text style={styles.companyText} numberOfLines={1}>
                    {companyLabel}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </Card>

        {/* ── Meine Arbeit (nur Mitarbeiter) ──
            Die eigene erfasste Arbeitszeit war bisher überhaupt nicht
            erreichbar: /timesheets war nur über das Admin-Dashboard und den
            Admin-Bereich dieses Screens verlinkt. Mitarbeitende kommen jetzt
            hier an ihre eigenen Zeiten (gleiche Berechnung, eigene Sicht). */}
        {!isAdmin && (
          <SettingsSection title={t("profile:sections.myWork")} styles={styles} theme={theme}>
            <SettingsRow
              icon="time-outline"
              label={t("profile:rows.myWorkingHours")}
              onPress={() => router.push("/timesheets")}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="calendar-outline"
              label={t("profile:rows.absences")}
              onPress={() => router.push("/absences")}
              isLast
              styles={styles}
              theme={theme}
            />
          </SettingsSection>
        )}

        {/* ── Account ── */}
        <SettingsSection title={t("profile:sections.account")} styles={styles} theme={theme}>
          <SettingsRow
            icon="person-outline"
            label={t("profile:rows.editProfile")}
            value={fullName}
            onPress={() => router.push("/profile/edit")}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="call-outline"
            label={t("profile:rows.phone")}
            value={phone ? formatPhoneForDisplay(phone) : t("common:states.notProvided")}
            onPress={phone ? () => void callPhone(phone, { label: fullName }) : undefined}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="mail-outline"
            label={t("profile:rows.email")}
            value={email}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="lock-closed-outline"
            label={t("profile:rows.changePassword")}
            onPress={() => router.push("/change-password")}
            isLast
            styles={styles}
            theme={theme}
          />
        </SettingsSection>

        {/* ── App ── */}
        <SettingsSection
          title={t("common:language.sectionTitle")}
          styles={styles}
          theme={theme}
        >
          <SettingsRow
            icon="language-outline"
            label={t("common:language.label")}
            value={LANGUAGE_NAMES[activeLocale]}
            onPress={() => setLanguageSheetVisible(true)}
            styles={styles}
            theme={theme}
          />
          {/* alertDialog statt Alert.alert: Alert ist im Web eine leere
              Attrappe — der Hinweis erschien dort nie. */}
          <SettingsRow
            icon="contrast-outline"
            label={t("profile:rows.appearance")}
            value={t("profile:rows.appearanceValue")}
            onPress={() => {
              void alertDialog(
                t("profile:dialogs.appearanceTitle"),
                t("profile:dialogs.appearanceMessage"),
              );
            }}
            isLast
            styles={styles}
            theme={theme}
          />
        </SettingsSection>

        {/* ── Administration (nur Admin) ── */}
        {isAdmin && (
          <SettingsSection
            title={t("admin:profile.sectionTitle")}
            styles={styles}
            theme={theme}
          >
            <SettingsRow
              icon="business-outline"
              label={t("admin:companySettings.headerTitle")}
              value={company?.name ?? undefined}
              onPress={() => router.push("/company-settings")}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="people-outline"
              label={t("admin:profile.manageTeamRow")}
              onPress={() => router.push("/(admin-tabs)/employees")}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="calendar-outline"
              label={t("admin:absenceAdmin.headerTitle")}
              onPress={() => router.push("/admin/absences")}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="document-text-outline"
              label={t("timesheets:titleAdmin")}
              onPress={() => router.push("/timesheets")}
              isLast
              styles={styles}
              theme={theme}
            />
          </SettingsSection>
        )}

        {/* ── Konto & App-Info ── */}
        <SettingsSection title={t("profile:sections.other")} styles={styles} theme={theme}>
          <SettingsRow
            icon="trash-outline"
            label={t("profile:rows.deleteAccount")}
            onPress={() => router.push("/delete-account")}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="information-circle-outline"
            label={t("profile:rows.appVersion")}
            value={t("profile:rows.appVersionValue", { version: APP_VERSION })}
            isLast
            styles={styles}
            theme={theme}
          />
        </SettingsSection>

        {/* ── Logout ── */}
        <TouchableOpacity
          style={styles.logoutButton}
          activeOpacity={0.8}
          onPress={handleLogout}
        >
          <Ionicons
            name="log-out-outline"
            size={18}
            color={theme.colors.error}
          />
          <Text style={styles.logoutButtonText}>{t("profile:dialogs.logout")}</Text>
        </TouchableOpacity>
      </ScrollView>

      <ActionMenuSheet
        visible={languageSheetVisible}
        title={t("common:language.label")}
        items={languageItems}
        onClose={() => setLanguageSheetVisible(false)}
        onSelect={handleSelectLanguage}
      />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// SettingsSection
// ─────────────────────────────────────────────
function SettingsSection({
  title,
  children,
  styles,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Card padding={0}>{children}</Card>
    </View>
  );
}

// ─────────────────────────────────────────────
// SettingsRow
// ─────────────────────────────────────────────
// Ohne `onPress` ist die Zeile eine reine Info-Zeile: kein Touchable, kein
// Chevron — sie sieht damit nicht mehr aus wie etwas, das irgendwohin führt.
function SettingsRow({
  icon,
  label,
  value,
  onPress,
  isLast = false,
  styles,
  theme,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value?: string;
  onPress?: () => void;
  isLast?: boolean;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.7 } : {};
  const isRTL = useIsRTL();

  return (
    <Wrapper
      style={[styles.row, !isLast && styles.rowDivider]}
      {...wrapperProps}
    >
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={18} color={theme.colors.onSurfaceVariant} />
      </View>

      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>

      <View style={styles.rowRight}>
        {value ? (
          <Text style={styles.rowValue} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {onPress && (
          <Ionicons
            name={isRTL ? "chevron-back" : "chevron-forward"}
            size={16}
            color={theme.colors.outline}
          />
        )}
      </View>
    </Wrapper>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },

    // ── Zurück-Button (optional)
    backButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-start",
      marginBottom: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 8,
    },
    backButtonText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },

    // ── Profile Header Card
    profileCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.xl,
    },
    profileInfo: {
      flex: 1,
      gap: 2,
    },
    profileName: {
      fontSize: theme.typography.size.lg,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    profileEmail: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    badgeRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.sm,
    },
    roleBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.colors.statusInProgressBg,
      borderWidth: 1,
      borderColor: theme.colors.statusInProgressBorder,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
    },
    roleDot: {
      width: 6,
      height: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgress,
    },
    roleText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusInProgress,
    },
    companyBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
    },
    companyText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Section
    section: {
      marginBottom: theme.spacing.xl,
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

    // ── Row
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 14,
      minHeight: theme.spacing.tapTarget,
    },
    rowDivider: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.outlineVariant,
    },
    rowIcon: {
      width: 34,
      height: 34,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
    },
    rowLabel: {
      flex: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    rowRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      maxWidth: "45%",
    },
    rowValue: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },

    // ── Logout
    logoutButton: {
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
      marginTop: theme.spacing.sm,
    },
    logoutButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.error,
    },
  });
}
