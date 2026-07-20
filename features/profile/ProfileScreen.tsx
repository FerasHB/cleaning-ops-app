// features/profile/ProfileScreen.tsx
// Profile / Settings Tab (Employee + Admin) im SaaS-Settings-Stil.
// Vollständig theme-aware (Light + Dark Mode).
// Business-Logik unverändert: nutzt nur profile/role/user/signOut aus AuthContext.
//
// Hinweis: Die meisten Rows sind bewusst UI-only ("Bald"). Echte Funktion haben:
// - "Team verwalten" (Admin) → navigiert zu /(admin-tabs)/employees
// - "Abmelden" → bestehende signOut-Funktion
// - "Erscheinungsbild" → Info, dass die App der Systemeinstellung folgt (kein eigener Toggle)

import { Card, InitialsAvatar } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { AppTheme } from "@/constants/theme";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { router } from "expo-router";
import React, { useMemo } from "react";
import {
  Alert,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const APP_VERSION =
  Constants.expoConfig?.version ??
  (Constants as any).manifest?.version ??
  "1.0.0";

const COMING_SOON_MSG = "Diese Funktion kommt später.";

function showComingSoon() {
  Alert.alert("Bald verfügbar", COMING_SOON_MSG);
}

export default function ProfileScreen({
  showBack = false,
}: {
  showBack?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { user, profile, role, signOut } = useAuth();

  const email = user?.email ?? "Keine E-Mail";
  const fullName = profile?.full_name?.trim() || email;
  const isAdmin = role === "admin";
  const hasCompany = !!profile?.company_id;

  // ── Account- und Datenlöschung: öffnet die Mail-App mit vorausgefüllter
  // Vorlage (kein echtes Löschsystem — nur mailto-Link, siehe Datenschutz-
  // /Account-Löschungs-Text: Anfrage per E-Mail an info@novaflowdigital.de).
  const handleRequestDeletion = () => {
    const subject = "Account- und Datenlöschung – TaskOps Manager";
    const body = `Hallo,

ich möchte die Löschung meines Nutzerkontos und meiner personenbezogenen Daten in TaskOps Manager beantragen.

Name:
${profile?.full_name?.trim() || "[bitte ergänzen]"}

Registrierte E-Mail:
${user?.email || "[bitte ergänzen]"}

Unternehmen / Company:
[bitte ergänzen]

Technische Company-ID:
${profile?.company_id || "[bitte ergänzen]"}

Vielen Dank.`;

    const url = `mailto:info@novaflowdigital.de?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    Linking.openURL(url).catch(() => {
      Alert.alert(
        "Keine Mail-App gefunden",
        "Bitte sende eine E-Mail an info@novaflowdigital.de.",
      );
    });
  };

  // ── Logout mit Bestätigung (signOut-Logik unverändert)
  const handleLogout = () => {
    Alert.alert("Abmelden", "Möchtest du dich wirklich abmelden?", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Abmelden",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
            // Nach dem Abmelden immer zur Anmeldung (Login). router.replace
            // ersetzt die aktuelle Route und die geschützten Gruppen werden
            // durch die Auth-Gates entfernt → kein Zurück in geschützte Screens.
            router.replace("/login");
          } catch {
            Alert.alert("Fehler", "Logout fehlgeschlagen.");
          }
        },
      },
    ]);
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
              name="chevron-back"
              size={18}
              color={theme.colors.onSurface}
            />
            <Text style={styles.backButtonText}>Zurück</Text>
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
                  {isAdmin ? "Admin" : "Mitarbeiter"}
                </Text>
              </View>

              {hasCompany && (
                <View style={styles.companyBadge}>
                  <Ionicons
                    name="business-outline"
                    size={12}
                    color={theme.colors.onSurfaceVariant}
                  />
                  <Text style={styles.companyText}>Firma verbunden</Text>
                </View>
              )}
            </View>
          </View>
        </Card>

        {/* ── Account ── */}
        <SettingsSection title="Account" styles={styles} theme={theme}>
          <SettingsRow
            icon="person-outline"
            label="Profil bearbeiten"
            comingSoon
            onPress={showComingSoon}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="mail-outline"
            label="E-Mail"
            value={email}
            comingSoon
            onPress={showComingSoon}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="lock-closed-outline"
            label="Passwort ändern"
            onPress={() => router.push("/change-password")}
            isLast
            styles={styles}
            theme={theme}
          />
        </SettingsSection>

        {/* ── App ── */}
        <SettingsSection title="App" styles={styles} theme={theme}>
          <SettingsRow
            icon="language-outline"
            label="Sprache"
            value="Deutsch"
            comingSoon
            onPress={showComingSoon}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="notifications-outline"
            label="Benachrichtigungen"
            comingSoon
            onPress={showComingSoon}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="contrast-outline"
            label="Erscheinungsbild"
            value="Systemeinstellung"
            onPress={() =>
              Alert.alert(
                "Erscheinungsbild",
                "Die App folgt automatisch der Hell-/Dunkel-Einstellung deines Geräts.",
              )
            }
            isLast
            styles={styles}
            theme={theme}
          />
        </SettingsSection>

        {/* ── Administration (nur Admin) ── */}
        {isAdmin && (
          <SettingsSection
            title="Administration"
            styles={styles}
            theme={theme}
          >
            <SettingsRow
              icon="business-outline"
              label="Firmenprofil"
              comingSoon
              onPress={showComingSoon}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="people-outline"
              label="Team verwalten"
              onPress={() => router.push("/(admin-tabs)/employees")}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="document-text-outline"
              label="Stundenzettel"
              onPress={() => router.push("/timesheets")}
              styles={styles}
              theme={theme}
            />
            <SettingsRow
              icon="options-outline"
              label="App-Einstellungen"
              comingSoon
              onPress={showComingSoon}
              isLast
              styles={styles}
              theme={theme}
            />
          </SettingsSection>
        )}

        {/* ── Support ── */}
        <SettingsSection title="Support" styles={styles} theme={theme}>
          <SettingsRow
            icon="help-circle-outline"
            label="Hilfe & Support"
            comingSoon
            onPress={showComingSoon}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="shield-checkmark-outline"
            label="Datenschutz"
            comingSoon
            onPress={showComingSoon}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="trash-outline"
            label="Account- und Datenlöschung beantragen"
            onPress={handleRequestDeletion}
            styles={styles}
            theme={theme}
          />
          <SettingsRow
            icon="information-circle-outline"
            label="App-Version"
            value={`Version ${APP_VERSION}`}
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
          <Text style={styles.logoutButtonText}>Abmelden</Text>
        </TouchableOpacity>
      </ScrollView>
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
function SettingsRow({
  icon,
  label,
  value,
  comingSoon = false,
  onPress,
  isLast = false,
  styles,
  theme,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value?: string;
  comingSoon?: boolean;
  onPress?: () => void;
  isLast?: boolean;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.7 } : {};

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
        {comingSoon && (
          <View style={styles.soonBadge}>
            <Text style={styles.soonText}>Bald</Text>
          </View>
        )}
        {value && !comingSoon ? (
          <Text style={styles.rowValue} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {onPress && (
          <Ionicons
            name="chevron-forward"
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
      marginLeft: theme.spacing.xs,
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
    soonBadge: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
    },
    soonText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
      letterSpacing: theme.typography.letterSpacing.wide,
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
