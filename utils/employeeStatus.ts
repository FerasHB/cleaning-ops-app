// utils/employeeStatus.ts
// Zentrale Ableitung des Anzeige-Status eines Mitarbeiters aus EmployeeOption —
// genutzt von der Mitarbeiter-Liste UND dem Detail-Screen, damit die
// Eingeladen/Aktiv/Inaktiv-Logik nicht doppelt gepflegt wird.

import type { EmployeeOption } from "@/types/job";
import { i18next } from "@/i18n";

export type EmployeeStatusVariant = "pending" | "active" | "inactive";

export type EmployeeStatus = {
  label: string;
  variant: EmployeeStatusVariant;
};

// Einladung noch offen (kein eigenes Passwort gesetzt) hat Vorrang vor
// Aktiv/Inaktiv — das ist der Zustand, den ein Admin zuerst sehen und auf den
// er ggf. reagieren muss (Einladung erneut senden).
export function getEmployeeStatus(
  employee: Pick<EmployeeOption, "isActive" | "inviteAcceptedAt">,
): EmployeeStatus {
  if (!employee.inviteAcceptedAt) {
    return { label: i18next.t("admin:employeesList.statusPending"), variant: "pending" };
  }
  if (employee.isActive === false) {
    return { label: i18next.t("admin:employeesList.statusInactive"), variant: "inactive" };
  }
  return { label: i18next.t("admin:employeesList.statusActive"), variant: "active" };
}
