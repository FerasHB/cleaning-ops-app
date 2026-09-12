// features/profile/ProfileEditScreen.tsx
// Eigenes Profil bearbeiten — Admin UND Mitarbeiter: Name + Telefon.
//
// Schreibpfad: services/profile/updateOwnProfile.ts → direktes .update() über
// die RLS-Policy "update own profile". full_name/phone sind nicht durch
// enforce_profile_field_guard geschützt. Danach refreshProfile(), damit der
// AuthContext den neuen Stand hat.

import {
  AppHeader,
  Button,
  Card,
  ErrorBanner,
  Input,
} from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { updateOwnProfile } from "@/services/profile/updateOwnProfile";
import { isValidPhone } from "@/utils/phone";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
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

export default function ProfileEditScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { profile, user, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [nameError, setNameError] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const email = user?.email ?? "—";

  const handleSave = async () => {
    setNameError("");
    setPhoneError("");
    setFormError("");

    let ok = true;
    if (!fullName.trim()) {
      setNameError("Name ist erforderlich.");
      ok = false;
    }
    if (phone.trim() && !isValidPhone(phone)) {
      setPhoneError("Bitte gib eine gültige Telefonnummer ein (z. B. 0170 1234567).");
      ok = false;
    }
    if (!ok) return;

    try {
      setSaving(true);
      await updateOwnProfile({ fullName: fullName.trim(), phone: phone.trim() });
      await refreshProfile();
      router.back();
    } catch (err) {
      setFormError(toUserMessage(err, "Profil konnte nicht gespeichert werden."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <AppHeader title="Profil bearbeiten" showBack />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Card style={styles.card}>
            {formError ? (
              <ErrorBanner message={formError} onDismiss={() => setFormError("")} />
            ) : null}

            <Input
              label="Vollständiger Name"
              placeholder="Max Mustermann"
              value={fullName}
              onChangeText={(t) => {
                setFullName(t);
                setNameError("");
              }}
              error={nameError}
              autoCapitalize="words"
              editable={!saving}
            />

            <Input
              label="Telefon (optional)"
              placeholder="0170 1234567"
              value={phone}
              onChangeText={(t) => {
                setPhone(t);
                setPhoneError("");
              }}
              error={phoneError}
              keyboardType="phone-pad"
              autoComplete="tel"
              editable={!saving}
            />

            <View style={styles.infoRow}>
              <Ionicons
                name="mail-outline"
                size={14}
                color={theme.colors.outline}
              />
              <Text style={styles.infoText}>
                E-Mail: {email} — über die Anmeldung, hier nicht änderbar.
              </Text>
            </View>

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
    },
    card: { gap: theme.spacing.md },
    infoRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
    },
    infoText: {
      flex: 1,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
      lineHeight: theme.typography.lineHeight.xs,
    },
  });
}
