// features/jobs/components/ForceCompleteSheet.tsx
// Admin-Zwangsabschluss eines HÄNGENDEN Auftrags (Phase 16).
//
// WANN ES DAS BRAUCHT: seit Phase 16 schließt ein Auftrag erst, wenn jede
// aktuelle Zuweisung aufgelöst ist. Eine bereits GESTARTETE Zuweisung lässt
// sich serverseitig nicht entfernen — hat also jemand gestartet und den
// Abschluss vergessen (Akku leer, Schicht vorbei, Konto gelöscht), gibt es
// keinen anderen Weg, den Auftrag zu schließen. Genau dafür ist dieser Dialog.
//
// WAS ER AUSDRÜCKLICH NICHT TUT: er erfindet KEINE Arbeitszeit. Die RPC
// (admin_force_complete_job) fasst job_assignments nicht an. Wessen eigenes
// Zeitpaar unvollständig ist, bleibt im Stundenzettel eine Lücke und muss dort
// über die Zeitkorrektur mit der ECHTEN Zeit nachgetragen werden. Der Text
// sagt das offen, damit niemand den Abschluss für eine Zeiterfassung hält.
//
// Begründung ist PFLICHT (serverseitig erzwungen) und landet im Prüfpfad
// job_completion_overrides.

import { Button, Card, ErrorBanner, Input } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type Props = {
  visible: boolean;
  customerName?: string | null;
  onClose: () => void;
  /** Führt den Abschluss aus; wirft bei serverseitiger Ablehnung. */
  onConfirm: (reason: string) => Promise<void>;
};

export function ForceCompleteSheet({
  visible,
  customerName,
  onClose,
  onConfirm,
}: Props) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setReason("");
    setError("");
    onClose();
  };

  const handleConfirm = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(t("jobs:forceComplete.reasonRequiredError"));
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      await onConfirm(trimmed);
      setReason("");
      onClose();
    } catch (err) {
      setError(
        toUserMessage(err, t("jobs:forceComplete.fallbackError")),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={close}
    >
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.centerWrap}
        >
          <Card padding={theme.spacing.lg} style={styles.card}>
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <Ionicons
                  name="shield-checkmark-outline"
                  size={18}
                  color={theme.colors.primary}
                />
                <Text style={styles.title}>{t("jobs:forceComplete.title")}</Text>
              </View>
              <TouchableOpacity onPress={close} accessibilityLabel={t("jobs:forceComplete.closeA11y")}>
                <Ionicons
                  name="close"
                  size={22}
                  color={theme.colors.onSurfaceVariant}
                />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled">
              {customerName ? (
                <Text style={styles.subtitle}>{customerName}</Text>
              ) : null}

              <Text style={styles.body}>
                {t("jobs:forceComplete.bodyText")}
              </Text>

              {error ? (
                <View style={styles.bannerWrap}>
                  <ErrorBanner message={error} />
                </View>
              ) : null}

              <Input
                label={t("jobs:forceComplete.reasonLabel")}
                value={reason}
                onChangeText={setReason}
                placeholder={t("jobs:forceComplete.reasonPlaceholder")}
                multiline
                numberOfLines={3}
              />

              <View style={styles.actions}>
                <Button
                  label={t("jobs:forceComplete.confirmButton")}
                  icon="checkmark"
                  loading={submitting}
                  disabled={submitting}
                  onPress={handleConfirm}
                />
                <Button
                  label={t("jobs:forceComplete.cancelButton")}
                  variant="secondary"
                  disabled={submitting}
                  onPress={close}
                />
              </View>
            </ScrollView>
          </Card>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    // Gleiche Abdunkelung wie TimeCorrectionSheet (dort ebenfalls literal —
    // das Theme trägt keinen Scrim-Token).
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "center",
    },
    centerWrap: {
      paddingHorizontal: theme.spacing.gutter,
    },
    card: {
      gap: theme.spacing.md,
      maxHeight: "85%",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      flexShrink: 1,
    },
    title: {
      flexShrink: 1,
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
    },
    subtitle: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
      marginBottom: theme.spacing.sm,
    },
    body: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      marginBottom: theme.spacing.md,
    },
    bannerWrap: {
      marginBottom: theme.spacing.sm,
    },
    actions: {
      gap: theme.spacing.sm,
      marginTop: theme.spacing.md,
    },
  });
}
