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

export interface WorkspaceMemoryRecord {
  userPreferences: {
    preferredLanguage: "zh" | "en" | "default";
    preferredTechStack: string[];
    communicationStyle: "concise" | "detailed" | "default";
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
  };
  updatedAt: string;
}

function createEmptyRecord(): WorkspaceMemoryRecord {
  return {
    userPreferences: {
      preferredLanguage: "default",
      preferredTechStack: [],
      communicationStyle: "default"
    },
    keyDecisions: [],
    projectContext: {
      currentGoals: [],
      activeProjects: []
    },
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

    return {
      userPreferences: safeParse(row.user_preferences_json, createEmptyRecord().userPreferences),
      keyDecisions: safeParse(row.key_decisions_json, [] as Array<{ decision: string; rationale: string; timestamp: string; category?: string }>),
      projectContext: safeParse(row.project_context_json, createEmptyRecord().projectContext),
      updatedAt: row.updated_at
    };
  }

  patch(patch: {
    userPreferences?: Partial<WorkspaceMemoryRecord["userPreferences"]>;
    keyDecisions?: WorkspaceMemoryRecord["keyDecisions"];
    projectContext?: Partial<WorkspaceMemoryRecord["projectContext"]>;
    updatedAt?: string;
  }): WorkspaceMemoryRecord {
    const current = this.get();
    const timestamp = new Date().toISOString();

    const merged: WorkspaceMemoryRecord = {
      userPreferences: {
        ...current.userPreferences,
        ...(patch.userPreferences ?? {})
      },
      keyDecisions: patch.keyDecisions
        ? [...current.keyDecisions, ...patch.keyDecisions]
        : current.keyDecisions,
      projectContext: patch.projectContext
        ? {
            currentGoals: patch.projectContext.currentGoals ?? current.projectContext.currentGoals,
            activeProjects: patch.projectContext.activeProjects ?? current.projectContext.activeProjects
          }
        : current.projectContext,
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
        JSON.stringify(merged.projectContext),
        timestamp
      );

    return merged;
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
