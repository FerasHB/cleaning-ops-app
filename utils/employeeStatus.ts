// utils/employeeStatus.ts
// Zentrale Ableitung des Anzeige-Status eines Mitarbeiters aus EmployeeOption —
// genutzt von der Mitarbeiter-Liste UND dem Detail-Screen, damit die
// Eingeladen/Aktiv/Inaktiv-Logik nicht doppelt gepflegt wird.

import type { EmployeeOption } from "@/types/job";

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
    return { label: "Eingeladen", variant: "pending" };
  }
  if (employee.isActive === false) {
    return { label: "Inaktiv", variant: "inactive" };
  }
  return { label: "Aktiv", variant: "active" };
}
