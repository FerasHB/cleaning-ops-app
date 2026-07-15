// utils/bootstrapDiag.ts
// TEMP Diagnose (offline-debug-3) — sichtbarer Bootstrap-Zustand für den
// Offline-Kaltstart. Ein modul-globaler, beobachtbarer Store, den AuthContext
// und JobContext an den entscheidenden Stellen beschreiben und den die
// LoadingScreen SICHTBAR rendert (Console-Logs sind im Preview-Build unsichtbar).
// Enthält bewusst KEINE Tokens/Session-Inhalte. Nach der Diagnose komplett
// entfernbar (diese Datei + die setDiag-Aufrufe + der Debug-Block in LoadingScreen).

import { useSyncExternalStore } from "react";

export const BUILD_MARKER = "offline-debug-4";

export type BootstrapDiag = {
  authLoading: boolean;
  hasProfile: boolean;
  role: string;
  hasCompany: boolean;
  indexRedirectTarget: string;
  jobsLoading: boolean;
  jobsCount: number;
  employeesCount: number;
  online: boolean | null;
  cacheLoadStarted: boolean;
  cacheLoadFinished: boolean;
  loadingFalseCalled: boolean;
  remoteRefreshStarted: boolean;
  lastBootstrapStep: string;
  lastErrorName: string;
  lastErrorMessage: string;
};

let diag: BootstrapDiag = {
  authLoading: true,
  hasProfile: false,
  role: "(none)",
  hasCompany: false,
  indexRedirectTarget: "(none)",
  jobsLoading: true,
  jobsCount: 0,
  employeesCount: 0,
  online: null,
  cacheLoadStarted: false,
  cacheLoadFinished: false,
  loadingFalseCalled: false,
  remoteRefreshStarted: false,
  lastBootstrapStep: "init",
  lastErrorName: "",
  lastErrorMessage: "",
};

const listeners = new Set<() => void>();

export function setDiag(patch: Partial<BootstrapDiag>): void {
  diag = { ...diag, ...patch };
  listeners.forEach((l) => l());
}

export function getDiag(): BootstrapDiag {
  return diag;
}

export function noteDiagError(step: string, err: unknown): void {
  setDiag({
    lastBootstrapStep: step,
    lastErrorName: err instanceof Error ? err.name : typeof err,
    lastErrorMessage:
      err instanceof Error ? err.message : String(err ?? ""),
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useBootstrapDiag(): BootstrapDiag {
  return useSyncExternalStore(subscribe, getDiag, getDiag);
}
