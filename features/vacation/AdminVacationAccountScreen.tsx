// features/vacation/AdminVacationAccountScreen.tsx
// Urlaubskonto eines Mitarbeiters: Saldo, Verlauf, Initialisierung, Korrektur.
//
// Der Saldo wird NIE gespeichert, sondern immer aus den Buchungszeilen
// summiert — die Aufstellung oben und der Verlauf unten sind damit
// zwangsläufig konsistent ("warum 28,5?" ist zeilenweise beantwortbar).
//
// Drei klar getrennte Zustände statt einer erfundenen 0:
//   Urlaubskonto aus        -> gar keine Zahlen
//   Jahr nicht angelegt     -> Einrichtungshinweis + Aktion
//   Jahr angelegt           -> Saldo + Verlauf

import { AppHeader, ErrorBanner } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  getEmploymentConfig,
  getCompanyVacationDefaults,
} from "@/services/employees/employmentConfig.service";
import {
  addVacationAdjustment,
  getVacationLedger,
  getVacationYearId,
  initializeVacationYear,
} from "@/services/vacation/vacationLedger.service";
import type { AppTheme } from "@/constants/theme";
import type { VacationBalance, VacationLedgerEntryType } from "@/types/vacationLedger";
import {
  buildVacationBalance,
  formatDaysLocalized,
  formatLedgerAmountLocalized,
} from "@/utils/vacationBalance";
import { resolveEffectiveVacationConfig } from "@/utils/vacationConfig";
import { alertDialog } from "@/utils/dialogs";
import { toUserMessage } from "@/utils/userMessages";
import { formatDateTimeLocalized } from "@/utils/date";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

const LEDGER_ENTRY_LABEL_KEYS: Record<VacationLedgerEntryType, string> = {
  annual_entitlement: "admin:vacationAccount.entryAnnualEntitlement",
  approved_vacation: "admin:vacationAccount.entryApprovedVacation",
  vacation_cancellation: "admin:vacationAccount.entryVacationCancellation",
  manual_adjustment: "admin:vacationAccount.entryManualAdjustment",
  carry_over: "admin:vacationAccount.entryCarryOver",
  au_restoration: "admin:vacationAccount.entryAuRestoration",
};

type State =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "not_initialized"; canInitialize: boolean; reason?: string }
  | { kind: "ready"; balance: VacationBalance };

export default function AdminVacationAccountScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const year = new Date().getFullYear();

  const [state, setState] = useState<State>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setState({ kind: "loading" });
    setError(null);
    try {
      const [config, defaults] = await Promise.all([
        getEmploymentConfig(id),
        getCompanyVacationDefaults(),
      ]);
      const effective = resolveEffectiveVacationConfig(config, defaults);

      if (effective.status === "disabled") {
        setState({ kind: "disabled" });
        return;
      }

      const yearId = await getVacationYearId(id, year);
      if (!yearId) {
        // Ohne vollständige Konfiguration kann der Jahresanspruch nicht
        // gebucht werden — das wird benannt, nicht mit 0 überdeckt.
        setState({
          kind: "not_initialized",
          canInitialize: effective.status === "configured",
          reason:
            effective.status === "incomplete"
              ? t("admin:vacationAccount.notInitReasonIncomplete")
              : undefined,
        });
        return;
      }

      const entries = await getVacationLedger(yearId);
      setState({ kind: "ready", balance: buildVacationBalance(year, entries) });
    } catch (err) {
      setError(toUserMessage(err));
      setState({ kind: "disabled" });
    }
  }, [id, year]);

  useEffect(() => {
    load();
  }, [load]);

  const handleInitialize = async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await initializeVacationYear(id, year);
      await load();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAdjust = async () => {
    if (!id) return;
    const parsed = Number(adjustAmount.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError(t("admin:vacationAccount.adjustValueError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addVacationAdjustment(id, year, parsed, adjustNote);
      setAdjustOpen(false);
      setAdjustAmount("");
      setAdjustNote("");
      await load();
      alertDialog(
        t("admin:vacationAccount.adjustBookedTitle"),
        t("admin:vacationAccount.adjustBookedMessage"),
      );
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <AppHeader
        title={t("admin:vacationAccount.headerTitle", { year })}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <ErrorBanner message={error} /> : null}

        {state.kind === "loading" ? (
          <ActivityIndicator color={theme.colors.primary} style={styles.loader} />
        ) : null}

        {state.kind === "disabled" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {t("admin:vacationAccount.disabledTitle")}
            </Text>
            <Text style={styles.hint}>
              {t("admin:vacationAccount.disabledHint")}
            </Text>
          </View>
        ) : null}

        {state.kind === "not_initialized" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {t("admin:vacationAccount.notInitTitle")}
            </Text>
            <Text style={styles.hint}>
              {state.reason ??
                t("admin:vacationAccount.notInitReasonDefault", { year })}
            </Text>
            {state.canInitialize ? (
              <TouchableOpacity
                style={[styles.primaryBtn, busy && styles.btnDisabled]}
                onPress={handleInitialize}
                disabled={busy}
              >
                <Text style={styles.primaryBtnText}>
                  {busy
                    ? "..."
                    : t("admin:vacationAccount.initializeButton", { year })}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {state.kind === "ready" ? (
          <>
            <View style={styles.card}>
              <Row
                label={t("admin:vacationAccount.rowEntitlement")}
                value={formatDaysLocalized(state.balance.annualEntitlement)}
              />
              {state.balance.carryOver !== 0 ? (
                <Row
                  label={t("admin:vacationAccount.rowCarryOver")}
                  value={formatDaysLocalized(state.balance.carryOver)}
                />
              ) : null}
              <Row
                label={t("admin:vacationAccount.rowUsed")}
                value={formatDaysLocalized(state.balance.usedDays)}
              />
              <Row
                label={t("admin:vacationAccount.rowAdjustments")}
                value={formatLedgerAmountLocalized(state.balance.adjustments)}
              />
              <View style={styles.divider} />
              <Row
                label={t("admin:vacationAccount.rowRemaining")}
                value={formatDaysLocalized(state.balance.remaining)}
                strong
              />
            </View>

            <Text style={styles.sectionTitle}>
              {t("admin:vacationAccount.historyTitle")}
            </Text>
            <View style={styles.card}>
              {state.balance.entries.map((entry) => (
                <View key={entry.id} style={styles.entryRow}>
                  <Text
                    style={[
                      styles.entryAmount,
                      entry.amountDays < 0 ? styles.negative : styles.positive,
                    ]}
                  >
                    {formatLedgerAmountLocalized(entry.amountDays)}
                  </Text>
                  <View style={styles.entryBody}>
                    <Text style={styles.entryLabel}>
                      {t(LEDGER_ENTRY_LABEL_KEYS[entry.entryType])}
                    </Text>
                    {entry.note ? <Text style={styles.entryNote}>{entry.note}</Text> : null}
                    <Text style={styles.entryDate}>{formatDateTimeLocalized(entry.createdAt)}</Text>
                  </View>
                </View>
              ))}
            </View>

            <TouchableOpacity
              style={[styles.secondaryBtn, busy && styles.btnDisabled]}
              onPress={() => setAdjustOpen(true)}
              disabled={busy}
            >
              <Text style={styles.secondaryBtnText}>
                {t("admin:vacationAccount.adjustButton")}
              </Text>
            </TouchableOpacity>
            <Text style={styles.hint}>
              {t("admin:vacationAccount.ledgerFooterHint")}
            </Text>
          </>
        ) : null}
      </ScrollView>

      <Modal visible={adjustOpen} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.cardTitle}>
              {t("admin:vacationAccount.adjustSheetTitle")}
            </Text>
            <Text style={styles.hint}>
              {t("admin:vacationAccount.adjustSheetHint")}
            </Text>
            <TextInput
              style={styles.input}
              keyboardType="numbers-and-punctuation"
              placeholder={t("admin:vacationAccount.amountPlaceholder")}
              placeholderTextColor={theme.colors.onSurfaceVariant}
              value={adjustAmount}
              onChangeText={setAdjustAmount}
            />
            <TextInput
              style={styles.input}
              placeholder={t("admin:vacationAccount.reasonPlaceholder")}
              placeholderTextColor={theme.colors.onSurfaceVariant}
              value={adjustNote}
              onChangeText={setAdjustNote}
            />
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setAdjustOpen(false)}>
                <Text style={styles.secondaryBtnText}>{t("common:actions.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, styles.flex, busy && styles.btnDisabled]}
                onPress={handleAdjust}
                disabled={busy}
              >
                <Text style={styles.primaryBtnText}>
                  {t("admin:vacationAccount.bookButton")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );

  function Row({
    label,
    value,
    strong,
  }: {
    label: string;
    value: string;
    strong?: boolean;
  }) {
    return (
      <View style={styles.row}>
        <Text style={[styles.rowLabel, strong && styles.rowStrong]}>{label}</Text>
        <Text style={[styles.rowValue, strong && styles.rowStrong]}>{value}</Text>
      </View>
    );
  }
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
    loader: { marginTop: theme.spacing.xl },
    flex: { flex: 1 },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    cardTitle: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    sectionTitle: {
      fontSize: theme.typography.size.lg,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      marginTop: theme.spacing.lg,
    },
    hint: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.xs,
    },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    rowLabel: { fontSize: theme.typography.size.sm, color: theme.colors.onSurfaceVariant },
    rowValue: { fontSize: theme.typography.size.sm, color: theme.colors.onSurface },
    rowStrong: {
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      fontSize: theme.typography.size.md,
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
      marginVertical: theme.spacing.xs,
    },
    entryRow: {
      flexDirection: "row",
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
    },
    entryAmount: {
      minWidth: 56,
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.semibold,
    },
    positive: { color: theme.colors.statusCompleted },
    negative: { color: theme.colors.error },
    entryBody: { flex: 1 },
    entryLabel: { fontSize: theme.typography.size.sm, color: theme.colors.onSurface },
    entryNote: { fontSize: theme.typography.size.xs, color: theme.colors.onSurfaceVariant },
    entryDate: { fontSize: theme.typography.size.xs, color: theme.colors.onSurfaceVariant },
    primaryBtn: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      marginTop: theme.spacing.sm,
    },
    primaryBtnText: {
      color: theme.colors.onPrimary,
      fontWeight: theme.typography.weight.semibold,
      fontSize: theme.typography.size.sm,
    },
    secondaryBtn: {
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      marginTop: theme.spacing.md,
    },
    secondaryBtnText: { color: theme.colors.onSurface, fontSize: theme.typography.size.sm },
    btnDisabled: { opacity: 0.6 },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      color: theme.colors.onSurface,
      fontSize: theme.typography.size.md,
    },
    actions: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.sm },
    cancelBtn: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      alignItems: "center",
      marginTop: theme.spacing.sm,
    },
  });
}
