import type { WorkAction } from "@/services/offline/workJournal.core";

type Stage = "persisted" | "sync begin" | "RPC begin" | "RPC acknowledged" |
  "receipt applied" | "targeted refresh" | "full refresh completed";

const enabled = typeof __DEV__ !== "undefined" && __DEV__ ||
  process.env.EXPO_PUBLIC_SUPABASE_URL?.includes("legzogskvcmicdgowyax") === true;
const starts = new Map<string, { action: WorkAction; tapAt: number }>();

/** Development/Staging timing only; IDs are abbreviated and payloads are never logged. */
export function beginWorkTiming(operationId: string, action: WorkAction, tapAt?: number): void {
  if (!enabled) return;
  starts.set(operationId, { action, tapAt: tapAt ?? Date.now() });
  console.log(`[WorkTiming] ${action} ${operationId.slice(-8)} tap +0ms`);
  markWorkTiming(operationId, "persisted");
}

export function markWorkTiming(operationId: string, stage: Stage): void {
  if (!enabled) return;
  const start = starts.get(operationId);
  if (!start) return;
  console.log(`[WorkTiming] ${start.action} ${operationId.slice(-8)} ${stage} +${Date.now() - start.tapAt}ms`);
  if (stage === "full refresh completed") starts.delete(operationId);
}
