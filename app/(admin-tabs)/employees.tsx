import { EmptyState, LoadingScreen } from "@/components/ui";
import { Colors, Radius, Spacing, Typography } from "@/constants/theme";
import { useJobs } from "@/context/JobContext";
import { createEmployee } from "@/services/employees/createEmployee";
import React, { useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { SafeAreaView } from "react-native-safe-area-context";

export default function EmployeesScreen() {
  const { employees, loading, error, refreshEmployees } = useJobs();

  const [modalVisible, setModalVisible] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    setPassword("");
  };

  const handleCreateEmployee = async () => {
    const trimmedName = fullName.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPassword = password.trim();

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

    if (trimmedPassword.length < 6) {
      Alert.alert("Fehler", "Das Passwort muss mindestens 6 Zeichen haben.");
      return;
    }

    try {
      setCreating(true);

      await createEmployee({
        fullName: trimmedName,
        email: trimmedEmail,
        password: trimmedPassword,
      });

      await refreshEmployees();

      Alert.alert("Erfolg", "Mitarbeiter wurde erfolgreich erstellt.");

      handleCloseModal();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mitarbeiter konnte nicht erstellt werden.";

      Alert.alert("Fehler", message);
    } finally {
      setCreating(false);
    }
  };
  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={employees}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={refreshEmployees} />
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
                  Übersicht aller aktiven Mitarbeiter deiner Firma
                </Text>
              </View>

              <TouchableOpacity
                style={styles.addButton}
                activeOpacity={0.8}
                onPress={handleOpenModal}
              >
                <Text style={styles.addButtonText}>+</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.countCard}>
              <Text style={styles.countNumber}>{employees.length}</Text>
              <Text style={styles.countLabel}>aktive Mitarbeiter</Text>
            </View>

            {error && <Text style={styles.errorText}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="Keine Mitarbeiter vorhanden"
            message="Sobald du Mitarbeiter hinzufügst, erscheinen sie hier."
          />
        }
        renderItem={({ item }) => (
          <View style={styles.employeeCard}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {item.fullName.charAt(0).toUpperCase()}
              </Text>
            </View>

            <View style={styles.employeeInfo}>
              <Text style={styles.employeeName}>{item.fullName}</Text>
              <Text style={styles.employeeRole}>Mitarbeiter</Text>
            </View>

            <View style={styles.statusBadge}>
              <Text style={styles.statusText}>Aktiv</Text>
            </View>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

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
            <Text style={styles.modalTitle}>Mitarbeiter hinzufügen</Text>
            <Text style={styles.modalSubtitle}>
              Lege einen neuen Mitarbeiter für deine Firma an.
            </Text>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Name</Text>
              <TextInput
                value={fullName}
                onChangeText={setFullName}
                placeholder="z.B. Max Müller"
                placeholderTextColor={Colors.text.muted}
                style={styles.input}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>E-Mail</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="max@example.com"
                placeholderTextColor={Colors.text.muted}
                keyboardType="email-address"
                autoCapitalize="none"
                style={styles.input}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Temporäres Passwort</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Mindestens 6 Zeichen"
                placeholderTextColor={Colors.text.muted}
                secureTextEntry
                style={styles.input}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                activeOpacity={0.8}
                onPress={handleCloseModal}
              >
                <Text style={styles.cancelButtonText}>Abbrechen</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.createButton}
                activeOpacity={0.8}
                onPress={handleCreateEmployee}
              >
                <Text style={styles.createButtonText}>Erstellen</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg.app,
  },
  content: {
    padding: Spacing.lg,
    paddingBottom: 48,
  },
  emptyContent: {
    flexGrow: 1,
  },
  header: {
    marginBottom: Spacing.lg,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: Spacing.md,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
    letterSpacing: Typography.tracking.tight,
  },
  subtitle: {
    marginTop: Spacing.xs,
    fontSize: Typography.size.md,
    color: Colors.text.secondary,
    lineHeight: Typography.size.md * Typography.leading.normal,
  },
  addButton: {
    width: 46,
    height: 46,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.default,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: {
    fontSize: 30,
    fontWeight: Typography.weight.medium,
    color: Colors.white,
    marginTop: -2,
  },
  countCard: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border.default,
    padding: Spacing.lg,
  },
  countNumber: {
    fontSize: Typography.size.xxl,
    fontWeight: Typography.weight.extrabold,
    color: Colors.accent.default,
  },
  countLabel: {
    marginTop: 2,
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.medium,
    color: Colors.text.muted,
  },
  errorText: {
    marginTop: Spacing.md,
    color: Colors.status.danger,
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.medium,
  },
  employeeCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.bg.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border.default,
    padding: Spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent.subtle,
    alignItems: "center",
    justifyContent: "center",
    marginRight: Spacing.md,
  },
  avatarText: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.bold,
    color: Colors.accent.text,
  },
  employeeInfo: {
    flex: 1,
  },
  employeeName: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
  employeeRole: {
    marginTop: 2,
    fontSize: Typography.size.sm,
    color: Colors.text.muted,
  },
  statusBadge: {
    backgroundColor: Colors.status.successBg,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  statusText: {
    fontSize: Typography.size.xs,
    fontWeight: Typography.weight.semibold,
    color: Colors.status.success,
  },
  separator: {
    height: Spacing.sm,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.35)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: Colors.bg.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },
  modalTitle: {
    fontSize: Typography.size.xl,
    fontWeight: Typography.weight.bold,
    color: Colors.text.primary,
  },
  modalSubtitle: {
    marginTop: Spacing.xs,
    fontSize: Typography.size.sm,
    color: Colors.text.secondary,
  },
  formGroup: {
    marginTop: Spacing.lg,
  },
  label: {
    marginBottom: Spacing.xs,
    fontSize: Typography.size.sm,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.primary,
  },
  input: {
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.default,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: Typography.size.md,
    color: Colors.text.primary,
  },
  modalActions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.xl,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: Colors.bg.elevated,
    borderWidth: 1,
    borderColor: Colors.border.default,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  cancelButtonText: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.semibold,
    color: Colors.text.secondary,
  },
  createButton: {
    flex: 1,
    backgroundColor: Colors.accent.default,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  createButtonText: {
    fontSize: Typography.size.md,
    fontWeight: Typography.weight.semibold,
    color: Colors.white,
  },
});
