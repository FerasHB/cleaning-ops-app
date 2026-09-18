// features/employees/EmployeeEmploymentScreen.tsx
// "Beschäftigung & Urlaub" — Admin-Konfiguration eines Mitarbeiters.
//
// BEWUSST NUR KONFIGURATION: hier steht kein Saldo, kein Resturlaub, kein
// Verbrauch. Diese Zahlen existieren noch nicht (Ledger folgt im nächsten
// Arbeitspaket) — sie hier anzudeuten würde Werte vortäuschen, die niemand
// pflegt.
//
// Struktur/Konventionen wie AdminCreateAbsenceScreen (AppHeader, ErrorBanner,
// Input, DateTimeField, KeyboardAvoidingView).

import { AppHeader, ErrorBanner, Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  getCompanyVacationDefaults,
  getEmploymentConfig,
  updateEmploymentConfig,
} from "@/services/employees/employmentConfig.service";
import type { AppTheme } from "@/constants/theme";
import type {
  CompanyVacationDefaults,
  EmploymentConfig,
  EmploymentType,
} from "@/types/employment";
import { EMPLOYMENT_TYPES } from "@/types/employment";
import { describeSource, resolveEffectiveVacationConfig } from "@/utils/vacationConfig";
import { formatDateISO, parseToDate } from "@/utils/date";
import { alertDialog } from "@/utils/dialogs";
import { toUserMessage } from "@/utils/userMessages";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

const EMPLOYMENT_TYPE_LABEL_KEYS: Record<EmploymentType, string> = {
  vollzeit: "admin:employment.typeVollzeit",
  teilzeit: "admin:employment.typeTeilzeit",
  minijob: "admin:employment.typeMinijob",
  aushilfe: "admin:employment.typeAushilfe",
  sonstiges: "admin:employment.typeSonstiges",
};

// Leerer Text -> null (= Firmen-Default gilt). Wichtig, damit ein geleertes
// Feld den Override wirklich ENTFERNT und nicht als 0 gespeichert wird.
function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

function numberToText(value: number | null): string {
  return value === null ? "" : String(value);
}

export default function EmployeeEmploymentScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<CompanyVacationDefaults | null>(null);

  const [employmentType, setEmploymentType] = useState<EmploymentType | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [entitlementText, setEntitlementText] = useState("");
  const [referenceText, setReferenceText] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [config, companyDefaults] = await Promise.all([
        getEmploymentConfig(id),
        getCompanyVacationDefaults(),
      ]);
      setEmploymentType(config.employmentType);
      setStartDate(config.employmentStartDate);
      setEndDate(config.employmentEndDate);
      setEnabled(config.vacationManagementEnabled);
      setEntitlementText(numberToText(config.vacationAnnualEntitlementDays));
      setReferenceText(numberToText(config.vacationReferenceDaysPerWeek));
      setDefaults(companyDefaults);
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Vorschau der EFFEKTIVEN Konfiguration mit den aktuell eingegebenen Werten,
  // damit der Admin sofort sieht, ob ein Wert vom Firmen-Standard kommt oder
  // individuell gesetzt ist — und ob noch etwas fehlt.
  const preview = useMemo(() => {
    if (!defaults) return null;
    const entitlement = parseOptionalNumber(entitlementText);
    const reference = parseOptionalNumber(referenceText);
    if (Number.isNaN(entitlement) || Number.isNaN(reference)) return null;

    const config: EmploymentConfig = {
      employmentType,
      employmentStartDate: startDate,
      employmentEndDate: endDate,
      vacationManagementEnabled: enabled,
      vacationAnnualEntitlementDays: entitlement,
      vacationReferenceDaysPerWeek: reference,
    };
    return resolveEffectiveVacationConfig(config, defaults);
  }, [defaults, employmentType, startDate, endDate, enabled, entitlementText, referenceText]);

  const handleSave = async () => {
    if (!id) return;

    const entitlement = parseOptionalNumber(entitlementText);
    const reference = parseOptionalNumber(referenceText);

    if (Number.isNaN(entitlement)) {
      setError(t("admin:employment.entitlementNumberError"));
      return;
    }
    if (Number.isNaN(reference)) {
      setError(t("admin:employment.referenceNumberError"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateEmploymentConfig({
        employeeId: id,
        employmentType,
        employmentStartDate: startDate,
        employmentEndDate: endDate,
        vacationManagementEnabled: enabled,
        vacationAnnualEntitlementDays: entitlement,
        vacationReferenceDaysPerWeek: reference,
      });
      alertDialog(
        t("admin:employment.savedDialogTitle"),
        t("admin:employment.savedDialogMessage"),
      );
      router.back();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <AppHeader title={t("admin:employment.title")} onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <AppHeader title={t("admin:employment.title")} onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error ? <ErrorBanner message={error} /> : null}

          {/* ── Beschäftigung ── */}
          <Text style={styles.sectionTitle}>
            {t("admin:employment.sectionEmployment")}
          </Text>
          <Text style={styles.hint}>{t("admin:employment.employmentHint")}</Text>

          <Text style={styles.label}>{t("admin:employment.typeLabel")}</Text>
          <View style={styles.chipRow}>
            {EMPLOYMENT_TYPES.map((type) => {
              const active = employmentType === type;
              return (
                <TouchableOpacity
                  key={type}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setEmploymentType(active ? null : type)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {t(EMPLOYMENT_TYPE_LABEL_KEYS[type])}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <DateTimeField
            label={t("admin:employment.startDateLabel")}
            mode="date"
            value={parseToDate(startDate)}
            onChange={(d) => setStartDate(formatDateISO(d))}
            placeholder={t("admin:employment.notSetPlaceholder")}
          />
          <DateTimeField
            label={t("admin:employment.endDateLabel")}
            mode="date"
            value={parseToDate(endDate)}
            onChange={(d) => setEndDate(formatDateISO(d))}
            placeholder={t("admin:employment.notSetPlaceholder")}
          />

          {/* ── Urlaub ── */}
          <Text style={styles.sectionTitle}>
            {t("admin:employment.sectionVacation")}
          </Text>

          <View style={styles.switchRow}>
            <View style={styles.flex}>
              <Text style={styles.label}>
                {t("admin:employment.vacationEnabledLabel")}
              </Text>
              <Text style={styles.hint}>
                {t("admin:employment.vacationEnabledHint")}
              </Text>
            </View>
            <Switch value={enabled} onValueChange={setEnabled} />
          </View>

          {enabled ? (
            <>
              <Input
                label={t("admin:employment.entitlementLabel")}
                value={entitlementText}
                onChangeText={setEntitlementText}
                keyboardType="decimal-pad"
                placeholder={
                  defaults?.defaultAnnualEntitlementDays !== null &&
                  defaults?.defaultAnnualEntitlementDays !== undefined
                    ? t("admin:employment.companyDefaultPlaceholder", {
                        value: defaults.defaultAnnualEntitlementDays,
                      })
                    : t("admin:employment.noCompanyDefaultPlaceholder")
                }
              />
              <Input
                label={t("admin:employment.referenceLabel")}
                value={referenceText}
                onChangeText={setReferenceText}
                keyboardType="decimal-pad"
                placeholder={
                  defaults?.defaultReferenceDaysPerWeek !== null &&
                  defaults?.defaultReferenceDaysPerWeek !== undefined
                    ? t("admin:employment.companyDefaultPlaceholder", {
                        value: defaults.defaultReferenceDaysPerWeek,
                      })
                    : t("admin:employment.noCompanyDefaultPlaceholder")
                }
              />
              <Text style={styles.hint}>{t("admin:employment.leaveEmptyHint")}</Text>

              {preview?.status === "configured" ? (
                <View style={styles.previewBox}>
                  <Text style={styles.previewLine}>
                    {t("admin:employment.previewEntitlement", {
                      value: preview.annualEntitlementDays.value,
                      source: describeSource(preview.annualEntitlementDays.source),
                    })}
                  </Text>
                  <Text style={styles.previewLine}>
                    {t("admin:employment.previewReference", {
                      value: preview.referenceDaysPerWeek.value,
                      source: describeSource(preview.referenceDaysPerWeek.source),
                    })}
                  </Text>
                  <Text style={styles.previewNote}>
                    {t("admin:employment.previewNote")}
                  </Text>
                </View>
              ) : null}

              {preview?.status === "incomplete" ? (
                <View style={[styles.previewBox, styles.previewWarn]}>
                  <Text style={styles.previewLine}>
                    {t("admin:employment.incompletePrefix", {
                      missing: preview.missing
                        .map((m) =>
                          m === "entitlement"
                            ? t("admin:employment.missingEntitlement")
                            : t("admin:employment.missingReference"),
                        )
                        .join(", "),
                    })}
                  </Text>
                  <Text style={styles.previewNote}>
                    {t("admin:employment.incompleteNote")}
                  </Text>
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.hint}>{t("admin:employment.disabledHint")}</Text>
          )}

          <TouchableOpacity
            style={[styles.saveButton, saving && styles.saveButtonDisabled]}
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
          >
            {saving ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.saveText}>{t("admin:employment.saveButton")}</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    flex: { flex: 1 },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
    sectionTitle: {
      fontSize: theme.typography.size.lg,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      marginTop: theme.spacing.lg,
    },
    label: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
    hint: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.xs,
    },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs },
    chip: {
      paddingVertical: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surface,
    },
    chipActive: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    chipText: { fontSize: theme.typography.size.sm, color: theme.colors.onSurface },
    chipTextActive: { color: theme.colors.onPrimary },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    previewBox: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      padding: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    previewWarn: { borderColor: theme.colors.error },
    previewLine: { fontSize: theme.typography.size.sm, color: theme.colors.onSurface },
    previewNote: { fontSize: theme.typography.size.xs, color: theme.colors.onSurfaceVariant },
    saveButton: {
      marginTop: theme.spacing.xl,
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
    },
    saveButtonDisabled: { opacity: 0.6 },
    saveText: {
      fontSize: theme.typography.size.md,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
    },
  });
}
