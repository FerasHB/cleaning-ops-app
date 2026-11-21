// features/profile/components/RecoveryExportSection.tsx
// Work Recovery S1.7: Export der Prüffall-Nachweise vor der Firmenlöschung.
//
// Ablauf (Regeln: services/account/recoveryExport.core.ts):
//   1. "Nachweise exportieren" → Server liefert den exakten Export-Text +
//      SHA-256; die App schreibt ihn ins Dokumentverzeichnis, liest ihn
//      zurück und prüft ihn. Keine Daten → "nicht nötig", nichts zu bestätigen.
//   2. Optional teilen/sichern (das Ergebnis des Teilen-Dialogs zählt nicht).
//   3. Eigene Checkbox "außerhalb dieses Geräts gesichert" + Button
//      "Export bestätigen" → erst dann acknowledge_company_recovery_export.
//   4. Veraltet (recovery_export_stale) → zurück auf Anfang, neu exportieren.
//   5. S1.8: Nach der Server-Bestätigung kann der Admin die lokale Kopie
//      ausdrücklich löschen (eigener Bestätigungsdialog). Nie automatisch,
//      nie Server-Daten. Eigener Zustand localCopy statt neuer Phase, damit
//      die Löschsperre (phase === "acknowledged") unverändert bleibt.
//
// Meldet dem Screen per onBlockingChange, ob die Löschung aus Sicht der App
// gesperrt ist (Export nötig, aber nicht bestätigt, oder offene Fälle). Die
// verbindliche Sperre liegt im Server (purge_company_for_last_admin).
// Keine Logs, keine Analytics: der Export enthält interne Notizen.

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { recoveryExportDeps, shareRecoveryExportFile } from "@/services/account/recoveryExport";
import {
  acknowledgeRecoveryExport,
  classifyRecoveryExportError,
  deleteLocalRecoveryCopy,
  isLocalCopyDeletable,
  prepareRecoveryExport,
  type PreparedRecoveryExport,
  type RecoveryExportErrorKind,
} from "@/services/account/recoveryExport.core";
import { alertDialog, confirmDialog } from "@/utils/dialogs";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Phase = "idle" | "exporting" | "notRequired" | "written" | "acknowledging" | "acknowledged";
type LocalCopy = "present" | "deleting" | "deleted";

const ERROR_KEY: Record<RecoveryExportErrorKind, string> = {
  unsupported_platform: "unsupportedPlatform",
  unauthenticated: "notAuthorized",
  not_authorized: "notAuthorized",
  invalid_response: "failed",
  write_failed: "writeFailed",
  verify_failed: "verifyFailed",
  not_required: "failed",
  not_confirmed: "failed",
  stale: "stale",
  transport: "failed",
  insecure_storage: "insecureStorage",
  not_acknowledged: "deleteLocalFailed",
  invalid_file_name: "deleteLocalFailed",
  delete_failed: "deleteLocalFailed",
  unknown: "failed",
};

export function RecoveryExportSection({
  companyName,
  disabled,
  resetKey,
  requiredByServer,
  onBlockingChange,
}: {
  companyName: string;
  disabled: boolean;
  /** Erhöhen, um den Abschnitt zurückzusetzen (z. B. nach Server-Ablehnung). */
  resetKey: number;
  /**
   * Server hat die Löschung bereits wegen fehlender/veralteter Bestätigung
   * oder offener Fälle abgelehnt: Nachweise existieren, auch wenn dieser
   * Abschnitt (nach einem Reset) noch keinen eigenen Export kennt.
   */
  requiredByServer: boolean;
  onBlockingChange: (blocking: boolean) => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const [phase, setPhase] = useState<Phase>("idle");
  const [prepared, setPrepared] = useState<PreparedRecoveryExport | null>(null);
  const [savedOutside, setSavedOutside] = useState(false);
  const [errorKind, setErrorKind] = useState<RecoveryExportErrorKind | null>(null);
  // Einmal festgestellt, dass Nachweise existieren, bleibt die Sperre bestehen
  // — auch während eines erneuten Exports und nach "veraltet" — bis zum Reset
  // von außen oder bis ein neuer Export "keine Daten" meldet.
  const [recordsKnown, setRecordsKnown] = useState(false);
  const [localCopy, setLocalCopy] = useState<LocalCopy>("present");
  const busy = phase === "exporting" || phase === "acknowledging" || localCopy === "deleting";

  // Jeder Export-/Bestätigungslauf und jedes Zurücksetzen erhöht den Zähler;
  // ein Ergebnis aus einem älteren Lauf wird verworfen (kein spätes
  // Wiederbefüllen nach einem Reset).
  const runRef = useRef(0);

  // Zurücksetzen von außen (nicht beim ersten Rendern).
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    runRef.current += 1;
    setRecordsKnown(false);
    setPhase("idle");
    setPrepared(null);
    setSavedOutside(false);
    setErrorKind(null);
    setLocalCopy("present");
  }, [resetKey]);

  // Löschung aus App-Sicht gesperrt, sobald bekannt ist, dass Nachweise
  // existieren und noch nicht bestätigt sind, oder Fälle offen sind.
  // Während eines laufenden Exports/einer Bestätigung ebenfalls gesperrt.
  // Ein frischer Export mit "keine Daten" hebt die Server-Meldung auf (der
  // Server prüft bei der Löschung ohnehin erneut).
  const required = recordsKnown || (requiredByServer && phase !== "notRequired");
  const blocking =
    busy ||
    (required && (phase !== "acknowledged" || (prepared?.openCaseCount ?? 0) > 0));
  useEffect(() => {
    onBlockingChange(blocking);
  }, [blocking, onBlockingChange]);

  const handleExport = async () => {
    if (busy || disabled) return;
    const run = ++runRef.current;
    setPhase("exporting");
    setErrorKind(null);
    setPrepared(null);
    setSavedOutside(false);
    setLocalCopy("present");
    try {
      const result = await prepareRecoveryExport(recoveryExportDeps, companyName);
      if (run !== runRef.current) return;
      setPrepared(result);
      setRecordsKnown(result.required);
      setPhase(result.required ? "written" : "notRequired");
    } catch (err) {
      if (run !== runRef.current) return;
      setErrorKind(classifyRecoveryExportError(err));
      setPhase("idle");
    }
  };

  const handleShare = async () => {
    if (!prepared?.uri || busy) return;
    try {
      await shareRecoveryExportFile(prepared.uri);
    } catch {
      // Abbruch/Fehler des Teilen-Dialogs: die geprüfte Datei bleibt auf dem
      // Gerät; bestätigt wird ohnehin nur über die eigene Checkbox.
      await alertDialog(
        t("common:errors.title"),
        t("profile:deleteAccount.recovery.shareHint"),
      );
    }
  };

  const handleAcknowledge = async () => {
    if (busy || disabled || !savedOutside) return;
    const run = ++runRef.current;
    setPhase("acknowledging");
    setErrorKind(null);
    try {
      await acknowledgeRecoveryExport(recoveryExportDeps, prepared, savedOutside);
      if (run !== runRef.current) return;
      setPhase("acknowledged");
    } catch (err) {
      if (run !== runRef.current) return;
      const kind = classifyRecoveryExportError(err);
      setErrorKind(kind);
      if (kind === "stale") {
        // Neuer Export nötig — der alte darf nicht noch einmal bestätigt werden.
        setPrepared(null);
        setSavedOutside(false);
        setPhase("idle");
      } else {
        setPhase("written");
      }
    }
  };

  // S1.8: lokale Kopie löschen — nur nach Server-Bestätigung, nur nach
  // eigenem Bestätigungsdialog, nur die Datei dieses Exports.
  const handleDeleteLocal = async () => {
    if (busy || disabled || phase !== "acknowledged") return;
    if (!isLocalCopyDeletable(prepared, true)) return;
    const confirmed = await confirmDialog({
      title: t("profile:deleteAccount.recovery.deleteLocalConfirmTitle"),
      message: t("profile:deleteAccount.recovery.deleteLocalConfirmMessage", {
        name: prepared?.fileName ?? "",
      }),
      confirmLabel: t("profile:deleteAccount.recovery.deleteLocalConfirmAction"),
      destructive: true,
    });
    if (!confirmed) return;
    const run = ++runRef.current;
    setLocalCopy("deleting");
    setErrorKind(null);
    try {
      await deleteLocalRecoveryCopy(recoveryExportDeps, prepared, {
        acknowledged: true,
        userConfirmed: confirmed,
      });
      if (run !== runRef.current) return;
      setLocalCopy("deleted");
    } catch (err) {
      if (run !== runRef.current) return;
      setErrorKind(classifyRecoveryExportError(err));
      setLocalCopy("present");
    }
  };

  const counts = prepared?.counts;
  const openCases = prepared?.openCaseCount ?? 0;
  const showExportButton = phase === "idle" || phase === "exporting" || phase === "notRequired";

  return (
    <View style={styles.block}>
      <Text style={styles.text}>{t("profile:deleteAccount.recovery.text")}</Text>

      {errorKind && (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={16} color={theme.colors.error} />
          <Text style={styles.errorText}>
            {t(`profile:deleteAccount.recovery.${ERROR_KEY[errorKind]}`)}
          </Text>
        </View>
      )}

      {showExportButton && (
        <TouchableOpacity
          style={styles.primary}
          activeOpacity={0.85}
          onPress={() => void handleExport()}
          disabled={busy || disabled}
          accessibilityRole="button"
        >
          {phase === "exporting" ? (
            <ActivityIndicator size="small" color={theme.colors.onPrimary} />
          ) : (
            <>
              <Ionicons name="document-lock-outline" size={18} color={theme.colors.onPrimary} />
              <Text style={styles.primaryText}>
                {t("profile:deleteAccount.recovery.exportButton")}
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {phase === "notRequired" && (
        <View style={styles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color={theme.colors.statusCompleted} />
          <Text style={styles.doneText}>{t("profile:deleteAccount.recovery.notRequired")}</Text>
        </View>
      )}

      {prepared?.required && counts && phase !== "idle" && (
        <>
          <View style={styles.doneRow}>
            <Ionicons name="checkmark-circle" size={16} color={theme.colors.statusCompleted} />
            <Text style={styles.doneText}>
              {t("profile:deleteAccount.recovery.written", {
                cases: counts.cases,
                submissions: counts.submissions,
                events: counts.events,
              })}
            </Text>
          </View>
          {prepared.fileName && (
            <Text style={styles.meta} numberOfLines={2}>
              {t("profile:deleteAccount.recovery.fileName", { name: prepared.fileName })}
            </Text>
          )}

          {openCases > 0 && (
            <View style={styles.errorRow}>
              <Ionicons name="lock-closed" size={16} color={theme.colors.error} />
              <Text style={styles.errorText}>
                {t("profile:deleteAccount.recovery.openCases", { count: openCases })}
              </Text>
            </View>
          )}

          {phase !== "acknowledged" && (
            <>
              <TouchableOpacity
                style={styles.secondary}
                activeOpacity={0.8}
                onPress={() => void handleShare()}
                disabled={busy}
                accessibilityRole="button"
              >
                <Ionicons name="share-outline" size={18} color={theme.colors.primary} />
                <Text style={styles.secondaryText}>
                  {t("profile:deleteAccount.recovery.shareButton")}
                </Text>
              </TouchableOpacity>
              <Text style={styles.meta}>{t("profile:deleteAccount.recovery.shareHint")}</Text>

              <TouchableOpacity
                style={styles.checkboxRow}
                activeOpacity={0.8}
                onPress={() => setSavedOutside((v) => !v)}
                disabled={busy || disabled || openCases > 0}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: savedOutside, disabled: busy || disabled || openCases > 0 }}
              >
                <View style={[styles.checkbox, savedOutside && styles.checkboxChecked]}>
                  {savedOutside && (
                    <Ionicons name="checkmark" size={15} color={theme.colors.onPrimary} />
                  )}
                </View>
                <Text style={styles.checkboxLabel}>
                  {t("profile:deleteAccount.recovery.confirmLabel")}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.primary,
                  (!savedOutside || busy || disabled || openCases > 0) && styles.primaryDisabled,
                ]}
                activeOpacity={0.85}
                onPress={() => void handleAcknowledge()}
                disabled={!savedOutside || busy || disabled || openCases > 0}
                accessibilityRole="button"
              >
                {phase === "acknowledging" ? (
                  <ActivityIndicator size="small" color={theme.colors.onPrimary} />
                ) : (
                  <Text style={styles.primaryText}>
                    {t("profile:deleteAccount.recovery.acknowledgeButton")}
                  </Text>
                )}
              </TouchableOpacity>
              {openCases === 0 && (
                <Text style={styles.meta}>{t("profile:deleteAccount.recovery.deleteBlocked")}</Text>
              )}
            </>
          )}

          {phase === "acknowledged" && (
            <View style={styles.doneRow}>
              <Ionicons name="shield-checkmark" size={16} color={theme.colors.statusCompleted} />
              <Text style={styles.doneText}>
                {t("profile:deleteAccount.recovery.acknowledged")}
              </Text>
            </View>
          )}

          {phase === "acknowledged" && localCopy !== "deleted" && isLocalCopyDeletable(prepared, true) && (
            <>
              <Text style={styles.meta}>{t("profile:deleteAccount.recovery.deleteLocalHint")}</Text>
              <TouchableOpacity
                style={styles.secondary}
                activeOpacity={0.8}
                onPress={() => void handleDeleteLocal()}
                disabled={busy || disabled}
                accessibilityRole="button"
              >
                {localCopy === "deleting" ? (
                  <ActivityIndicator size="small" color={theme.colors.error} />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={18} color={theme.colors.error} />
                    <Text style={[styles.secondaryText, { color: theme.colors.error }]}>
                      {t("profile:deleteAccount.recovery.deleteLocalButton")}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}

          {phase === "acknowledged" && localCopy === "deleted" && (
            <View style={styles.doneRow}>
              <Ionicons name="checkmark-circle" size={16} color={theme.colors.statusCompleted} />
              <Text style={styles.doneText}>
                {t("profile:deleteAccount.recovery.deleteLocalDone")}
              </Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    block: { padding: theme.spacing.md, gap: theme.spacing.sm },
    text: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.sm,
      color: theme.colors.onSurfaceVariant,
    },
    meta: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.xs,
      color: theme.colors.onSurfaceVariant,
    },
    primary: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.sm,
      minHeight: 44,
    },
    primaryDisabled: { opacity: 0.5 },
    primaryText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onPrimary,
    },
    secondary: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.xs,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.sm,
      minHeight: 44,
    },
    secondaryText: {
      fontSize: theme.typography.size.md,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
    doneRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.xs },
    doneText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.xs,
      color: theme.colors.onSurface,
      flex: 1,
    },
    errorRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing.xs },
    errorText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.xs,
      color: theme.colors.error,
      flex: 1,
    },
    checkboxRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: theme.colors.outline,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    checkboxLabel: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.sm,
      color: theme.colors.onSurface,
      flex: 1,
    },
  });
}
