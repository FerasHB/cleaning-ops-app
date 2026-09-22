import type { BackendEnvironmentLabel } from "./backendEnvironment";

/** Diagnostics never appear in a Production build. */
export function shouldEnableWorkTiming(
  _isDev: boolean,
  backend: BackendEnvironmentLabel,
  _appName: string | null | undefined,
): boolean {
  return backend === "STAGING";
}

export function canReloadStagingUpdate(input: {
  workOperationCount: number;
  pendingActionCount: number;
  isSyncing: boolean;
}): boolean {
  return input.workOperationCount === 0 && input.pendingActionCount === 0 && !input.isSyncing;
}
