import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { canReloadStagingUpdate, shouldEnableWorkTiming } from "../utils/workTimingGate.ts";

const react = {
  Fragment: "Fragment",
  createElement: (type, props, ...children) => ({ type, props: { ...props,
    children: children.length === 1 ? children[0] : children } }),
  useMemo: (fn) => fn(), useCallback: (fn) => fn, useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
};
const theme = new Proxy({ isDark: true }, { get: (object, key) => object[key] ??
  new Proxy({}, { get: () => 8 }) });
const namedComponents = new Proxy({}, { get: (_, key) => String(key) });
const common = {
  "react": react,
  "react-native": { StyleSheet: { create: (value) => value }, View: "View", Text: "Text",
    ScrollView: "ScrollView", StatusBar: "StatusBar", KeyboardAvoidingView: "KeyboardAvoidingView",
    Platform: { OS: "android" }, Linking: { openURL: async () => {} }, Pressable: "Pressable" },
  "react-native-safe-area-context": { SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  "react-i18next": { useTranslation: () => ({ t: (key) => key, i18n: { language: "de" } }) },
  "@/hooks/useAppTheme": { useAppTheme: () => theme },
  "@/utils/workTiming": { markVisibleWorkTiming: () => {}, markFooterWorkTiming: () => {} },
  "@/components/ui": { ...namedComponents, Button: "Button" },
  "@expo/vector-icons": { Ionicons: "Ionicons" },
};
function load(relativePath, imports) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (name) => {
    if (name in imports) return imports[name];
    if (name.startsWith("@/features/")) return namedComponents;
    throw Error(`Unexpected import ${name}`);
  }, Date, Math, String, Set, __DEV__: false,
  process: { env: { EXPO_PUBLIC_SUPABASE_URL: "https://staging.example" } } },
  { filename: relativePath });
  return exports;
}

// Exercise the real authorization helper as well as the real Job Detail and footer.
const assignees = load("../utils/jobAssignees.ts", {
  "@/utils/jobSchedule": { isPausedRecurringOccurrence: () => false },
  "@/i18n": { i18next: { t: (key) => key } },
});
common["@/utils/jobAssignees"] = assignees;
const ui = load("../utils/assignmentWorkUi.ts", common);
const footer = load("../features/jobs/components/JobActionFooter.tsx", common);
let badgeBackend = "STAGING";
const badge = load("../components/ui/BackendEnvironmentBadge.tsx", {
  ...common,
  "@/context/JobContext": { useJobs: () => ({ workOperations: [], pendingActions: [], isSyncing: false }) },
  "@/utils/backendEnvironment": {
    deriveBackendEnvironmentLabel: () => badgeBackend,
    shouldShowBackendEnvironmentIndicator: (label) => label !== "PROD",
  },
  "@/utils/workTimingGate": { shouldEnableWorkTiming, canReloadStagingUpdate },
  "@/utils/workTiming": { getWorkTimingTrace: () => "", getWorkUiDiagnostic: () => null,
    subscribeWorkTiming: () => () => {} },
  "expo-application": { nativeApplicationVersion: "1.0.0", nativeBuildVersion: "1" },
  "expo-constants": { __esModule: true, default: { expoConfig: { name: "TaskOps Manager Dev" } } },
  "expo-updates": { updateId: "update-a", runtimeVersion: "runtime-a", channel: "staging",
    isEmbeddedLaunch: false, checkForUpdateAsync: async () => ({ isAvailable: false }),
    fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: false }),
    reloadAsync: async () => {} },
});
let fixture;
const screen = load("../features/jobs/JobDetailScreen.tsx", {
  ...common,
  "@/utils/assignmentWorkUi": { ...ui, hasActiveAssignmentSession: () => false },
  "@/hooks/useSessionWorkedTime": { useSessionWorkedTime: () => "0:00" },
  "@/context/AuthContext": { useAuth: () => fixture.auth },
  "@/context/JobContext": { useJobs: () => fixture.jobs },
  "@/features/jobs/RecurringRuleDetailScreen": { __esModule: true, default: "RecurringRuleDetailScreen" },
  "@/features/jobs/components/JobActionFooter": footer,
  "@/services/jobs/jobs.service": { getJobById: async () => null },
  "@/utils/jobSchedule": { getStartBlockMessage: () => null },
  "@/utils/jobDialogs": { confirmCompleteJob: async () => true, confirmCompleteWhilePaused: async () => true },
  "@react-navigation/native": { useFocusEffect: () => {} },
  "expo-router": { router: {}, useLocalSearchParams: () => ({ id: "job-a" }) },
  "@/utils/userMessages": { toUserMessage: () => "error" },
  "@/i18n": { INTL_LOCALE_TAGS: { de: "de-DE" } },
});

function find(tree, type) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) return tree.map((item) => find(item, type)).find(Boolean) ?? null;
  if (tree.type === type) return tree;
  return find(tree.props?.children, type);
}
function buttons(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(buttons);
  return [...(tree.type === "Button" ? [tree.props.label] : []), ...buttons(tree.props?.children)];
}
const operation = (action, revision, sessionId, status = "pending") => ({
  operationId: `op-${action}`, action, userId: "u1", jobId: "job-a", assignmentId: "assignment-a",
  status, expectedRevision: revision, sessionId, localSequence: revision + 1,
});
const summary = (state, revision, sessionId) => ({ assignmentId: "assignment-a",
  trackingMode: "sessions", workRevision: revision, assignmentState: state,
  activeSessionId: sessionId, activeSince: state === "active" ? "2026-09-21T08:00:00Z" : null,
  latestSessionEnd: null, closedSeconds: 0, reviewRequired: false, employeeCompletedAt: null });

function render(state, revision, sessionId, operations, options = {}) {
  const job = { id: "job-a", companyId: "c", customerName: "Test Offline", service: "Work",
    status: "open", jobType: "single", isActive: true, parentJobId: null, employeeId: "u1",
    assignees: [{ assignmentId: "assignment-a", employeeId: "u1", trackingMode: "legacy",
      employeeStartedAt: null, employeeCompletedAt: null, workRevision: 0 }] };
  fixture = {
    auth: { role: "employee", profile: { id: "u1" }, pauseResumeEnabled: options.capability ?? true,
      forceCompleteEnabled: false },
    jobs: { jobs: [job], workOperations: operations, workSummaries: { "assignment-a": summary(state, revision, sessionId) },
      recordedWorkSummaries: {}, online: options.online ?? false, pendingActions: [], loading: false,
      markJobCommentsAsRead: () => {}, refreshJobs: async () => {}, refreshAssignmentWork: async () => {} },
  };
  const screenTree = screen.default();
  const footerNode = find(screenTree, footer.JobActionFooter);
  assert.ok(footerNode, "Job Detail must render its real action footer");
  const footerTree = footer.JobActionFooter(footerNode.props);
  return { props: footerNode.props, labels: buttons(footerTree) };
}

test("actual Job Detail renders Pause after offline pending Start", () => {
  const view = render("active", 1, "session-a", [operation("start", 0, "session-a")]);
  assert.equal(view.props.canPause, true);
  assert.equal(view.props.pendingAction, "start");
  assert.ok(view.labels.includes("jobs:work.pause"));
  assert.ok(view.labels.includes("jobs:activeJob.completeButton"));
});
test("actual Job Detail renders Resume and Complete after pending Pause", () => {
  const view = render("paused", 2, null, [operation("pause", 1, "session-a")]);
  assert.ok(view.labels.includes("jobs:work.resume"));
  assert.ok(view.labels.includes("jobs:activeJob.completeButton"));
  assert.equal(view.labels.includes("jobs:work.pause"), false);
});
test("actual Job Detail renders Pause and Complete after pending Resume", () => {
  const view = render("active", 3, "session-b", [operation("resume", 2, "session-b")]);
  assert.ok(view.labels.includes("jobs:work.pause"));
  assert.ok(view.labels.includes("jobs:activeJob.completeButton"));
});
test("reconciliation hides unsafe actions in actual footer", () => {
  const view = render("active", 1, "session-a", [operation("start", 0, "session-a"),
    operation("pause", 1, "session-a", "rejected_permanent")]);
  assert.equal(view.props.canPause, false);
  assert.equal(view.labels.includes("jobs:work.pause"), false);
});
test("online session controls still render without pending work", () => {
  const view = render("active", 1, "session-a", [], { online: true });
  assert.ok(view.labels.includes("jobs:work.pause"));
  assert.ok(view.labels.includes("jobs:activeJob.completeButton"));
});
test("Production builds exclude work timing diagnostics", () => {
  assert.equal(shouldEnableWorkTiming(false, "PROD", "TaskOps Manager"), false);
  assert.equal(shouldEnableWorkTiming(false, "STAGING", "TaskOps Manager"), true);
  assert.equal(shouldEnableWorkTiming(false, "STAGING", "TaskOps Manager Dev"), true);
  assert.equal(shouldEnableWorkTiming(true, "PROD", "TaskOps Manager"), false);
  badgeBackend = "STAGING";
  const stagingBadge = badge.BackendEnvironmentBadge();
  const stagingPressable = find(stagingBadge, "Pressable");
  assert.equal(typeof stagingPressable?.props.onPress, "function");
  assert.equal(stagingPressable?.props.onLongPress, undefined);
  badgeBackend = "PROD";
  assert.equal(badge.BackendEnvironmentBadge(), null);
});
test("downloaded update reload stays blocked until local work is synchronized", () => {
  assert.equal(canReloadStagingUpdate({ workOperationCount: 1,
    pendingActionCount: 0, isSyncing: false }), false);
  assert.equal(canReloadStagingUpdate({ workOperationCount: 0,
    pendingActionCount: 1, isSyncing: false }), false);
  assert.equal(canReloadStagingUpdate({ workOperationCount: 0,
    pendingActionCount: 0, isSyncing: true }), false);
  assert.equal(canReloadStagingUpdate({ workOperationCount: 0,
    pendingActionCount: 0, isSyncing: false }), true);
});
