// features/company/CompanySettingsScreen.tsx
// Firmen-Einstellungen (nur Admin): Name, Kontakt-E-Mail, Kontakt-Telefon.
//
// Schreibpfad: services/company/company.service.ts → RPC update_own_company
// (companies hat bewusst keine UPDATE-RLS-Policy). timezone/locale werden hier
// bewusst NICHT angezeigt — sichere Defaults, noch kein UI (Phase 15).

import {
  AppHeader,
  Button,
  Card,
  ErrorBanner,
  Input,
  LoadingScreen,
} from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useOwnCompany } from "@/features/company/hooks/useOwnCompany";
import { useAppTheme } from "@/hooks/useAppTheme";
import { updateOwnCompany } from "@/services/company/company.service";
import { isValidEmail } from "@/utils/email";
import { isValidPhone } from "@/utils/phone";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function CompanySettingsScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { company, loading, error: loadError, setCompany } = useOwnCompany();

  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [nameError, setNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (company) {
      setName(company.name ?? "");
      setContactEmail(company.contactEmail ?? "");
      setContactPhone(company.contactPhone ?? "");
    }
  }, [company]);

  const handleSave = async () => {
    setNameError("");
    setEmailError("");
    setPhoneError("");
    setFormError("");
    setSaved(false);

    let ok = true;
    if (!name.trim()) {
      setNameError("Firmenname ist erforderlich.");
      ok = false;
    }
    if (contactEmail.trim() && !isValidEmail(contactEmail)) {
      setEmailError("Bitte gib eine gültige E-Mail-Adresse ein.");
      ok = false;
    }
    if (contactPhone.trim() && !isValidPhone(contactPhone)) {
      setPhoneError("Bitte gib eine gültige Telefonnummer ein (z. B. 0170 1234567).");
      ok = false;
    }
    if (!ok) return;

    try {
      setSaving(true);
      const updated = await updateOwnCompany({
        name: name.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim(),
      });
      setCompany(updated);
      setContactPhone(updated.contactPhone ?? "");
      setContactEmail(updated.contactEmail ?? "");
      setSaved(true);
    } catch (err) {
      setFormError(toUserMessage(err, "Firmendaten konnten nicht gespeichert werden."));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader title="Firmendaten" showBack />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {loadError ? <ErrorBanner message={loadError} /> : null}

          <Text style={styles.intro}>
            Diese Angaben erscheinen künftig auf Belegen und in der
            Kundenkommunikation. Die E-Mail-Adresse ist von deiner
            Anmelde-Adresse unabhängig.
          </Text>

          <Card style={styles.card}>
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            <Input
              label="Firmenname"
              placeholder="Muster Reinigung GmbH"
              value={name}
              onChangeText={(t) => {
                setName(t);
                setNameError("");
                setSaved(false);
              }}
              error={nameError}
              autoCapitalize="words"
              editable={!saving}
            />

            <Input
              label="Firmen-E-Mail"
              placeholder="kontakt@firma.de"
              value={contactEmail}
              onChangeText={(t) => {
                setContactEmail(t);
                setEmailError("");
                setSaved(false);
              }}
              error={emailError}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              editable={!saving}
            />

            <Input
              label="Firmen-Telefon"
              placeholder="0170 1234567"
              value={contactPhone}
              onChangeText={(t) => {
                setContactPhone(t);
                setPhoneError("");
                setSaved(false);
              }}
              error={phoneError}
              keyboardType="phone-pad"
              autoComplete="tel"
              editable={!saving}
            />

            {saved ? (
              <View style={styles.savedRow}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={theme.colors.statusCompleted}
                />
                <Text style={styles.savedText}>Gespeichert.</Text>
              </View>
            ) : null}

            <Button
              label="Speichern"
              loading={saving}
              onPress={handleSave}
              style={{ marginTop: theme.spacing.sm }}
            />
            <Button
              label="Abbrechen"
              variant="ghost"
              onPress={() => router.back()}
            />
          </Card>
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
      paddingHorizontal: theme.spacing.gutter,
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.lg,
    },
    intro: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.sm,
    },
    card: {
      gap: theme.spacing.md,
    },
    savedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    savedText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      color: theme.colors.statusCompleted,
    },
  });
}
