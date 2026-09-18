// components/ui/PhoneRow.tsx
// ─────────────────────────────────────────────────────────────────
// Telefon-Zeile für Detail-Screens: zeigt die Nummer formatiert an und macht
// sie antippbar → Bestätigungsdialog → Dialer (callPhone, siehe utils/dialogs).
//
// Ist keine (gültige) Nummer hinterlegt, wird eine nicht-tippbare Info-Zeile
// mit `emptyText` gerendert — sie sieht dann nicht aus wie etwas, das
// irgendwohin führt.
// ─────────────────────────────────────────────────────────────────

import { InfoRow } from "@/components/ui/InfoRow";
import { callPhone } from "@/utils/dialogs";
import { formatPhoneForDisplay, isValidPhone } from "@/utils/phone";
import React from "react";
import { useTranslation } from "react-i18next";

interface PhoneRowProps {
  /** Label der Zeile. Standard: übersetztes "Telefon" (profile:rows.phone). */
  label?: string;
  /** Roh oder E.164 — wird für Anzeige und Anruf normalisiert. */
  phone: string | null | undefined;
  /** Name für den Bestätigungsdialog ("<name> anrufen?"). */
  contactName?: string;
  /** Text, wenn keine gültige Nummer vorhanden ist. Standard: übersetztes "Nicht hinterlegt" (common:states.notProvided) — dieselbe Quelle wie EmailRow. */
  emptyText?: string;
}

export function PhoneRow({
  label,
  phone,
  contactName,
  emptyText,
}: PhoneRowProps) {
  const { t } = useTranslation();
  const valid = isValidPhone(phone);
  const resolvedLabel = label ?? t("profile:rows.phone");
  const resolvedEmptyText = emptyText ?? t("common:states.notProvided");

  if (!valid) {
    return <InfoRow label={resolvedLabel} value={resolvedEmptyText} icon="call-outline" />;
  }

  return (
    <InfoRow
      label={resolvedLabel}
      value={formatPhoneForDisplay(phone)}
      icon="call-outline"
      onPress={() => {
        void callPhone(phone, { label: contactName });
      }}
    />
  );
}
