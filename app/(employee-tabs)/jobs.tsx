import EmployeeSmartJobsScreen from "@/features/jobs/EmployeeSmartJobsScreen";

// Employee-Jobs-Tab: intelligente operative Warteschlange (Aktiv/Überfällig/
// Als Nächstes/Heute/Zukunft). Der Kalender lebt seit diesem PR im
// eigenständigen Tab "Kalender" (app/(employee-tabs)/kalender.tsx).
export default function EmployeeJobsTab() {
  return <EmployeeSmartJobsScreen />;
}
