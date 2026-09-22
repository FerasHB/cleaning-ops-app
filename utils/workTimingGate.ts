import type { BackendEnvironmentLabel } from "./backendEnvironment";

/** Diagnostics never appear in a Production build. */
export function shouldEnableWorkTiming(
  isDev: boolean,
  backend: BackendEnvironmentLabel,
  appName: string | null | undefined,
): boolean {
  return isDev || backend === "STAGING" && appName === "TaskOps Manager Dev";
}
