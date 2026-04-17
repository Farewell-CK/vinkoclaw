declare module "../../../scripts/reset-runtime-state.mjs" {
  export function getDbSnapshot(dbPath: string): {
    busyTasks: number;
    awaitingInputTasks: number;
    busyGoalRuns: number;
    pendingApprovals: number;
  };

  export function listResettableTaskIds(dbPath: string): Array<{
    id: string;
    status: string;
  }>;
}
