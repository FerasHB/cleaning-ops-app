// components/ui/EmailRow.tsx
// ─────────────────────────────────────────────────────────────────
// E-Mail-Zeile für Detail-Screens: zeigt die Adresse an und macht sie
// antippbar → mailto: (ohne Bestätigungsdialog, siehe utils/dialogs).
//
// Ist keine (gültige) Adresse hinterlegt, wird eine nicht-tippbare Info-Zeile
// mit `emptyText` gerendert — analog zu PhoneRow.
// ─────────────────────────────────────────────────────────────────

import { InfoRow } from "@/components/ui/InfoRow";
import { emailContact } from "@/utils/dialogs";
import React from "react";
import { useTranslation } from "react-i18next";

interface EmailRowProps {
  /** Label der Zeile. Standard: übersetztes "E-Mail" (profile:rows.email). */
  label?: string;
  email: string | null | undefined;
  /** Text, wenn keine E-Mail-Adresse vorhanden ist. Standard: übersetztes "Nicht hinterlegt" (common:states.notProvided) — dieselbe Quelle wie PhoneRow. */
  emptyText?: string;
}

export function EmailRow({
  label,
  email,
  emptyText,
}: EmailRowProps) {
  const { t } = useTranslation();
  const trimmed = email?.trim();
  const resolvedLabel = label ?? t("profile:rows.email");
  const resolvedEmptyText = emptyText ?? t("common:states.notProvided");

  if (!trimmed) {
    return <InfoRow label={resolvedLabel} value={resolvedEmptyText} icon="mail-outline" />;
  }

  return (
    <InfoRow
      label={resolvedLabel}
      value={trimmed}
      icon="mail-outline"
      onPress={() => {
        void emailContact(trimmed);
      }}
    />
  );
}
