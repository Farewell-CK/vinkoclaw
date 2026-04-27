/**
 * Workspace Memory: Cross-session persistence for user preferences and key decisions.
 *
 * This module provides a lightweight memory layer that survives across conversation sessions.
 * Unlike session metadata (which resets per conversation), workspace memory accumulates
 * long-term context about the user's preferences, project goals, and engineering decisions.
 */

export interface WorkspaceProjectRecord {
  id: string;
  name: string;
  stage: string;
  status: "active" | "archived";
  lastUpdate: string;
  latestSummary?: string | undefined;
  lastTaskId?: string | undefined;
}

export interface WorkspaceMemoryFactRecord {
  id: string;
  kind:
    | "business_domain"
    | "target_user"
    | "deliverable_preference"
    | "decision_style"
    | "feedback"
    | "project_context"
    | "tech_stack";
  value: string;
  source: "task" | "session" | "feishu" | "control-center" | "system" | "manual";
  confidence: number;
  taskId?: string | undefined;
  sessionId?: string | undefined;
  note?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMemoryRecord {
  userPreferences: {
    preferredLanguage: "zh" | "en" | "default";
    preferredTechStack: string[];
    communicationStyle: "concise" | "detailed" | "default";
  };
  founderProfile: {
    businessDomains: string[];
    targetUsers: string[];
    deliverablePreferences: string[];
    decisionStyle: "action_first" | "evidence_first" | "balanced";
    feedbackSignals: Array<{
      signal: "positive" | "negative" | "revision_requested";
      note: string;
      taskId?: string | undefined;
      createdAt: string;
    }>;
  };
  keyDecisions: Array<{
    decision: string;
    rationale: string;
    timestamp: string;
    category?: string;
  }>;
  projectContext: {
    currentGoals: string[];
    activeProjects: WorkspaceProjectRecord[];
    founderProfile?: WorkspaceMemoryRecord["founderProfile"] | undefined;
  };
  memoryFacts?: WorkspaceMemoryFactRecord[] | undefined;
  updatedAt: string;
}

type PersistedProjectContext = WorkspaceMemoryRecord["projectContext"] & {
  founderProfile?: unknown;
  memoryFacts?: unknown;
};

function createEmptyRecord(): WorkspaceMemoryRecord {
  return {
    userPreferences: {
      preferredLanguage: "default",
      preferredTechStack: [],
      communicationStyle: "default"
    },
    founderProfile: {
      businessDomains: [],
      targetUsers: [],
      deliverablePreferences: [],
      decisionStyle: "balanced",
      feedbackSignals: []
    },
    keyDecisions: [],
    projectContext: {
      currentGoals: [],
      activeProjects: []
    },
    memoryFacts: [],
    updatedAt: new Date().toISOString()
  };
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeStringList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function normalizeConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, parsed));
}

function normalizeMemoryFactKind(value: unknown): WorkspaceMemoryFactRecord["kind"] | undefined {
  return value === "business_domain" ||
    value === "target_user" ||
    value === "deliverable_preference" ||
    value === "decision_style" ||
    value === "feedback" ||
    value === "project_context" ||
    value === "tech_stack"
    ? value
    : undefined;
}

function normalizeMemoryFactSource(value: unknown): WorkspaceMemoryFactRecord["source"] {
  return value === "task" ||
    value === "session" ||
    value === "feishu" ||
    value === "control-center" ||
    value === "system" ||
    value === "manual"
    ? value
    : "system";
}

function createMemoryFactId(kind: string, value: string, taskId?: unknown, sessionId?: unknown): string {
  const sourceId =
    typeof taskId === "string" && taskId.trim()
      ? taskId.trim()
      : typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : "workspace";
  const slug = `${kind}:${value}:${sourceId}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `memory_fact_${slug || Date.now().toString(36)}`;
}

function normalizeMemoryFacts(value: unknown, limit = 200): WorkspaceMemoryFactRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const facts: WorkspaceMemoryFactRecord[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const kind = normalizeMemoryFactKind(record.kind);
    const rawValue = typeof record.value === "string" ? record.value.trim() : "";
    if (!kind || !rawValue) {
      continue;
    }
    const createdAt =
      typeof record.createdAt === "string" && record.createdAt.trim()
        ? record.createdAt.trim()
        : new Date().toISOString();
    const updatedAt =
      typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt.trim() : createdAt;
    facts.push({
      id:
        typeof record.id === "string" && record.id.trim()
          ? record.id.trim()
          : createMemoryFactId(kind, rawValue, record.taskId, record.sessionId),
      kind,
      value: rawValue,
      source: normalizeMemoryFactSource(record.source),
      confidence: normalizeConfidence(record.confidence),
      taskId: typeof record.taskId === "string" && record.taskId.trim() ? record.taskId.trim() : undefined,
      sessionId: typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId.trim() : undefined,
      note: typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined,
      createdAt,
      updatedAt
    });
  }
  return facts.slice(-limit);
}

function normalizeDecisionStyle(value: unknown): WorkspaceMemoryRecord["founderProfile"]["decisionStyle"] {
  return value === "action_first" || value === "evidence_first" || value === "balanced" ? value : "balanced";
}

function normalizeFounderProfile(value: unknown): WorkspaceMemoryRecord["founderProfile"] {
  const empty = createEmptyRecord().founderProfile;
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const profileSource =
    typeof source.founderProfile === "object" && source.founderProfile !== null
      ? (source.founderProfile as Record<string, unknown>)
      : source;
  const rawSignals = Array.isArray(profileSource.feedbackSignals) ? profileSource.feedbackSignals : [];
  const feedbackSignals: WorkspaceMemoryRecord["founderProfile"]["feedbackSignals"] = [];
  for (const item of rawSignals) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const signal =
      record.signal === "positive" || record.signal === "negative" || record.signal === "revision_requested"
        ? record.signal
        : undefined;
    const note = typeof record.note === "string" ? record.note.trim() : "";
    if (!signal || !note) {
      continue;
    }
    const createdAt =
      typeof record.createdAt === "string" && record.createdAt.trim()
        ? record.createdAt.trim()
        : new Date().toISOString();
    const taskId = typeof record.taskId === "string" && record.taskId.trim() ? record.taskId.trim() : undefined;
    feedbackSignals.push({
      signal,
      note,
      ...(taskId ? { taskId } : {}),
      createdAt
    });
  }
  const latestFeedbackSignals = feedbackSignals.slice(-20);
  return {
    businessDomains: normalizeStringList(profileSource.businessDomains),
    targetUsers: normalizeStringList(profileSource.targetUsers),
    deliverablePreferences: normalizeStringList(profileSource.deliverablePreferences),
    decisionStyle: normalizeDecisionStyle(profileSource.decisionStyle ?? empty.decisionStyle),
    feedbackSignals: latestFeedbackSignals
  };
}

function normalizeProjectContext(value: unknown, founderProfile: WorkspaceMemoryRecord["founderProfile"]): WorkspaceMemoryRecord["projectContext"] {
  const empty = createEmptyRecord().projectContext;
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    currentGoals: normalizeStringList(source.currentGoals),
    activeProjects: Array.isArray(source.activeProjects) ? (source.activeProjects as WorkspaceProjectRecord[]) : empty.activeProjects,
    founderProfile
  };
}

/**
 * Lightweight workspace memory manager using SQLite storage.
 */
export class WorkspaceMemoryManager {
  private db: import("node:sqlite").DatabaseSync;

  constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_memory (
        id TEXT PRIMARY KEY CHECK (id = 'singleton'),
        user_preferences_json TEXT NOT NULL,
        key_decisions_json TEXT NOT NULL,
        project_context_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  get(): WorkspaceMemoryRecord {
    const row = this.db
      .prepare("SELECT * FROM workspace_memory WHERE id = 'singleton'")
      .get() as
      | {
          user_preferences_json: string;
          key_decisions_json: string;
          project_context_json: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return createEmptyRecord();
    }

    const projectContextJson = safeParse(row.project_context_json, createEmptyRecord().projectContext);
    return {
      userPreferences: safeParse(row.user_preferences_json, createEmptyRecord().userPreferences),
      founderProfile: normalizeFounderProfile(projectContextJson),
      keyDecisions: safeParse(row.key_decisions_json, [] as Array<{ decision: string; rationale: string; timestamp: string; category?: string }>),
      projectContext: normalizeProjectContext(
        projectContextJson,
        normalizeFounderProfile(projectContextJson)
      ),
      memoryFacts: normalizeMemoryFacts((projectContextJson as PersistedProjectContext).memoryFacts),
      updatedAt: row.updated_at
    };
  }

  patch(patch: {
    userPreferences?: Partial<WorkspaceMemoryRecord["userPreferences"]>;
    founderProfile?: Partial<WorkspaceMemoryRecord["founderProfile"]>;
    keyDecisions?: WorkspaceMemoryRecord["keyDecisions"];
    projectContext?: Partial<WorkspaceMemoryRecord["projectContext"]>;
    memoryFacts?: WorkspaceMemoryFactRecord[] | undefined;
    updatedAt?: string;
  }): WorkspaceMemoryRecord {
    const current = this.get();
    const timestamp = new Date().toISOString();

    const merged: WorkspaceMemoryRecord = {
      userPreferences: {
        ...current.userPreferences,
        ...(patch.userPreferences ?? {})
      },
      founderProfile: normalizeFounderProfile({
        ...current.founderProfile,
        ...(patch.founderProfile ?? {})
      }),
      keyDecisions: patch.keyDecisions
        ? [...current.keyDecisions, ...patch.keyDecisions]
        : current.keyDecisions,
      projectContext: patch.projectContext
        ? {
            currentGoals: patch.projectContext.currentGoals ?? current.projectContext.currentGoals,
            activeProjects: patch.projectContext.activeProjects ?? current.projectContext.activeProjects,
            founderProfile: patch.founderProfile
              ? normalizeFounderProfile({
                  ...current.founderProfile,
                  ...patch.founderProfile
                })
              : current.founderProfile
          }
        : {
            ...current.projectContext,
            founderProfile: normalizeFounderProfile({
              ...current.founderProfile,
              ...(patch.founderProfile ?? {})
            })
          },
      memoryFacts: patch.memoryFacts ? normalizeMemoryFacts(patch.memoryFacts) : (current.memoryFacts ?? []),
      updatedAt: timestamp
    };

    this.db
      .prepare(`
        INSERT INTO workspace_memory (id, user_preferences_json, key_decisions_json, project_context_json, updated_at)
        VALUES ('singleton', ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          user_preferences_json = excluded.user_preferences_json,
          key_decisions_json = excluded.key_decisions_json,
          project_context_json = excluded.project_context_json,
          updated_at = excluded.updated_at
      `)
      .run(
        JSON.stringify(merged.userPreferences),
        JSON.stringify(merged.keyDecisions),
        JSON.stringify({ ...merged.projectContext, memoryFacts: merged.memoryFacts } satisfies PersistedProjectContext),
        timestamp
      );

    return merged;
  }

  patchFounderProfile(patch: Partial<WorkspaceMemoryRecord["founderProfile"]>): void {
    this.patch({ founderProfile: patch });
  }

  recordMemoryFact(
    fact: Omit<WorkspaceMemoryFactRecord, "id" | "createdAt" | "updatedAt"> &
      Partial<Pick<WorkspaceMemoryFactRecord, "id" | "createdAt" | "updatedAt">>
  ): WorkspaceMemoryRecord {
    const timestamp = new Date().toISOString();
    const normalized = normalizeMemoryFacts([
      {
        ...fact,
        id: fact.id ?? createMemoryFactId(fact.kind, fact.value, fact.taskId, fact.sessionId),
        createdAt: fact.createdAt ?? timestamp,
        updatedAt: fact.updatedAt ?? timestamp
      }
    ])[0];
    if (!normalized) {
      return this.get();
    }
    const current = this.get();
    const existingFacts = current.memoryFacts ?? [];
    const existingIndex = existingFacts.findIndex((item) => item.id === normalized.id);
    const nextFacts = [...existingFacts];
    if (existingIndex >= 0) {
      nextFacts[existingIndex] = {
        ...nextFacts[existingIndex]!,
        ...normalized,
        createdAt: nextFacts[existingIndex]!.createdAt,
        updatedAt: timestamp
      };
    } else {
      nextFacts.push(normalized);
    }
    return this.patch({ memoryFacts: nextFacts.slice(-200) });
  }

  deleteMemoryFact(id: string): WorkspaceMemoryRecord {
    const current = this.get();
    return this.patch({ memoryFacts: (current.memoryFacts ?? []).filter((fact) => fact.id !== id) });
  }

  resetMemoryFacts(): WorkspaceMemoryRecord {
    return this.patch({ memoryFacts: [] });
  }

  /**
   * Record a key decision with timestamp and rationale.
   */
  addDecision(decision: string, rationale: string, category?: string): void {
    this.patch({
      keyDecisions: [
        {
          decision,
          rationale,
          timestamp: new Date().toISOString(),
          ...(category ? { category } : {})
        }
      ]
    });
  }

  /**
   * Update user preferences.
   */
  setPreferences(prefs: Partial<WorkspaceMemoryRecord["userPreferences"]>): void {
    const current = this.get();
    this.patch({
      userPreferences: {
        ...current.userPreferences,
        ...prefs
      }
    });
  }

  /**
   * Add or update an active project.
   */
  updateProject(
    name: string,
    stage: string,
    patch?: Partial<Omit<WorkspaceProjectRecord, "id" | "name" | "stage" | "lastUpdate">>
  ): void {
    const current = this.get();
    const existingIndex = current.projectContext.activeProjects.findIndex((p) => p.name === name);
    const existing = existingIndex >= 0 ? current.projectContext.activeProjects[existingIndex] : undefined;
    const newProject: WorkspaceProjectRecord = {
      id: existing?.id ?? `project:${name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")}`,
      name,
      stage,
      status: patch?.status ?? existing?.status ?? "active",
      lastUpdate: new Date().toISOString(),
      latestSummary: patch?.latestSummary ?? existing?.latestSummary,
      lastTaskId: patch?.lastTaskId ?? existing?.lastTaskId
    };

    if (existingIndex >= 0) {
      const updated = [...current.projectContext.activeProjects];
      updated[existingIndex] = newProject;
      this.patch({
        projectContext: { ...current.projectContext, activeProjects: updated }
      });
    } else {
      this.patch({
        projectContext: {
          ...current.projectContext,
          activeProjects: [...current.projectContext.activeProjects, newProject]
        }
      });
    }
  }

  archiveProject(name: string, latestSummary?: string): void {
    const current = this.get();
    const existing = current.projectContext.activeProjects.find((project) => project.name === name);
    this.updateProject(name, existing?.stage ?? "archived", {
      status: "archived",
      latestSummary: latestSummary ?? existing?.latestSummary,
      lastTaskId: existing?.lastTaskId
    });
  }
}
