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

interface EmailRowProps {
  /** Label der Zeile. Standard: "E-Mail". */
  label?: string;
  email: string | null | undefined;
  /** Text, wenn keine E-Mail-Adresse vorhanden ist. */
  emptyText?: string;
}

export function EmailRow({
  label = "E-Mail",
  email,
  emptyText = "Nicht hinterlegt",
}: EmailRowProps) {
  const trimmed = email?.trim();

  if (!trimmed) {
    return <InfoRow label={label} value={emptyText} icon="mail-outline" />;
  }

  return (
    <InfoRow
      label={label}
      value={trimmed}
      icon="mail-outline"
      onPress={() => {
        void emailContact(trimmed);
      }}
    />
  );
}
