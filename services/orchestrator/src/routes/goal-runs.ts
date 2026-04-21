import express from "express";
import type { GoalRunStage, GoalRunStatus, TaskSource, VinkoStore } from "@vinko/shared";
import { enrichGoalRunRecord, enrichGoalRunRecordWithHarnessEvidence, enrichTaskRecord } from "./response-utils.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGoalRunStatus(value: unknown): GoalRunStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "queued":
    case "running":
    case "awaiting_input":
    case "awaiting_authorization":
    case "completed":
    case "failed":
    case "cancelled":
      return normalized;
    default:
      return undefined;
  }
}

function parseGoalRunStatuses(value: unknown): GoalRunStatus[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const statuses = value
    .map((entry) => parseGoalRunStatus(entry))
    .filter((entry): entry is GoalRunStatus => Boolean(entry));
  return Array.from(new Set(statuses));
}

function parseTaskSource(value: unknown): TaskSource {
  if (typeof value !== "string") {
    return "control-center";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "feishu" || normalized === "email" || normalized === "system" || normalized === "control-center") {
    return normalized;
  }
  return "control-center";
}

function inferLanguage(text: string): string {
  return /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "en-US";
}

export interface GoalRunRoutesDeps {
  store: VinkoStore;
}

export function registerGoalRunRoutes(app: express.Express, deps: GoalRunRoutesDeps): void {
  const { store } = deps;

  app.get("/api/goal-runs", (request, response) => {
    const status = parseGoalRunStatus(request.query.status);
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 100;
    const goalRuns = store.listGoalRuns({
      limit,
      ...(status ? { status } : {})
    });
    response.json(goalRuns.map((run) => enrichGoalRunRecordWithHarnessEvidence(store, run)));
  });

  app.post("/api/goal-runs", (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (!objective) {
      response.status(400).json({ error: "objective_required" });
      return;
    }

    const source = parseTaskSource(body.source);
    const requestedBy = typeof body.requestedBy === "string" ? body.requestedBy.trim() : "";
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : inferLanguage(objective);
    const metadata = isRecord(body.metadata) ? body.metadata : {};
    const context = isRecord(body.context) ? body.context : {};
    const maxRetriesRaw = Number(body.maxRetries);

    const goalRun = store.createGoalRun({
      source,
      objective,
      ...(requestedBy ? { requestedBy } : {}),
      ...(chatId ? { chatId } : {}),
      ...(sessionId ? { sessionId } : {}),
      language,
      metadata,
      context,
      ...(Number.isFinite(maxRetriesRaw) ? { maxRetries: Math.round(maxRetriesRaw) } : {})
    });

    response.status(201).json({
      goalRun: enrichGoalRunRecordWithHarnessEvidence(store, goalRun),
      message: `GoalRun ${goalRun.id.slice(0, 8)} queued`
    });
  });

  app.get("/api/goal-runs/:goalRunId", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    const task = goalRun.currentTaskId ? store.getTask(goalRun.currentTaskId) : undefined;
    const traces = store.listGoalRunTraces(goalRun.id, 200);
    const latestHandoff = store.getLatestGoalRunHandoff(goalRun.id);
    const enriched = enrichGoalRunRecordWithHarnessEvidence(store, goalRun, {
      traceCount: traces.length
    });
    response.json({
      goalRun: enriched,
      task: task ? enrichTaskRecord(store, task) : undefined,
      inputs: store.listGoalRunInputs(goalRun.id),
      latestHandoff,
      authTokens: store.listRunAuthTokens(goalRun.id, 10).map((entry) => ({
        ...entry,
        token: `${entry.token.slice(0, 6)}...`
      }))
    });
  });

  app.get("/api/goal-runs/:goalRunId/timeline", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.round(limitRaw))) : 1000;
    response.json({
      goalRun: enrichGoalRunRecordWithHarnessEvidence(store, goalRun),
      timeline: store.listGoalRunTimelineEvents(goalRun.id, limit)
    });
  });

  app.get("/api/goal-runs/:goalRunId/trace", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.round(limitRaw))) : 200;
    const traces = store.listGoalRunTraces(goalRun.id, limit);
    response.json({
      goalRun: enrichGoalRunRecordWithHarnessEvidence(store, goalRun, {
        traceCount: traces.length
      }),
      traces
    });
  });

  app.get("/api/goal-runs/:goalRunId/handoff", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    const stage =
      typeof request.query.stage === "string" && request.query.stage.trim()
        ? (request.query.stage.trim() as GoalRunStage)
        : undefined;
    const latest = typeof request.query.latest === "string" ? request.query.latest === "1" || request.query.latest === "true" : true;
    if (latest) {
      const handoff = store.getLatestGoalRunHandoff(goalRun.id, stage);
      if (!handoff) {
        response.status(404).json({ error: "goal_run_handoff_not_found" });
        return;
      }
      response.json({
        goalRun: enrichGoalRunRecordWithHarnessEvidence(store, goalRun, {
          handoffStage: stage
        }),
        handoff
      });
      return;
    }
    const handoffs = store.listGoalRunHandoffArtifacts(goalRun.id, 200, stage);
    response.json({
      goalRun: enrichGoalRunRecordWithHarnessEvidence(store, goalRun, {
        handoffStage: stage
      }),
      handoffs
    });
  });

  app.post("/api/goal-runs/:goalRunId/input", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }

    const body = isRecord(request.body) ? request.body : {};
    const createdBy = typeof body.createdBy === "string" ? body.createdBy.trim() : "";
    const entries: Array<[string, unknown]> = [];
    if (isRecord(body.inputs)) {
      for (const [key, value] of Object.entries(body.inputs)) {
        const normalizedKey = key.trim();
        if (normalizedKey) {
          entries.push([normalizedKey, value]);
        }
      }
    }
    if (entries.length === 0) {
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (key) {
        entries.push([key, body.value]);
      }
    }

    if (entries.length === 0) {
      response.status(400).json({ error: "input_payload_required" });
      return;
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      store.upsertGoalRunInput({
        goalRunId: goalRun.id,
        inputKey: key,
        value,
        ...(createdBy ? { createdBy } : {})
      });
      patch[key] = value;
    }
    const merged = store.updateGoalRunContext(goalRun.id, patch) ?? goalRun;
    const resumed = merged.status === "awaiting_input" ? store.queueGoalRun(goalRun.id, merged.currentStage) ?? merged : merged;
    store.appendGoalRunTimelineEvent({
      goalRunId: goalRun.id,
      stage: resumed.currentStage,
      eventType: "input_received",
      message: `Received ${entries.length} input item(s)`,
      payload: {
        keys: entries.map(([key]) => key)
      }
    });
    response.json({
      goalRun: enrichGoalRunRecordWithHarnessEvidence(store, resumed),
      inputs: store.listGoalRunInputs(goalRun.id)
    });
  });

  app.post("/api/goal-runs/:goalRunId/authorize", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "deploy";
    const usedBy = typeof body.usedBy === "string" && body.usedBy.trim() ? body.usedBy.trim() : undefined;

    if (typeof body.token === "string" && body.token.trim()) {
      const consumed = store.consumeRunAuthToken({
        token: body.token.trim(),
        goalRunId: goalRun.id,
        scope,
        ...(usedBy ? { usedBy } : {})
      });
      if (!consumed) {
        response.status(400).json({ error: "invalid_or_expired_token" });
        return;
      }
      store.updateGoalRunContext(goalRun.id, {
        deploy_authorized_at: consumed.usedAt ?? new Date().toISOString(),
        deploy_authorized_scope: consumed.scope
      });
      const resumed =
        goalRun.status === "awaiting_authorization"
          ? store.queueGoalRun(goalRun.id, goalRun.currentStage) ?? goalRun
          : store.getGoalRun(goalRun.id) ?? goalRun;
      store.appendGoalRunTimelineEvent({
        goalRunId: goalRun.id,
        stage: resumed.currentStage,
        eventType: "authorization_granted",
        message: "Authorization granted",
        payload: {
          scope: consumed.scope,
          usedBy: consumed.usedBy ?? ""
        }
      });
      response.json({
        goalRun: enrichGoalRunRecordWithHarnessEvidence(store, resumed),
        authorization: {
          scope: consumed.scope,
          status: consumed.status,
          usedAt: consumed.usedAt
        }
      });
      return;
    }

    const ttlMsRaw = Number(body.ttlMs);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const token = store.createRunAuthToken({
      goalRunId: goalRun.id,
      scope,
      ...(Number.isFinite(ttlMsRaw) ? { ttlMs: Math.round(ttlMsRaw) } : {}),
      ...(reason ? { reason } : {})
    });
    const waiting = store.markGoalRunAwaitingAuthorization({
      goalRunId: goalRun.id,
      stage: goalRun.currentStage,
      reason: reason || undefined
    });
    store.appendGoalRunTimelineEvent({
      goalRunId: goalRun.id,
      stage: goalRun.currentStage,
      eventType: "authorization_required",
      message: "Authorization token issued",
      payload: {
        scope: token.scope,
        expiresAt: token.expiresAt
      }
    });
    response.json({
      goalRun: enrichGoalRunRecordWithHarnessEvidence(store, waiting ?? goalRun),
      authorization: token
    });
  });

  app.post("/api/goal-runs/:goalRunId/cancel", (request, response) => {
    const goalRun = store.getGoalRun(request.params.goalRunId);
    if (!goalRun) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const cancelled = store.cancelGoalRun(goalRun.id, reason || undefined);
    if (!cancelled) {
      response.status(404).json({ error: "goal_run_not_found" });
      return;
    }
    store.appendGoalRunTimelineEvent({
      goalRunId: cancelled.id,
      stage: cancelled.currentStage,
      eventType: "run_cancelled",
      message: reason || "Goal run cancelled",
      payload: {
        reason
      }
    });
    response.json({ goalRun: enrichGoalRunRecordWithHarnessEvidence(store, cancelled) });
  });

  app.post("/api/goal-runs/cancel-stale", (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const olderThanMinutesRaw = Number(body.olderThanMinutes ?? 180);
    const olderThanMinutes = Number.isFinite(olderThanMinutesRaw) ? Math.max(0, Math.round(olderThanMinutesRaw)) : 180;
    const limitRaw = Number(body.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.round(limitRaw))) : 200;
    const requestedByFilter = typeof body.requestedBy === "string" ? body.requestedBy.trim() : "";
    const sourceFilter = parseTaskSource(body.source);
    const hasSourceFilter = typeof body.source === "string" && body.source.trim().length > 0;
    const statusesInput = parseGoalRunStatuses(body.statuses);
    const statuses =
      statusesInput.length > 0 ? statusesInput : (["queued", "running", "awaiting_authorization"] as GoalRunStatus[]);
    const reasonPrefix =
      typeof body.reasonPrefix === "string" && body.reasonPrefix.trim().length > 0
        ? body.reasonPrefix.trim()
        : "stale goal-run cleanup";
    const dryRun = body.dryRun === true;

    const thresholdMs = Date.now() - olderThanMinutes * 60 * 1000;
    const runs = store.listGoalRuns({ limit: 500 });
    const candidates = runs
      .filter((run) => {
        if (!statuses.includes(run.status)) {
          return false;
        }
        if (requestedByFilter && run.requestedBy !== requestedByFilter) {
          return false;
        }
        if (hasSourceFilter && run.source !== sourceFilter) {
          return false;
        }
        const updatedMs = Date.parse(run.updatedAt);
        if (!Number.isFinite(updatedMs)) {
          return false;
        }
        return updatedMs <= thresholdMs;
      })
      .slice(0, limit);

    if (dryRun) {
      response.json({
        dryRun: true,
        scanned: runs.length,
        candidates: candidates.length,
        candidateGoalRunIds: candidates.map((run) => run.id),
        cancelledCount: 0,
        cancelledGoalRunIds: [],
        errors: []
      });
      return;
    }

    const cancelled: string[] = [];
    const errors: Array<{ goalRunId: string; error: string }> = [];
    for (const run of candidates) {
      const cancelledRun = store.cancelGoalRun(run.id, `${reasonPrefix}: ${olderThanMinutes}m`);
      if (!cancelledRun) {
        errors.push({
          goalRunId: run.id,
          error: "goal_run_cancel_failed"
        });
        continue;
      }
      store.appendGoalRunTimelineEvent({
        goalRunId: cancelledRun.id,
        stage: cancelledRun.currentStage,
        eventType: "run_cancelled",
        message: `${reasonPrefix}: ${olderThanMinutes}m`,
        payload: {
          reason: `${reasonPrefix}: ${olderThanMinutes}m`
        }
      });
      cancelled.push(cancelledRun.id);
    }

    response.json({
      dryRun: false,
      scanned: runs.length,
      candidates: candidates.length,
      cancelledCount: cancelled.length,
      cancelledGoalRunIds: cancelled,
      errors
    });
  });

  app.get("/api/credentials", (request, response) => {
    const providerId = typeof request.query.providerId === "string" ? request.query.providerId : undefined;
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.round(limitRaw))) : 500;
    response.json(
      store.listCredentials({
        ...(providerId ? { providerId } : {}),
        limit
      })
    );
  });

  app.post("/api/credentials", (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
    const credentialKey = typeof body.credentialKey === "string" ? body.credentialKey.trim() : "";
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!providerId || !credentialKey || !value) {
      response.status(400).json({ error: "providerId_credentialKey_value_required" });
      return;
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const createdBy = typeof body.createdBy === "string" ? body.createdBy.trim() : "";
    const metadata = isRecord(body.metadata) ? body.metadata : {};
    try {
      const credential = store.upsertCredential({
        providerId,
        credentialKey,
        value,
        ...(displayName ? { displayName } : {}),
        metadata,
        ...(createdBy ? { createdBy } : {})
      });
      response.status(201).json(credential);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/credentials/:providerId/:credentialKey", (request, response) => {
    const providerId = request.params.providerId;
    const credentialKey = request.params.credentialKey;
    const deleted = store.deleteCredential(providerId, credentialKey);
    if (!deleted) {
      response.status(404).json({ error: "credential_not_found" });
      return;
    }
    response.status(204).end();
  });
}
