// features/absences/admin/AdminAuReviewScreen.tsx
// AU-Prüfung einer Krankmeldung + Rückgabe abgezogener Urlaubstage.
//
// KERNREGEL im UI gespiegelt: die Rückgabe-Sektion erscheint ERST nach
// bestätigter AU. Eine blosse Krankmeldung bietet sie gar nicht an.
//
// TEILÜBERSCHNEIDUNG WIRD NICHT GERATEN: der Abzug liegt als Jahres-Aggregat
// vor, ohne Tagesbezug. Deckt die AU nur einen Teil des Urlaubs ab, bleibt
// das Feld LEER und der Admin trägt die Menge ein. Nur bei vollständiger
// Abdeckung ist der Wert eindeutig und wird vorbelegt.

import { AppHeader, ErrorBanner } from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  getAbsenceEvidence,
  getRestorationCandidates,
  restoreVacationFromAu,
  reviewAu,
} from "@/services/absences/auEvidence.service";
import type { AppTheme } from "@/constants/theme";
import type {
  AbsenceEvidence,
  AuEvidenceStatus,
  AuRestorationCandidate,
  AuRestorationInput,
} from "@/types/absenceEvidence";
import { formatDaysLocalized } from "@/utils/vacationBalance";
import { formatDateOnlyLocalized, formatDateTimeLocalized } from "@/utils/date";
import { alertDialog } from "@/utils/dialogs";
import { toUserMessage } from "@/utils/userMessages";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

const AU_STATUS_LABEL_KEYS: Record<AuEvidenceStatus, string> = {
  pending: "admin:auReview.statusPending",
  confirmed: "admin:auReview.statusConfirmed",
  rejected: "admin:auReview.statusRejected",
};

export default function AdminAuReviewScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<AbsenceEvidence | null>(null);
  const [candidates, setCandidates] = useState<AuRestorationCandidate[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const keyOf = (c: AuRestorationCandidate) => `${c.vacationAbsenceId}:${c.year}`;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const ev = await getAbsenceEvidence(id);
      setEvidence(ev);

      if (ev?.status === "confirmed") {
        const list = await getRestorationCandidates(id);
        setCandidates(list);
        // Vorbelegung NUR bei eindeutiger Lage (volle Abdeckung).
        const prefill: Record<string, string> = {};
        for (const c of list) {
          if (c.fullCoverage && c.restorableDays > 0) {
            prefill[`${c.vacationAbsenceId}:${c.year}`] = String(c.restorableDays);
          }
        }
        setAmounts(prefill);
      } else {
        setCandidates([]);
        setAmounts({});
      }
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReview = async (decision: "confirmed" | "rejected") => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await reviewAu(id, decision);
      await load();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!evidence) return;
    const items: AuRestorationInput[] = [];
    for (const c of candidates) {
      const raw = (amounts[keyOf(c)] ?? "").trim().replace(",", ".");
      if (!raw) continue;
      const days = Number(raw);
      if (!Number.isFinite(days) || days <= 0) {
        setError(
          t("admin:auReview.invalidValueError", {
            date: formatDateOnlyLocalized(c.vacationStart),
          }),
        );
        return;
      }
      if (days > c.restorableDays) {
        setError(
          t("admin:auReview.maxDaysError", {
            date: formatDateOnlyLocalized(c.vacationStart),
            max: formatDaysLocalized(c.restorableDays),
          }),
        );
        return;
      }
      items.push({ vacation_absence_id: c.vacationAbsenceId, year: c.year, days });
    }

    if (items.length === 0) {
      setError(t("admin:auReview.minOneValueError"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created = await restoreVacationFromAu(evidence.id, items);
      alertDialog(
        t("admin:auReview.bookedDialogTitle"),
        created > 0
          ? t("admin:auReview.bookedMessage")
          : t("admin:auReview.alreadyBookedMessage"),
      );
      await load();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = evidence
    ? t(AU_STATUS_LABEL_KEYS[evidence.status])
    : t("admin:auReview.statusNotReviewed");

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <AppHeader title={t("admin:auReview.headerTitle")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <ErrorBanner message={error} /> : null}
        {loading ? <ActivityIndicator color={theme.colors.primary} /> : null}

        {!loading ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t("admin:auReview.statusLabel")}</Text>
              <Text style={styles.status}>{statusLabel}</Text>
              {evidence?.confirmedAt ? (
                <Text style={styles.hint}>
                  {t("admin:auReview.decidedOn", {
                    date: formatDateTimeLocalized(evidence.confirmedAt) ?? "",
                  })}
                </Text>
              ) : null}
              <Text style={styles.hint}>{t("admin:auReview.statusHint")}</Text>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.confirmBtn, busy && styles.disabled]}
                  onPress={() => handleReview("confirmed")}
                  disabled={busy}
                >
                  <Text style={styles.confirmText}>
                    {t("admin:auReview.confirmAuButton")}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.rejectBtn, busy && styles.disabled]}
                  onPress={() => handleReview("rejected")}
                  disabled={busy}
                >
                  <Text style={styles.rejectText}>
                    {t("admin:auReview.rejectAuButton")}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {evidence?.status === "confirmed" ? (
              candidates.length > 0 ? (
                <>
                  <Text style={styles.sectionTitle}>
                    {t("admin:auReview.restoreSectionTitle")}
                  </Text>
                  {candidates.map((c) => (
                    <View key={keyOf(c)} style={styles.card}>
                      <Text style={styles.cardTitle}>
                        {t("admin:auReview.vacationRangeTitle", {
                          start: formatDateOnlyLocalized(c.vacationStart),
                          end: formatDateOnlyLocalized(c.vacationEnd),
                        })}
                        {candidates.some((o) => o.year !== c.year) ? ` · ${c.year}` : ""}
                      </Text>
                      <Text style={styles.hint}>
                        {t("admin:auReview.deductedLabel", {
                          days: formatDaysLocalized(c.deductedDays),
                        })}
                        {c.alreadyRestored > 0
                          ? t("admin:auReview.alreadyRestoredSuffix", {
                              days: formatDaysLocalized(c.alreadyRestored),
                            })
                          : ""}
                      </Text>
                      <Text style={styles.hint}>
                        {t("admin:auReview.overlapLabel", {
                          start: formatDateOnlyLocalized(c.overlapStart),
                          end: formatDateOnlyLocalized(c.overlapEnd),
                        })}
                      </Text>

                      {c.restorableDays <= 0 ? (
                        <Text style={styles.hint}>
                          {t("admin:auReview.fullyRestoredHint")}
                        </Text>
                      ) : (
                        <>
                          <Text style={styles.label}>
                            {t("admin:auReview.restoreFieldLabel", {
                              max: formatDaysLocalized(c.restorableDays),
                            })}
                          </Text>
                          <TextInput
                            style={styles.input}
                            keyboardType="decimal-pad"
                            value={amounts[keyOf(c)] ?? ""}
                            onChangeText={(text) =>
                              setAmounts((prev) => ({ ...prev, [keyOf(c)]: text }))
                            }
                            placeholder={
                              c.fullCoverage
                                ? ""
                                : t("admin:auReview.restorePlaceholder")
                            }
                            placeholderTextColor={theme.colors.onSurfaceVariant}
                          />
                          {!c.fullCoverage ? (
                            <Text style={styles.hint}>
                              {t("admin:auReview.partialCoverageHint")}
                            </Text>
                          ) : null}
                        </>
                      )}
                    </View>
                  ))}

                  <TouchableOpacity
                    style={[styles.confirmBtn, busy && styles.disabled]}
                    onPress={handleRestore}
                    disabled={busy}
                  >
                    <Text style={styles.confirmText}>
                      {t("admin:auReview.restoreButton")}
                    </Text>
                  </TouchableOpacity>
                  <Text style={styles.hint}>
                    {t("admin:auReview.restoreFooterHint")}
                  </Text>
                </>
              ) : (
                <View style={styles.card}>
                  <Text style={styles.hint}>
                    {t("admin:auReview.noOverlapHint")}
                  </Text>
                </View>
              )
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
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
    status: {
      fontSize: theme.typography.size.lg,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.primary,
    },
    hint: {
      fontSize: theme.typography.size.xs,
      color: theme.colors.onSurfaceVariant,
      lineHeight: theme.typography.lineHeight.xs,
    },
    label: {
      fontSize: theme.typography.size.sm,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
      marginTop: theme.spacing.xs,
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
    confirmBtn: {
      flex: 1,
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      marginTop: theme.spacing.sm,
    },
    confirmText: {
      color: theme.colors.onPrimary,
      fontWeight: theme.typography.weight.semibold,
      fontSize: theme.typography.size.sm,
    },
    rejectBtn: {
      flex: 1,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      alignItems: "center",
      marginTop: theme.spacing.sm,
    },
    rejectText: { color: theme.colors.onSurface, fontSize: theme.typography.size.sm },
    disabled: { opacity: 0.6 },
  });
}
