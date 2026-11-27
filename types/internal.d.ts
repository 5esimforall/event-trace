import type {
  EventAttribution,
  EventDiffEntry,
  EventKind,
  TargetRef,
  TraceActionGroup,
  TraceCombatSnapshot,
  TraceEventRecord,
  TraceFilter,
  TraceSummary,
  TraceUserInfo
} from "./api.d.ts";

export type DocumentAction = "create" | "update" | "delete";
export type NotificationLevel = "info" | "warning" | "error" | "success";
export type ErrorOrigin = "hooks" | "window-error" | "unhandledrejection";

export interface BeforeCacheResult {
  beforeMap: Map<string, unknown>;
  hasBeforeCache: boolean;
}

export interface DiffComputationResult {
  diffs: EventDiffEntry[];
  omittedDiffCount: number;
  beforeCached: boolean;
}

export interface VisibilityCheckResult {
  visible: boolean;
  concealContent: boolean;
  reason?: string;
}

export interface PendingBeforeEntry {
  beforeMap: Map<string, unknown>;
  attribution: EventAttribution | null;
  expiresAt: number;
  keys: string[];
}

export interface PendingPreOpEntry {
  documentName: string;
  action: DocumentAction;
  userId: string;
  attribution: EventAttribution | null;
  expiresAt: number;
  name?: string | null;
}

export interface SyncFrame {
  token: number;
  actionId: string | null;
  hookName: string | null;
  attribution: EventAttribution | null;
}

export interface TraceClock {
  clock: (ts: number) => string;
  clockSeconds: (ts: number) => string;
  full: (ts: number) => string;
  section: (ts: number) => string;
  day: (ts: number) => string;
  iso: (ts: number) => string;
}

export interface TraceTimelineSection {
  id: string;
  kind: "combat" | "time";
  timestamp: number;
  combat: TraceCombatSnapshot | null;
  dayChanged: boolean;
  gapMs: number;
  groups: TraceActionGroup[];
}

export interface InterceptionCallbackPayload {
  hookName: string;
  attribution: EventAttribution;
  args: unknown[];
  callbackRegisteredEarly: boolean;
  candidates?: EventAttribution[];
}

export interface TraceRecordInput {
  timestamp?: number;
  kind: EventKind;
  combat?: TraceCombatSnapshot | null;
  user?: TraceUserInfo;
  attribution?: EventAttribution;
  target?: TargetRef | null;
  summary: string;
  detail: Record<string, unknown>;
  concealed?: boolean;
}

export interface TraceStoreEnvironment {
  moduleVersion?: string;
  foundryVersion?: string;
  systemId?: string;
  worldId?: string;
  userRole?: string;
  modules?: Array<{ id: string; title: string; version: string }>;
}

export interface TraceWindowContext {
  store: import("../module/scripts/store.mjs").TraceStore;
  env?: TraceWindowEnvironment;
}

export interface TraceWindowEnvironment {
  localize: (key: string, data?: Record<string, unknown>) => string;
  lang: () => string;
  isGM: () => boolean;
  getSelectedTarget: () => { uuid: string; label?: string } | null;
  fromUuidSync: (uuid: string) => FoundryDocumentLike | null;
  locateToken: (uuid: string) => boolean;
  getPeer: (id: string) => FoundryModuleLike | null;
  focusNativeMessage: (messageId: string) => boolean;
  saveJsonFile: (data: string, filename: string) => boolean;
  worldId: () => string;
}

export interface FoundryDocumentLike {
  id?: string;
  uuid?: string;
  name?: string;
  documentName?: string;
  visible?: boolean;
  isOwner?: boolean;
  hidden?: boolean;
  isSecret?: boolean;
  isContentVisible?: boolean;
  isRoll?: boolean;
  key?: string;
  user?: string | { id?: string } | null;
  parent?: FoundryDocumentLike | null;
  actor?: FoundryDocumentLike | null;
  token?: FoundryDocumentLike | null;
  delta?: FoundryDocumentLike | null;
  syntheticActor?: FoundryDocumentLike | null;
  _source?: Record<string, unknown>;
  sheet?: { render: (force?: boolean) => unknown } | null;
  object?: { center?: { x: number; y: number }; control?: () => unknown } | null;
  rolls?: unknown[];
  content?: string;
  flavor?: string;
  whisper?: string[];
}

export interface FoundryModuleLike {
  id: string;
  title?: string;
  version?: string;
  active?: boolean;
  api?: Record<string, unknown> & {
    open?: (arg?: unknown) => unknown;
    focusMessage?: (messageId: string) => unknown;
    openDetails?: (messageId: string) => unknown;
    registerAction?: (config: unknown) => unknown;
  };
}

export type {
  EventAttribution,
  EventDiffEntry,
  EventKind,
  TargetRef,
  TraceActionGroup,
  TraceCombatSnapshot,
  TraceEventRecord,
  TraceFilter,
  TraceSummary,
  TraceUserInfo
};
