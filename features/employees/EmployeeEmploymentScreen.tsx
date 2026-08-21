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
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS } from "@/types/employment";
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
      setError("Jahresanspruch: bitte eine Zahl eingeben (oder leer lassen).");
      return;
    }
    if (Number.isNaN(reference)) {
      setError("Referenz-Arbeitstage: bitte eine Zahl eingeben (oder leer lassen).");
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
      alertDialog("Gespeichert", "Die Konfiguration wurde übernommen.");
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
        <AppHeader title="Beschäftigung & Urlaub" onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <AppHeader title="Beschäftigung & Urlaub" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error ? <ErrorBanner message={error} /> : null}

          {/* ── Beschäftigung ── */}
          <Text style={styles.sectionTitle}>Beschäftigung</Text>
          <Text style={styles.hint}>
            Die Beschäftigungsart ist rein beschreibend und beeinflusst den
            Urlaubsanspruch nicht.
          </Text>

          <Text style={styles.label}>Beschäftigungsart</Text>
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
                    {EMPLOYMENT_TYPE_LABELS[type]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <DateTimeField
            label="Eintrittsdatum"
            mode="date"
            value={parseToDate(startDate)}
            onChange={(d) => setStartDate(formatDateISO(d))}
            placeholder="Nicht gesetzt"
          />
          <DateTimeField
            label="Austrittsdatum (optional)"
            mode="date"
            value={parseToDate(endDate)}
            onChange={(d) => setEndDate(formatDateISO(d))}
            placeholder="Nicht gesetzt"
          />

          {/* ── Urlaub ── */}
          <Text style={styles.sectionTitle}>Urlaub</Text>

          <View style={styles.switchRow}>
            <View style={styles.flex}>
              <Text style={styles.label}>Urlaubsverwaltung aktiv</Text>
              <Text style={styles.hint}>
                Steuert nur, ob TaskOps ein Urlaubskonto führt — nicht, ob ein
                gesetzlicher Anspruch besteht. Urlaubsanträge funktionieren
                unabhängig davon.
              </Text>
            </View>
            <Switch value={enabled} onValueChange={setEnabled} />
          </View>

          {enabled ? (
            <>
              <Input
                label="Jahresanspruch (Tage)"
                value={entitlementText}
                onChangeText={setEntitlementText}
                keyboardType="decimal-pad"
                placeholder={
                  defaults?.defaultAnnualEntitlementDays !== null &&
                  defaults?.defaultAnnualEntitlementDays !== undefined
                    ? `Firmen-Standard: ${defaults.defaultAnnualEntitlementDays}`
                    : "Kein Firmen-Standard hinterlegt"
                }
              />
              <Input
                label="Referenz-Arbeitstage/Woche"
                value={referenceText}
                onChangeText={setReferenceText}
                keyboardType="decimal-pad"
                placeholder={
                  defaults?.defaultReferenceDaysPerWeek !== null &&
                  defaults?.defaultReferenceDaysPerWeek !== undefined
                    ? `Firmen-Standard: ${defaults.defaultReferenceDaysPerWeek}`
                    : "Kein Firmen-Standard hinterlegt"
                }
              />
              <Text style={styles.hint}>
                Leer lassen = Firmen-Standard verwenden.
              </Text>

              {preview?.status === "configured" ? (
                <View style={styles.previewBox}>
                  <Text style={styles.previewLine}>
                    Jahresanspruch: {preview.annualEntitlementDays.value} Tage (
                    {describeSource(preview.annualEntitlementDays.source)})
                  </Text>
                  <Text style={styles.previewLine}>
                    Referenz-Arbeitstage: {preview.referenceDaysPerWeek.value}/Woche (
                    {describeSource(preview.referenceDaysPerWeek.source)})
                  </Text>
                  <Text style={styles.previewNote}>
                    Konfiguration — kein Resturlaub. Die Verbrauchsrechnung folgt später.
                  </Text>
                </View>
              ) : null}

              {preview?.status === "incomplete" ? (
                <View style={[styles.previewBox, styles.previewWarn]}>
                  <Text style={styles.previewLine}>
                    Konfiguration unvollständig — es fehlt:{" "}
                    {preview.missing
                      .map((m) =>
                        m === "entitlement" ? "Jahresanspruch" : "Referenz-Arbeitstage",
                      )
                      .join(", ")}
                    .
                  </Text>
                  <Text style={styles.previewNote}>
                    Entweder hier eintragen oder einen Firmen-Standard hinterlegen.
                  </Text>
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.hint}>
              Urlaubsverwaltung ist deaktiviert. Es wird kein Urlaubskonto
              angezeigt oder berechnet.
            </Text>
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
              <Text style={styles.saveText}>Speichern</Text>
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
