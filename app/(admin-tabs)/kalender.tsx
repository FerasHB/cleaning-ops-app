import AdminJobsCalendarScreen from "@/features/jobs/AdminJobsCalendarScreen";

// Admin-Kalender-Tab: firmenweite Monatsübersicht (eigene Datenquelle,
// eigene Filter). Kein Zusammenhang mit der Mitarbeiter-Kalenderansicht
// (EmployeeJobsCalendarScreen) — siehe Kommentar im Screen selbst.
export default function AdminKalenderTab() {
  return <AdminJobsCalendarScreen />;
}
