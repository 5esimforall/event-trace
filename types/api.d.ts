export type EventKind = "document" | "notification" | "interception" | "error";

export type EventDiffOp = "set" | "add" | "remove";

export interface EventDiffEntry {
  path: string;
  op: EventDiffOp;
  before: unknown;
  after: unknown;
  truncated?: boolean;
}

export type EventAttributionSourceType = "module" | "system" | "core" | "user" | "unknown";

export type EventAttributionConfidence = "exact" | "inferred" | "unknown";

export interface EventAttribution {
  sourceType: EventAttributionSourceType;
  packageId: string | null;
  label: string;
  hookName?: string;
  fnName?: string;
  confidence: EventAttributionConfidence;
}

export interface TraceFilter {
  kind?: EventKind;
  uuid?: string;
  messageId?: string;
  moduleId?: string;
  query?: string;
}

export type TargetRef =
  | { type: "document"; uuid: string }
  | { type: "message"; messageId: string }
  | { type: "module"; moduleId: string }
  | { type: "hook"; hookName: string }
  | { type: "actorField"; uuid: string; path?: string }
  | { type: "visibility"; uuid: string; userId?: string };

export interface TraceCombatSnapshot {
  combatId: string;
  round: number;
  turn: number;
  combatantName: string | null;
}

export interface TraceUserInfo {
  id: string;
  name: string;
  isSelf: boolean;
  remote: boolean;
}

export interface TraceEventRecord {
  id: string;
  seq: number;
  timestamp: number;
  kind: EventKind;
  actionId: string;
  groupingBasis: "standalone" | "sync-stack" | "time-window";
  combat: TraceCombatSnapshot | null;
  user: TraceUserInfo;
  attribution: EventAttribution;
  target: TargetRef | null;
  summary: string;
  detail: Record<string, unknown>;
  repeat: { count: number; firstAt: number; lastAt: number } | null;
  concealed: boolean;
}

export interface TraceActionGroup {
  id: string;
  title: string;
  attribution: EventAttribution;
  events: TraceEventRecord[];
}

export interface TraceSummary {
  total: number;
  counts: Record<EventKind, number>;
  unreadErrors: number;
  unreadInterceptions: number;
  lastEventAt: number | null;
  capacity: number;
}

export interface TraceSnapshotOptions {
  filter?: TraceFilter;
  limit?: number;
  windowMs?: number;
}

export interface TraceSnapshotEnvelope {
  schemaVersion: 1;
  producer: "event-trace";
  moduleVersion: string;
  exportedAt: string;
  foundryVersion: string;
  systemId: string;
  worldId: string;
  userRole: string;
  data: {
    filter: TraceFilter;
    summary: TraceSummary;
    modules: Array<{ id: string; title: string; version: string }>;
    groups: TraceActionGroup[];
    events: TraceEventRecord[];
  };
}

export interface EventTraceApi {
  open(filter?: TraceFilter): Promise<unknown>;
  snapshot(options?: TraceSnapshotOptions): TraceSnapshotEnvelope;
  summary(): TraceSummary;
}
