import EmployeeJobsCalendarScreen from "@/features/jobs/EmployeeJobsCalendarScreen";

// Employee-Kalender-Tab: Vollbild-Monatskalender (Planungsansicht).
// Bis PR #83 lief das unter dem Jobs-Tab; seit dem Smart-Jobs-Tab ist die
// Kalenderansicht ein eigener Tab. Screen selbst unverändert.
export default function EmployeeKalenderTab() {
  return <EmployeeJobsCalendarScreen />;
}
