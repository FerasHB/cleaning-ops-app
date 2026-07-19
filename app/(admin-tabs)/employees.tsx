// app/(admin-tabs)/employees.tsx
// Mitarbeiter-Tab im Admin-Bereich.
// Vollständig theme-aware (Light + Dark Mode).
// Business-Logik (createEmployee, JobContext) unverändert.

import { EmptyState, LoadingScreen } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useJobs } from "@/context/JobContext";
import { createEmployee } from "@/services/employees/createEmployee";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";
import { getEmployeeStatus } from "@/utils/employeeStatus";

function roleLabel(role?: string | null): string {
  if (role === "admin") return "Admin";
  return "Mitarbeiter";
}

export default function EmployeesScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { employees, loading, error, refreshEmployees } = useJobs();

  // Liste zeigt alle Mitarbeiter (inkl. inaktiver, mit Badge); der Zähler
  // bezieht sich bewusst nur auf aktive.
  const activeCount = useMemo(
    () => employees.filter((e) => e.isActive !== false).length,
    [employees],
  );

  const [modalVisible, setModalVisible] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    refreshEmployees();
  }, [refreshEmployees]);

  const handleOpenModal = () => {
    setModalVisible(true);
  };

  const handleCloseModal = () => {
    setModalVisible(false);
    setFullName("");
    setEmail("");
  };

  // ── Mitarbeiter einladen: legt das Konto unbestätigt an und verschickt eine
  // Einladungs-Mail (create-employee Edge Function → admin.inviteUserByEmail).
  // Kein Passwort wird hier vergeben — der Mitarbeiter setzt es selbst über
  // den Einladungs-Link (siehe features/auth/AcceptInviteScreen.tsx).
  const handleCreateEmployee = async () => {
    const trimmedName = fullName.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (creating) {
      return;
    }

    if (!trimmedName) {
      Alert.alert("Fehler", "Bitte gib einen Namen ein.");
      return;
    }

    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      Alert.alert("Fehler", "Bitte gib eine gültige E-Mail-Adresse ein.");
      return;
    }

    try {
      setCreating(true);

      await createEmployee({
        fullName: trimmedName,
        email: trimmedEmail,
      });

      await refreshEmployees();

      Alert.alert(
        "Einladung verschickt",
        `${trimmedName} erhält in Kürze eine E-Mail, um das eigene Passwort festzulegen.`,
      );

      handleCloseModal();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Einladung konnte nicht verschickt werden.";

      Alert.alert("Fehler", message);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      <FlatList
        data={employees}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={refreshEmployees}
            tintColor={theme.colors.primary}
          />
        }
        contentContainerStyle={[
          styles.content,
          employees.length === 0 && styles.emptyContent,
        ]}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <View style={styles.headerText}>
                <Text style={styles.title}>Mitarbeiter</Text>
                <Text style={styles.subtitle}>
                  Übersicht aller Mitarbeiter deiner Firma
                </Text>
              </View>

              <TouchableOpacity
                style={styles.addButton}
                activeOpacity={0.8}
                onPress={handleOpenModal}
              >
                <Ionicons
                  name="add"
                  size={26}
                  color={theme.colors.onPrimaryContainer}
                />
              </TouchableOpacity>
            </View>

            <View style={styles.countCard}>
              <Text style={styles.countNumber}>{activeCount}</Text>
              <Text style={styles.countLabel}>aktive Mitarbeiter</Text>
            </View>

            {error && <Text style={styles.errorText}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="Keine Mitarbeiter vorhanden"
            message="Sobald du Mitarbeiter hinzufügst, erscheinen sie hier."
            icon="people-outline"
            ctaLabel="Mitarbeiter hinzufügen"
            onCta={handleOpenModal}
          />
        }
        renderItem={({ item }) => {
          const status = getEmployeeStatus(item);
          return (
            <TouchableOpacity
              style={styles.employeeCard}
              activeOpacity={0.7}
              onPress={() => router.push(`/employees/${item.id}`)}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {item.fullName.charAt(0).toUpperCase()}
                </Text>
              </View>

              <View style={styles.employeeInfo}>
                <Text style={styles.employeeName} numberOfLines={1}>
                  {item.fullName}
                </Text>
                <Text style={styles.employeeEmail} numberOfLines={1}>
                  {item.email?.trim() ? item.email : "Nicht hinterlegt"}
                </Text>
                <Text style={styles.employeeRole}>{roleLabel(item.role)}</Text>
              </View>

              <View
                style={[
                  styles.statusBadge,
                  status.variant === "inactive" && styles.statusBadgeInactive,
                  status.variant === "pending" && styles.statusBadgePending,
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    status.variant === "inactive" && styles.statusTextInactive,
                    status.variant === "pending" && styles.statusTextPending,
                  ]}
                >
                  {status.label}
                </Text>
              </View>

              <Ionicons
                name="chevron-forward"
                size={18}
                color={theme.colors.outline}
                style={styles.chevron}
              />
            </TouchableOpacity>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

      {/* ── Mitarbeiter-hinzufügen-Modal ── */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={handleCloseModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={styles.modalCard}>
            {/* Drag-Handle (visuelles Detail) */}
            <View style={styles.modalHandle} />

            <Text style={styles.modalTitle}>Mitarbeiter einladen</Text>
            <Text style={styles.modalSubtitle}>
              Der Mitarbeiter erhält eine E-Mail und legt sein Passwort selbst fest.
            </Text>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Name</Text>
              <TextInput
                value={fullName}
                onChangeText={setFullName}
                placeholder="z.B. Max Müller"
                placeholderTextColor={theme.colors.outline}
                style={styles.input}
                editable={!creating}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>E-Mail</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="max@example.com"
                placeholderTextColor={theme.colors.outline}
                keyboardType="email-address"
                autoCapitalize="none"
                style={styles.input}
                editable={!creating}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                activeOpacity={0.8}
                onPress={handleCloseModal}
                disabled={creating}
              >
                <Text style={styles.cancelButtonText}>Abbrechen</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.createButton,
                  creating && styles.createButtonDisabled,
                ]}
                activeOpacity={0.8}
                onPress={handleCreateEmployee}
                disabled={creating}
              >
                <Text style={styles.createButtonText}>
                  {creating ? "Wird eingeladen…" : "Einladen"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      padding: theme.spacing.lg,
      paddingBottom: 48,
    },
    emptyContent: {
      flexGrow: 1,
    },

    // ── Header
    header: {
      marginBottom: theme.spacing.lg,
    },
    headerTop: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: theme.spacing.md,
    },
    headerText: {
      flex: 1,
    },
    title: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
    },
    subtitle: {
      marginTop: theme.spacing.xs,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.md,
    },

    // ── Hinzufügen-Button (Plus)
    addButton: {
      width: 46,
      height: 46,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
      alignItems: "center",
      justifyContent: "center",
    },

    // ── Counter-Card
    countCard: {
      marginTop: theme.spacing.lg,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.xl,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.lg,
      ...theme.shadows.sm,
    },
    countNumber: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.extrabold,
      color: theme.colors.primary,
    },
    countLabel: {
      marginTop: 2,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Error-Text
    errorText: {
      marginTop: theme.spacing.md,
      color: theme.colors.error,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
    },

    // ── Mitarbeiter-Karten in der Liste
    employeeCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.xl,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      ...theme.shadows.sm,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.statusInProgressBg,
      alignItems: "center",
      justifyContent: "center",
      marginRight: theme.spacing.md,
    },
    avatarText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.statusInProgress,
    },
    employeeInfo: {
      flex: 1,
    },
    employeeName: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    employeeEmail: {
      marginTop: 2,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    employeeRole: {
      marginTop: 2,
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.outline,
    },
    statusBadge: {
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.full,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
    },
    statusBadgeInactive: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderColor: theme.colors.outlineVariant,
    },
    // "Eingeladen" — dieselbe Amber-Semantik wie der "Offen"-Jobstatus
    // (noch nicht abgeschlossen), statt eine neue Farbe einzuführen.
    statusBadgePending: {
      backgroundColor: theme.colors.statusOpenBg,
      borderColor: theme.colors.statusOpenBorder,
    },
    statusText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.statusCompleted,
    },
    statusTextInactive: {
      color: theme.colors.onSurfaceVariant,
    },
    statusTextPending: {
      color: theme.colors.statusOpen,
    },
    chevron: {
      marginLeft: theme.spacing.sm,
    },
    separator: {
      height: theme.spacing.sm,
    },

    // ── Modal (Bottom Sheet)
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0, 0, 0, 0.55)",
      justifyContent: "flex-end",
    },
    modalCard: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: theme.radius.xl,
      borderTopRightRadius: theme.radius.xl,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
      borderTopWidth: 1,
      borderTopColor: theme.colors.outlineVariant,
    },
    modalHandle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.outlineVariant,
      marginBottom: theme.spacing.md,
    },
    modalTitle: {
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    modalSubtitle: {
      marginTop: theme.spacing.xs,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // ── Formular-Felder im Modal
    formGroup: {
      marginTop: theme.spacing.lg,
    },
    label: {
      marginBottom: theme.spacing.xs,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    input: {
      backgroundColor: theme.colors.background,
      borderWidth: 1.5,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 13,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      minHeight: theme.spacing.tapTarget,
    },

    // ── Modal-Aktionen
    modalActions: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xl,
    },
    cancelButton: {
      flex: 1,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
    },
    cancelButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    createButton: {
      flex: 1,
      backgroundColor: theme.colors.primaryContainer,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.spacing.tapTarget,
    },
    createButtonDisabled: {
      opacity: 0.5,
    },
    createButtonText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimaryContainer,
    },
  });
}
