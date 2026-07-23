import AdminJobsScreen from "@/features/jobs/AdminJobsScreen";

// Admin-Jobs-Tab: Zeitplan (ausführbare Termine) + Daueraufträge (Regeln),
// klar getrennt über einen Segmented Control. Employees nutzen weiterhin die
// Kalender-Ansicht (EmployeeJobsCalendarScreen).
export default function AdminJobsTab() {
  return <AdminJobsScreen />;
}
