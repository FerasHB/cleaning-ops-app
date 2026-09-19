import { useEffect, useState } from "react";
import type { WorkOperation, WorkSummary } from "@/services/offline/workJournal.core";
import { displayedWorkSeconds, formatWorkedSeconds } from "@/utils/assignmentWorkUi";

export function useSessionWorkedTime(summary?: WorkSummary | null, recorded?: WorkSummary | null,
  pending?: WorkOperation | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (summary?.assignmentState !== "active") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [summary?.assignmentState, summary?.activeSince]);
  return formatWorkedSeconds(displayedWorkSeconds({ summary, recorded, pending, now }));
}
