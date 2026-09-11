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

interface PhoneRowProps {
  /** Label der Zeile. Standard: "Telefon". */
  label?: string;
  /** Roh oder E.164 — wird für Anzeige und Anruf normalisiert. */
  phone: string | null | undefined;
  /** Name für den Bestätigungsdialog ("<name> anrufen?"). */
  contactName?: string;
  /** Text, wenn keine gültige Nummer vorhanden ist. */
  emptyText?: string;
}

export function PhoneRow({
  label = "Telefon",
  phone,
  contactName,
  emptyText = "Nicht hinterlegt",
}: PhoneRowProps) {
  const valid = isValidPhone(phone);

  if (!valid) {
    return <InfoRow label={label} value={emptyText} icon="call-outline" />;
  }

  return (
    <InfoRow
      label={label}
      value={formatPhoneForDisplay(phone)}
      icon="call-outline"
      onPress={() => {
        void callPhone(phone, { label: contactName });
      }}
    />
  );
}
