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
  AuRestorationCandidate,
  AuRestorationInput,
} from "@/types/absenceEvidence";
import { AU_NOT_REVIEWED_LABEL, AU_STATUS_LABELS } from "@/types/absenceEvidence";
import { formatDays } from "@/utils/vacationBalance";
import { formatDateOnlyDE, formatForDisplay } from "@/utils/date";
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

export default function AdminAuReviewScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
        setError(`Ungültiger Wert für ${formatDateOnlyDE(c.vacationStart)}.`);
        return;
      }
      if (days > c.restorableDays) {
        setError(
          `Für ${formatDateOnlyDE(c.vacationStart)} sind höchstens ${formatDays(c.restorableDays)} Tage möglich.`,
        );
        return;
      }
      items.push({ vacation_absence_id: c.vacationAbsenceId, year: c.year, days });
    }

    if (items.length === 0) {
      setError("Bitte mindestens einen Wert eintragen.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created = await restoreVacationFromAu(evidence.id, items);
      alertDialog(
        "Gebucht",
        created > 0
          ? "Die Urlaubstage wurden im Urlaubskonto gutgeschrieben."
          : "Diese Rückgabe war bereits gebucht.",
      );
      await load();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = evidence
    ? AU_STATUS_LABELS[evidence.status]
    : AU_NOT_REVIEWED_LABEL;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <AppHeader title="Arbeitsunfähigkeit" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <ErrorBanner message={error} /> : null}
        {loading ? <ActivityIndicator color={theme.colors.primary} /> : null}

        {!loading ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Status</Text>
              <Text style={styles.status}>{statusLabel}</Text>
              {evidence?.confirmedAt ? (
                <Text style={styles.hint}>
                  Entschieden am {formatForDisplay(evidence.confirmedAt)}
                </Text>
              ) : null}
              <Text style={styles.hint}>
                Eine Krankmeldung allein gibt keinen Urlaub zurück. Erst eine
                bestätigte Arbeitsunfähigkeit berechtigt dazu.
              </Text>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.confirmBtn, busy && styles.disabled]}
                  onPress={() => handleReview("confirmed")}
                  disabled={busy}
                >
                  <Text style={styles.confirmText}>AU bestätigen</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.rejectBtn, busy && styles.disabled]}
                  onPress={() => handleReview("rejected")}
                  disabled={busy}
                >
                  <Text style={styles.rejectText}>AU ablehnen</Text>
                </TouchableOpacity>
              </View>
            </View>

            {evidence?.status === "confirmed" ? (
              candidates.length > 0 ? (
                <>
                  <Text style={styles.sectionTitle}>Urlaubstage zurückgeben</Text>
                  {candidates.map((c) => (
                    <View key={keyOf(c)} style={styles.card}>
                      <Text style={styles.cardTitle}>
                        Urlaub {formatDateOnlyDE(c.vacationStart)}–
                        {formatDateOnlyDE(c.vacationEnd)}
                        {candidates.some((o) => o.year !== c.year) ? ` · ${c.year}` : ""}
                      </Text>
                      <Text style={styles.hint}>
                        Abgezogen: {formatDays(c.deductedDays)} Tage
                        {c.alreadyRestored > 0
                          ? ` · bereits zurückgegeben: ${formatDays(c.alreadyRestored)}`
                          : ""}
                      </Text>
                      <Text style={styles.hint}>
                        AU-Überschneidung: {formatDateOnlyDE(c.overlapStart)}–
                        {formatDateOnlyDE(c.overlapEnd)}
                      </Text>

                      {c.restorableDays <= 0 ? (
                        <Text style={styles.hint}>
                          Bereits vollständig zurückgegeben.
                        </Text>
                      ) : (
                        <>
                          <Text style={styles.label}>
                            Zurückgeben (max. {formatDays(c.restorableDays)})
                          </Text>
                          <TextInput
                            style={styles.input}
                            keyboardType="decimal-pad"
                            value={amounts[keyOf(c)] ?? ""}
                            onChangeText={(text) =>
                              setAmounts((prev) => ({ ...prev, [keyOf(c)]: text }))
                            }
                            placeholder={c.fullCoverage ? "" : "Bitte eintragen"}
                            placeholderTextColor={theme.colors.onSurfaceVariant}
                          />
                          {!c.fullCoverage ? (
                            <Text style={styles.hint}>
                              Die AU deckt den Urlaub nur teilweise ab — wie viele
                              der abgezogenen Tage betroffen sind, lässt sich nicht
                              berechnen. Bitte selbst festlegen.
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
                    <Text style={styles.confirmText}>Urlaubstage zurückgeben</Text>
                  </TouchableOpacity>
                  <Text style={styles.hint}>
                    Gutschriften werden nie gelöscht. Eine falsche Rückgabe wird
                    über eine manuelle Korrektur im Urlaubskonto berichtigt.
                  </Text>
                </>
              ) : (
                <View style={styles.card}>
                  <Text style={styles.hint}>
                    Keine abgezogenen Urlaubstage überschneiden sich mit dieser
                    Krankmeldung — es gibt nichts zurückzugeben.
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
