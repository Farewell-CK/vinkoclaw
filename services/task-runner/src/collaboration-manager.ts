import { FeishuClient } from "@vinko/feishu-gateway";
import { LocalModelClient } from "@vinko/agent-runtime";
import {
  AgentCollaborationService,
  ROLE_IDS,
  createLogger,
  type AgentCollaboration,
  type AgentInstance,
  type CollaborationConfig,
  type CreateAgentCollaborationInput,
  type ReflectionNote,
  type RoleId,
  type TaskRecord,
  type TaskResult,
  type VinkoStore
} from "@vinko/shared";

const logger = createLogger("collaboration-manager");
const COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS_RAW = Number(
  process.env.COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS ?? "12000"
);
const COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS = Number.isFinite(COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS_RAW)
  ? Math.max(1000, Math.round(COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS_RAW))
  : 12_000;
const collabFeishuLastIntermediatePushMs = new Map<string, number>();

const ROLE_LABELS: Record<RoleId, string> = {
  ceo: "CEO",
  cto: "CTO",
  product: "产品经理",
  uiux: "UI/UX",
  frontend: "前端",
  backend: "后端",
  algorithm: "算法",
  qa: "测试",
  developer: "开发",
  engineering: "工程",
  research: "研究",
  operations: "运营"
};
const KNOWN_ROLE_IDS = new Set<RoleId>(ROLE_IDS);
const LEADERSHIP_FACILITATORS = new Set<RoleId>(["ceo", "cto"]);

type LeaderAssignmentPlan = {
  participants: RoleId[];
  rationale: string;
  backendUsed: "sglang" | "ollama" | "zhipu" | "fallback";
  modelUsed: string;
};

function isLikelyFeishuChatId(chatId: string): boolean {
  return /^oc_[a-z0-9]{20,}$/i.test(chatId.trim());
}

function compactProgressText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function formatTaskStatusLabel(status: TaskRecord["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "running":
      return "进行中";
    case "queued":
    case "waiting_approval":
      return "待处理";
    case "failed":
    case "cancelled":
      return "受阻";
    default:
      return status;
  }
}

function parseFileArtifactsFromText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const found: string[] = [];
  const changedFilesPattern = /CHANGED_FILES\s*:\s*([^\n]+)/gi;
  for (const match of normalized.matchAll(changedFilesPattern)) {
    const group = (match[1] ?? "").trim();
    if (!group) {
      continue;
    }
    for (const piece of group.split(/[,\s]+/)) {
      const candidate = piece.trim().replace(/^\.?\//, "");
      if (candidate && /\.[a-z0-9]{1,8}$/i.test(candidate)) {
        found.push(candidate);
      }
    }
  }
  const genericPathPattern = /(?:^|[\s`"'(:：])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8})(?=$|[\s`"'),:;])/g;
  for (const match of normalized.matchAll(genericPathPattern)) {
    const candidate = (match[1] ?? "").trim().replace(/^\.?\//, "");
    if (candidate) {
      found.push(candidate);
    }
  }
  return Array.from(new Set(found)).sort((left, right) => left.localeCompare(right));
}

function normalizeFileList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => parseFileArtifactsFromText(entry));
  }
  if (typeof value === "string") {
    return parseFileArtifactsFromText(value);
  }
  return [];
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((entry) => entry.trim()).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function normalizeRoleToken(value: string): RoleId | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (KNOWN_ROLE_IDS.has(normalized as RoleId)) {
    return normalized as RoleId;
  }
  if (normalized === "pm" || normalized.includes("产品")) return "product";
  if (normalized === "ui" || normalized === "ux" || normalized.includes("交互")) return "uiux";
  if (normalized.includes("前端")) return "frontend";
  if (normalized.includes("后端")) return "backend";
  if (normalized.includes("算法") || normalized.includes("model")) return "algorithm";
  if (normalized.includes("测试") || normalized === "test") return "qa";
  if (normalized.includes("研究")) return "research";
  if (normalized.includes("运营") || normalized === "ops") return "operations";
  if (normalized.includes("工程")) return "engineering";
  if (normalized.includes("开发")) return "developer";
  if (normalized.includes("cto")) return "cto";
  if (normalized.includes("ceo")) return "ceo";
  return undefined;
}

function extractFirstJsonObject(raw: string): string | undefined {
  const source = raw.trim();
  if (!source) {
    return undefined;
  }
  const firstBrace = source.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(firstBrace, index + 1);
      }
    }
  }
  return undefined;
}

function parseLeaderAssignmentPlan(
  raw: string,
  facilitator: RoleId,
  fallbackParticipants: RoleId[]
): LeaderAssignmentPlan | undefined {
  const tryParticipants = (value: unknown): RoleId[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeRoleToken(entry))
      .filter((entry): entry is RoleId => Boolean(entry));
    return Array.from(new Set(normalized));
  };

  let participants: RoleId[] = [];
  let rationale = "";
  const jsonCandidate = extractFirstJsonObject(raw);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      participants = tryParticipants(parsed.participants);
      rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    } catch {
      // fallback to regex parse below
    }
  }

  if (participants.length === 0) {
    const roleHits: RoleId[] = [];
    for (const match of raw.matchAll(/\b(ceo|cto|product|uiux|frontend|backend|algorithm|qa|developer|engineering|research|operations)\b/gi)) {
      const role = normalizeRoleToken(match[1] ?? "");
      if (role) {
        roleHits.push(role);
      }
    }
    participants = Array.from(new Set(roleHits));
  }

  if (!participants.includes(facilitator)) {
    participants.unshift(facilitator);
  }
  if (participants.length === 0) {
    return undefined;
  }
  const normalizedParticipants = Array.from(new Set(participants)).slice(0, 8);
  if (normalizedParticipants.length < 2) {
    return undefined;
  }

  return {
    participants: normalizedParticipants,
    rationale: rationale || `leader_plan_fallback_to_parsed_roles; fallback=${fallbackParticipants.join(",")}`,
    backendUsed: "fallback",
    modelUsed: "leader-plan-parser"
  };
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function shouldPushIntermediateNow(key: string): boolean {
  const now = Date.now();
  const last = collabFeishuLastIntermediatePushMs.get(key) ?? 0;
  if (now - last < COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS) {
    return false;
  }
  collabFeishuLastIntermediatePushMs.delete(key);
  collabFeishuLastIntermediatePushMs.set(key, now);
  while (collabFeishuLastIntermediatePushMs.size > 5000) {
    const oldestKey = collabFeishuLastIntermediatePushMs.keys().next().value as string | undefined;
    if (oldestKey) {
      collabFeishuLastIntermediatePushMs.delete(oldestKey);
    } else {
      break;
    }
  }
  return true;
}

// ============ Collaboration Manager ============

type CollaborationManagerDeps = {
  store: VinkoStore;
  feishuClient?: FeishuClient;
};

export class CollaborationManager {
  private deps: CollaborationManagerDeps;
  private collaborationService: AgentCollaborationService;
  private plannerClient = new LocalModelClient();

  constructor(deps: CollaborationManagerDeps) {
    this.deps = deps;
    this.collaborationService = new AgentCollaborationService(deps.store);
  }

  // 获取协作配置
  private getCollaborationConfig(): CollaborationConfig {
    const config = this.deps.store.getRuntimeConfig().collaboration;
    return config.defaultConfig;
  }

  private getHeuristicParticipants(parentTask: TaskRecord): RoleId[] {
    const configParticipants = this.deps.store.getRuntimeConfig().collaboration.defaultParticipants;
    const fallbackParticipants: RoleId[] =
      configParticipants.length > 0 ? configParticipants : ["product", "uiux", "frontend", "backend", "qa", "ceo"];
    const normalizedInstruction = `${parentTask.title}\n${parentTask.instruction}`.toLowerCase();
    const looksLikeDocumentTask =
      /(?:\bprd\b|产品需求|需求文档|产品文档|调研报告|研究报告|分析报告|可行性报告|市场调研|竞品分析|方案文档|roadmap|里程碑|验收标准)/i.test(
        normalizedInstruction
      );
    const looksLikeAlgorithmTask =
      /(?:算法|模型|llm|rag|embedding|agent|具身智能|推理|训练|评测|benchmark|research|paper)/i.test(
        normalizedInstruction
      );
    const looksLikeBuildTask =
      /(?:实现|开发|编码|写代码|前端|后端|接口|联调|部署|上线|build|implement|develop|code|frontend|backend|api|deploy)/i.test(
        normalizedInstruction
      );

    const preferredParticipants: RoleId[] = looksLikeDocumentTask && !looksLikeBuildTask
      ? ["ceo", "product", "research", "algorithm", "cto", "qa"]
      : looksLikeAlgorithmTask && !looksLikeBuildTask
        ? ["ceo", "research", "algorithm", "cto", "product", "qa"]
        : fallbackParticipants;

    const normalized = Array.from(new Set(preferredParticipants)) as RoleId[];
    if (looksLikeAlgorithmTask) {
      if (!normalized.includes("algorithm")) {
        normalized.push("algorithm");
      }
      if (!normalized.includes("research")) {
        normalized.push("research");
      }
      if (!normalized.includes("cto")) {
        normalized.push("cto");
      }
    }
    if (!normalized.includes(parentTask.roleId)) {
      normalized.push(parentTask.roleId);
    }
    return normalized;
  }

  private isLeaderDynamicAssignmentEnabled(): boolean {
    const settings = this.deps.store.getRuntimeSettings();
    const runtimeValue = settings.COLLAB_LEADER_DYNAMIC_ASSIGNMENT;
    const envValue = process.env.COLLAB_LEADER_DYNAMIC_ASSIGNMENT;
    return toBool(runtimeValue ?? envValue, true);
  }

  private getLeaderPlanTimeoutMs(): number {
    const settings = this.deps.store.getRuntimeSettings();
    const raw = settings.COLLAB_LEADER_PLAN_TIMEOUT_MS ?? process.env.COLLAB_LEADER_PLAN_TIMEOUT_MS ?? "45000";
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 12_000;
    }
    return Math.max(2_000, Math.min(60_000, Math.round(parsed)));
  }

  private async resolveParticipants(parentTask: TaskRecord): Promise<{
    participants: RoleId[];
    planner: "leader_dynamic" | "heuristic";
    rationale?: string;
    backendUsed?: string;
    modelUsed?: string;
  }> {
    const fallback = this.getHeuristicParticipants(parentTask);
    if (!this.isLeaderDynamicAssignmentEnabled() || !LEADERSHIP_FACILITATORS.has(parentTask.roleId)) {
      return {
        participants: fallback,
        planner: "heuristic",
        rationale: "leader_dynamic_assignment_disabled_or_non_leader_facilitator"
      };
    }

    const plan = await this.planParticipantsByLeader(parentTask, fallback);
    if (!plan) {
      return {
        participants: fallback,
        planner: "heuristic",
        rationale: "leader_plan_unavailable_fallback_heuristic"
      };
    }

    return {
      participants: plan.participants,
      planner: "leader_dynamic",
      rationale: plan.rationale,
      backendUsed: plan.backendUsed,
      modelUsed: plan.modelUsed
    };
  }

  private async planParticipantsByLeader(
    parentTask: TaskRecord,
    fallbackParticipants: RoleId[]
  ): Promise<LeaderAssignmentPlan | undefined> {
    const availableRoles = ROLE_IDS.map((roleId) => `${roleId}:${ROLE_LABELS[roleId] ?? roleId}`).join(", ");
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: [
          "你是企业协作分工助手，代表 CEO/CTO 决定任务分配角色。",
          "必须仅输出 JSON，不要输出解释文本。",
          'JSON schema: {"participants":["roleId"],"rationale":"<=120 chars"}',
          "participants 仅能从允许角色中选择，且必须包含 facilitator。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `facilitator: ${parentTask.roleId}`,
          `allowed_roles: ${availableRoles}`,
          `fallback_roles: ${fallbackParticipants.join(",")}`,
          `task_title: ${parentTask.title}`,
          `task_instruction: ${parentTask.instruction}`,
          "constraints:",
          "- choose 2~8 roles",
          "- roles must be minimal-but-sufficient",
          "- include QA if there is delivery/acceptance implication",
          "- include algorithm/research when task involves model/algorithm/research evaluation"
        ].join("\n")
      }
    ];

    try {
      const timeoutMs = this.getLeaderPlanTimeoutMs();
      const completion = await Promise.race([
        this.plannerClient.complete(messages),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`leader assignment timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
      const parsed = parseLeaderAssignmentPlan(completion.text, parentTask.roleId, fallbackParticipants);
      if (!parsed) {
        return undefined;
      }
      return {
        ...parsed,
        backendUsed: completion.backendUsed,
        modelUsed: completion.modelUsed
      };
    } catch (error) {
      logger.error("leader dynamic participant planning failed", error, {
        taskId: parentTask.id,
        facilitator: parentTask.roleId
      });
      return undefined;
    }
  }

  // 启动协作流程
  async startCollaboration(parentTask: TaskRecord): Promise<string> {
    const config = this.getCollaborationConfig();
    const participantDecision = await this.resolveParticipants(parentTask);
    const input: CreateAgentCollaborationInput = {
      parentTaskId: parentTask.id,
      participants: participantDecision.participants,
      facilitator: parentTask.roleId,
      config
    };
    if (parentTask.sessionId !== undefined) {
      input.sessionId = parentTask.sessionId;
    }
    if (parentTask.chatId !== undefined) {
      input.chatId = parentTask.chatId;
    }
    const collaboration = this.collaborationService.createCollaboration(input);
    this.deps.store.patchTaskMetadata(parentTask.id, {
      collaborationId: collaboration.id,
      collaborationStatus: "active",
      collaborationStartedAt: new Date().toISOString(),
      collaborationParticipants: participantDecision.participants,
      collaborationPlanner: participantDecision.planner,
      collaborationPlannerRationale: participantDecision.rationale ?? "",
      collaborationPlannerBackend: participantDecision.backendUsed ?? "",
      collaborationPlannerModel: participantDecision.modelUsed ?? ""
    });
    this.deps.store.createCollaborationTimelineEvent({
      collaborationId: collaboration.id,
      eventType: "status",
      roleId: parentTask.roleId,
      taskId: parentTask.id,
      message:
        participantDecision.planner === "leader_dynamic"
          ? `Leader dynamic assignment applied: ${participantDecision.participants.join(", ")}`
          : `Heuristic assignment applied: ${participantDecision.participants.join(", ")}`,
      metadata: {
        planner: participantDecision.planner,
        participants: participantDecision.participants,
        rationale: participantDecision.rationale ?? "",
        backendUsed: participantDecision.backendUsed ?? "",
        modelUsed: participantDecision.modelUsed ?? ""
      }
    });

    // 分配子任务给各角色
    await this.assignTasksToAgents(collaboration, parentTask);
    this.collaborationService.advancePhase(collaboration.id, "execution");

    // 通知用户协作开始
    if (collaboration.chatId && this.deps.feishuClient && isLikelyFeishuChatId(collaboration.chatId)) {
      try {
        await this.deps.feishuClient.sendTextToChat(
          collaboration.chatId,
          `🤝 已启动团队协作（${collaboration.id.slice(0, 8)}）\n参与角色：${collaboration.participants
            .map((roleId) => ROLE_LABELS[roleId] ?? roleId)
            .join("、")}\n我会按里程碑同步结果，不展示内部思考过程。`
        );
      } catch (error) {
        logger.error("Failed to notify collaboration start to Feishu", error, {
          chatId: collaboration.chatId,
          collaborationId: collaboration.id
        });
      }
    }

    return collaboration.id;
  }

  // 分配任务给各 Agent
  private async assignTasksToAgents(
    collaboration: AgentCollaboration,
    parentTask: TaskRecord
  ): Promise<void> {
    const specs = this.buildCollaborationSpecs(parentTask, collaboration.participants);
    const participantLabels = collaboration.participants.map((roleId) => ROLE_LABELS[roleId] ?? roleId).join("、");

    for (const spec of specs) {
      const instances = this.resolveInstancesForRole(spec.roleId);
      for (const instance of instances) {
        const executionContract = this.buildExecutionContract(parentTask, spec.roleId);
        const collaborativeInstruction = [
          spec.instruction,
          "",
          "协作上下文：",
          `- 团队总目标：${parentTask.instruction}`,
          `- 协作参与角色：${participantLabels}`,
          "- 先输出本角色可执行结论，再输出与其他角色的依赖接口（输入/输出）。",
          "- 若与你预期中的其他角色方案冲突，请明确给出取舍建议。",
          ...executionContract
        ].join("\n");
        const childTask = this.deps.store.createTask({
          sessionId: collaboration.sessionId,
          source: parentTask.source,
          roleId: spec.roleId,
          title: instances.length > 1 ? `${spec.title} (${instance.name})` : spec.title,
          instruction: this.withTonePolicy(collaborativeInstruction, instance),
          priority: spec.priority,
          chatId: collaboration.chatId,
          requestedBy: parentTask.requestedBy,
          metadata: {
            parentTaskId: parentTask.id,
            collaborationId: collaboration.id,
            agentInstanceId: instance.id,
            agentInstanceName: instance.name
          }
        });
        this.deps.store.createTaskRelation({
          parentTaskId: parentTask.id,
          childTaskId: childTask.id,
          relationType: "split"
        });

        // 发送任务分配消息
        this.collaborationService.sendMessage({
          collaborationId: collaboration.id,
          taskId: childTask.id,
          fromRoleId: collaboration.facilitator,
          toRoleIds: [spec.roleId],
          messageType: "task_assignment",
          content: `分配给 ${instance.name}：${spec.instruction}`,
          metadata: {
            agentInstanceId: instance.id,
            agentInstanceName: instance.name
          }
        });
      }
    }
  }

  // 处理协作任务完成
  async handleTaskCompletion(task: TaskRecord): Promise<void> {
    const metadata = task.metadata as {
      collaborationId?: string;
      parentTaskId?: string;
      isAggregation?: boolean;
      agentInstanceId?: string;
    };

    if (!metadata.collaborationId) return;

    const collaboration = this.deps.store.getAgentCollaboration(metadata.collaborationId);
    if (!collaboration || collaboration.status !== "active") return;

    // 如果是汇总任务完成
    if (metadata.isAggregation) {
      if (task.status === "completed") {
        await this.handleAggregationComplete(collaboration, task);
      } else {
        this.collaborationService.failCollaboration(collaboration.id);
        this.deps.store.createCollaborationTimelineEvent({
          collaborationId: collaboration.id,
          eventType: "collaboration_failed",
          roleId: task.roleId,
          taskId: task.id,
          message: "Aggregation task failed",
          metadata: {
            errorText: task.errorText ?? "",
            status: task.status
          }
        });
        this.deps.store.failTask(collaboration.parentTaskId, task.errorText ?? "Aggregation task failed");
      }
      return;
    }

    if (task.status !== "completed") {
      this.deps.store.createCollaborationTimelineEvent({
        collaborationId: collaboration.id,
        eventType: "task_failed",
        roleId: task.roleId,
        taskId: task.id,
        agentInstanceId:
          typeof metadata.agentInstanceId === "string" ? metadata.agentInstanceId : undefined,
        message: `子任务失败：${task.title}`,
        metadata: {
          status: task.status,
          errorText: task.errorText ?? ""
        }
      });
      if (collaboration.chatId && collaboration.config.pushIntermediateResults) {
        await this.pushIntermediateResult(collaboration, task);
      }
      const progress = this.getCollaborationProgress(collaboration);
      if (progress.totalCount > 0 && progress.terminalCount === progress.totalCount) {
        if (this.shouldTriggerAggregation(collaboration)) {
          await this.performFinalAggregation(collaboration.id);
        }
      }
      return;
    }

    // 记录阶段结果
    const phaseSummary = [task.result?.summary ?? "", task.result?.deliverable?.slice(0, 1200) ?? ""]
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
    this.collaborationService.recordPhaseResult(
      collaboration.id,
      "execution",
      task.roleId,
      phaseSummary || "no output"
    );

    // 推送中间结果到飞书
    if (collaboration.chatId && collaboration.config.pushIntermediateResults) {
      await this.pushIntermediateResult(collaboration, task);
    }

    // 检查是否所有任务都完成了
    const progress = this.getCollaborationProgress(collaboration);
    if (progress.totalCount > 0 && progress.terminalCount === progress.totalCount) {
      // 检查是否应该触发汇总
      if (this.shouldTriggerAggregation(collaboration)) {
        await this.performFinalAggregation(collaboration.id);
      }
    }
  }

  // 处理汇总任务完成
  private async handleAggregationComplete(
    collaboration: AgentCollaboration,
    task: TaskRecord
  ): Promise<void> {
    this.deps.store.createCollaborationTimelineEvent({
      collaborationId: collaboration.id,
      eventType: "aggregation_completed",
      roleId: task.roleId,
      taskId: task.id,
      message: "Final aggregation completed",
      metadata: {
        summary: task.result?.summary ?? ""
      }
    });
    this.collaborationService.completeCollaboration(collaboration.id);
    const parentTask = this.deps.store.getTask(collaboration.parentTaskId);
    if (parentTask) {
      if (task.result) {
        const reflection: ReflectionNote = task.reflection ?? {
          score: 8,
          confidence: "medium",
          assumptions: [],
          risks: [],
          improvements: []
        };
        this.deps.store.completeTask(parentTask.id, task.result as TaskResult, reflection);
      } else {
        this.deps.store.failTask(parentTask.id, "Aggregation task completed without result");
      }
      this.deps.store.patchTaskMetadata(parentTask.id, {
        collaborationStatus: "completed",
        collaborationCompletedAt: new Date().toISOString()
      });
    }

    // 推送最终结果到飞书
    if (collaboration.chatId && this.deps.feishuClient && isLikelyFeishuChatId(collaboration.chatId)) {
      const summary = compactProgressText(task.result?.summary ?? "", 160) || "已产出最终协作结果。";
      const message = [`✅ 协作已完成（${collaboration.id.slice(0, 8)}）`, `结论：${summary}`, "完整交付可在控制台查看。"].join(
        "\n"
      );

      try {
        await this.deps.feishuClient.sendTextToChat(collaboration.chatId, message);
      } catch (error) {
        logger.error("Failed to send collaboration completion to Feishu", error, {
          chatId: collaboration.chatId,
          collaborationId: collaboration.id
        });
      }
    }
  }

  // 推送中间结果到飞书
  private async pushIntermediateResult(
    collaboration: AgentCollaboration,
    task: TaskRecord
  ): Promise<void> {
    if (!collaboration.chatId || !this.deps.feishuClient || !isLikelyFeishuChatId(collaboration.chatId)) return;
    const pushKey = `${collaboration.id}:${task.roleId}`;
    if (!shouldPushIntermediateNow(pushKey)) {
      return;
    }

    const metadata = task.metadata as { agentInstanceName?: string };
    const roleLabel = ROLE_LABELS[task.roleId] ?? task.roleId;
    const instanceLabel =
      typeof metadata.agentInstanceName === "string" && metadata.agentInstanceName.trim()
        ? ` (${metadata.agentInstanceName.trim()})`
        : "";
    const statusLabel = formatTaskStatusLabel(task.status);
    const summary =
      compactProgressText(task.result?.summary ?? "", 120) ||
      compactProgressText(task.result?.deliverable ?? "", 120) ||
      compactProgressText(task.errorText ?? "", 120) ||
      (task.status === "completed" ? "已完成阶段任务。" : "该角色当前任务受阻。");
    const deliverableDigest = this.buildTaskDeliverableDigest(task);
    const progress = this.getCollaborationProgress(collaboration);
    const roleDigest = this.buildRoleProgressDigest(collaboration);
    const message = [
      `📍团队播报 | ${roleLabel}${instanceLabel} ${statusLabel}`,
      `结论：${summary}`,
      deliverableDigest ? `产出：${deliverableDigest}` : "",
      `进度：${progress.completedCount}/${progress.totalCount} 已完成${progress.failedCount > 0 ? `，受阻 ${progress.failedCount}` : ""}`,
      roleDigest ? `成员动态：${roleDigest}` : ""
    ].join("\n");

    try {
      await this.deps.feishuClient.sendTextToChat(collaboration.chatId, message);
    } catch (error) {
      logger.error("Failed to push intermediate result to Feishu", error, {
        chatId: collaboration.chatId,
        roleId: task.roleId
      });
    }
  }

  private buildRoleProgressDigest(collaboration: AgentCollaboration): string {
    const children = this.getExecutionChildren(collaboration);
    const latestByRole = new Map<RoleId, TaskRecord>();
    for (const task of children) {
      const previous = latestByRole.get(task.roleId);
      if (!previous || previous.updatedAt.localeCompare(task.updatedAt) < 0) {
        latestByRole.set(task.roleId, task);
      }
    }

    const maxRoles = 6;
    const entries = Array.from(latestByRole.values())
      .sort((left, right) => left.roleId.localeCompare(right.roleId))
      .slice(0, maxRoles)
      .map((task) => {
        const roleLabel = ROLE_LABELS[task.roleId] ?? task.roleId;
        const statusLabel = formatTaskStatusLabel(task.status);
        const snippet = this.buildTaskDeliverableDigest(task, 28) || compactProgressText(task.errorText ?? "", 28);
        return snippet ? `${roleLabel} ${statusLabel}:${snippet}` : `${roleLabel} ${statusLabel}`;
      });

    if (latestByRole.size > maxRoles) {
      entries.push(`其余 ${latestByRole.size - maxRoles} 个角色推进中`);
    }
    return entries.join("；");
  }

  private buildTaskDeliverableDigest(task: TaskRecord, maxLength = 120): string {
    const metadata = task.metadata as {
      toolChangedFiles?: unknown;
    };
    const metadataFiles = normalizeFileList(metadata.toolChangedFiles);
    const resultFiles = dedupeSorted(
      parseFileArtifactsFromText(task.result?.summary ?? "").concat(parseFileArtifactsFromText(task.result?.deliverable ?? ""))
    );
    const toolRuns = this.deps.store.listToolRunsByTask(task.id);
    const toolRunFiles = dedupeSorted(
      toolRuns.flatMap((run) =>
        parseFileArtifactsFromText(`${run.outputText ?? ""}\n${run.errorText ?? ""}`)
      )
    );
    const files = dedupeSorted([...metadataFiles, ...resultFiles, ...toolRunFiles]).slice(0, 3);
    const latestToolRun = toolRuns.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const commandOutcome = latestToolRun
      ? latestToolRun.status === "completed"
        ? `命令成功(${latestToolRun.providerId})`
        : latestToolRun.status === "failed"
          ? `命令失败(${latestToolRun.providerId})`
          : latestToolRun.status === "running"
            ? `命令执行中(${latestToolRun.providerId})`
            : undefined
      : undefined;
    const summarySnippet =
      compactProgressText(task.result?.summary ?? "", 40) || compactProgressText(task.errorText ?? "", 40);
    const segments: string[] = [];
    if (files.length > 0) {
      segments.push(`文件:${files.join(", ")}`);
    }
    if (commandOutcome) {
      segments.push(commandOutcome);
    }
    if (summarySnippet) {
      segments.push(summarySnippet);
    }
    const composed = segments.join(" | ").trim();
    return compactProgressText(composed, maxLength);
  }

  // 获取协作进度
  private getCollaborationProgress(collaboration: AgentCollaboration): {
    completedCount: number;
    failedCount: number;
    terminalCount: number;
    totalCount: number;
    pendingCount: number;
  } {
    const children = this.getExecutionChildren(collaboration);
    const completed = children.filter((c) => c.status === "completed");
    const failed = children.filter((c) => c.status === "failed" || c.status === "cancelled");
    const total = children.length;
    const terminal = completed.length + failed.length;
    const pending = Math.max(0, total - terminal);

    return {
      completedCount: completed.length,
      failedCount: failed.length,
      terminalCount: terminal,
      totalCount: total,
      pendingCount: pending
    };
  }

  // 检查是否应该触发汇总
  private shouldTriggerAggregation(collaboration: AgentCollaboration): boolean {
    if (collaboration.currentPhase === "aggregation" || collaboration.currentPhase === "completed") {
      return false;
    }

    const progress = this.getCollaborationProgress(collaboration);

    // 1. 所有执行阶段任务都完成了（且开启了自动汇总）
    if (progress.terminalCount === progress.totalCount && progress.totalCount > 0) {
      if (collaboration.config.autoAggregateOnComplete) {
        return true;
      }
    }

    // 2. 超时（使用 aggregateTimeoutMs）
    const elapsed = Date.now() - new Date(collaboration.createdAt).getTime();
    if (elapsed > collaboration.config.aggregateTimeoutMs) {
      return true;
    }

    return false;
  }

  // 手动触发汇总
  async triggerAggregationManually(collaborationId: string): Promise<boolean> {
    const collaboration = this.deps.store.getAgentCollaboration(collaborationId);
    if (!collaboration || collaboration.status !== "active") {
      return false;
    }

    // 检查是否已经在汇总阶段
    if (collaboration.currentPhase === "aggregation" || collaboration.currentPhase === "completed") {
      return false;
    }

    await this.performFinalAggregation(collaborationId);
    return true;
  }

  // 执行最终汇总
  async performFinalAggregation(collaborationId: string): Promise<void> {
    const collaboration = this.deps.store.getAgentCollaboration(collaborationId);
    if (!collaboration) return;
    if (collaboration.currentPhase === "aggregation" || collaboration.currentPhase === "completed") {
      return;
    }

    this.collaborationService.advancePhase(collaborationId, "aggregation");
    this.deps.store.createCollaborationTimelineEvent({
      collaborationId,
      eventType: "aggregation_started",
      roleId: collaboration.facilitator,
      message: "Start final aggregation",
      metadata: {}
    });

    // 收集所有阶段结果
    const fresh = this.deps.store.getAgentCollaboration(collaborationId) ?? collaboration;
    const allOutputs = fresh.phaseResults.flatMap((p) => p.outputs);

    // 创建汇总任务
    const summaryTask = this.deps.store.createTask({
      sessionId: collaboration.sessionId,
      source: "system",
      roleId: collaboration.facilitator,
      title: `最终汇总: ${collaboration.id.slice(0, 8)}`,
      instruction: this.buildAggregationPrompt(collaboration, allOutputs),
      priority: 99,
      chatId: collaboration.chatId,
      metadata: {
        parentTaskId: collaboration.parentTaskId,
        collaborationId,
        isAggregation: true
      }
    });
    this.deps.store.createTaskRelation({
      parentTaskId: collaboration.parentTaskId,
      childTaskId: summaryTask.id,
      relationType: "aggregate"
    });

    // 发送汇总请求消息
    this.collaborationService.sendMessage({
      collaborationId,
      taskId: summaryTask.id,
      fromRoleId: collaboration.facilitator,
      toRoleIds: [],
      messageType: "summary",
      content: "请汇总所有角色的工作成果，生成最终报告。",
      metadata: {}
    });

    if (collaboration.chatId && this.deps.feishuClient && isLikelyFeishuChatId(collaboration.chatId)) {
      try {
        await this.deps.feishuClient.sendTextToChat(
          collaboration.chatId,
          `🧾 协作子任务已收敛，正在生成最终汇总（${collaboration.id.slice(0, 8)}）。`
        );
      } catch (error) {
        logger.error("Failed to notify aggregation start to Feishu", error, {
          chatId: collaboration.chatId,
          collaborationId
        });
      }
    }
  }

  // 构建汇总提示词
  private buildAggregationPrompt(
    collaboration: AgentCollaboration,
    outputs: { roleId: RoleId; summary: string }[]
  ): string {
    return [
      "请汇总以下各角色的工作成果，生成最终报告：",
      "",
      "=== 各角色输出 ===",
      ...outputs.map((o) => `\n【${ROLE_LABELS[o.roleId] ?? o.roleId}】\n${o.summary}`),
      "",
      "=== 汇总要求 ===",
      "1. 整合各角色输出，形成完整方案",
      "2. 列出关键决策点和风险项",
      "3. 必须列出各角色实际产出（文件路径、执行命令、测试结果）；缺失项要明确标红",
      "4. 给出后续行动建议",
      "5. 如有冲突观点，说明权衡建议"
    ].join("\n");
  }

  // 构建协作规格
  private buildCollaborationSpecs(
    parentTask: TaskRecord,
    participants: RoleId[]
  ): Array<{
    roleId: RoleId;
    title: string;
    instruction: string;
    priority: number;
  }> {
    const ordered = participants.filter((roleId) => roleId !== "ceo");
    if (ordered.length === 0) {
      return [this.buildRoleSpec(parentTask, parentTask.roleId)];
    }
    return ordered.map((roleId) => this.buildRoleSpec(parentTask, roleId));
  }

  private buildRoleSpec(parentTask: TaskRecord, roleId: RoleId): {
    roleId: RoleId;
    title: string;
    instruction: string;
    priority: number;
  } {
    const titlePrefix = parentTask.title.slice(0, 40);
    switch (roleId) {
      case "product":
        return {
          roleId,
          title: `需求分析: ${titlePrefix}`,
          instruction: `请产出可执行 PRD：目标用户、核心场景、范围边界、验收标准（DoD），并给出今天可落地版本。\n${parentTask.instruction}`,
          priority: 95
        };
      case "uiux":
        return {
          roleId,
          title: `交互设计: ${titlePrefix}`,
          instruction: `请产出可执行交互与视觉说明：关键页面/状态、组件层级、文案与交互反馈细节。\n${parentTask.instruction}`,
          priority: 88
        };
      case "frontend":
        return {
          roleId,
          title: `前端方案: ${titlePrefix}`,
          instruction: `请直接在 workspace 落地前端实现（创建/修改文件），并给出运行命令与验证步骤。\n${parentTask.instruction}`,
          priority: 86
        };
      case "backend":
        return {
          roleId,
          title: `后端方案: ${titlePrefix}`,
          instruction: `请直接在 workspace 落地后端实现或接口契约文件（创建/修改文件），并给出联调命令。\n${parentTask.instruction}`,
          priority: 86
        };
      case "qa":
        return {
          roleId,
          title: `测试方案: ${titlePrefix}`,
          instruction: `请输出可执行测试方案：测试用例、执行步骤、期望结果、回归清单与验收门槛。\n${parentTask.instruction}`,
          priority: 90
        };
      case "algorithm":
        return {
          roleId,
          title: `算法评估: ${titlePrefix}`,
          instruction:
            `请从算法视角评估任务可行性：技术路线、模型/数据假设、评测指标、上线风险与替代方案，并给出可执行建议。\n${parentTask.instruction}`,
          priority: 91
        };
      case "research":
        return {
          roleId,
          title: `研究分析: ${titlePrefix}`,
          instruction:
            `请输出研究视角结论：信息来源、行业对标、关键证据、风险机会与建议行动，结论需可追溯。\n${parentTask.instruction}`,
          priority: 90
        };
      case "cto":
        return {
          roleId,
          title: `架构评审: ${titlePrefix}`,
          instruction: `请给出该任务的架构方案、风险评估与技术决策建议：\n${parentTask.instruction}`,
          priority: 92
        };
      default:
        return {
          roleId,
          title: `${ROLE_LABELS[roleId] ?? roleId}方案: ${titlePrefix}`,
          instruction: `请从${ROLE_LABELS[roleId] ?? roleId}视角给出可执行交付：\n${parentTask.instruction}`,
          priority: 80
        };
    }
  }

  private buildExecutionContract(parentTask: TaskRecord, roleId: RoleId): string[] {
    const objective = parentTask.instruction;
    const isDocumentTask =
      /(?:\bprd\b|产品需求|需求文档|产品文档|调研报告|研究报告|分析报告|可行性报告|市场调研|竞品分析|方案文档|roadmap|里程碑|验收标准)/i.test(
        objective
      );
    const isBuildTask =
      /写|实现|开发|构建|创建|搭建|生成|网站|小游戏|代码|build|implement|develop|create|generate|website|game|code/i.test(
        objective
      ) && !isDocumentTask;
    const contracts = [
      "交付约束：",
      "1) 不能只说“需求不明确”就停止；信息不足时先做最小可行假设继续推进。",
      "2) 输出必须包含“已完成事项”与“待确认项（最多3条）”。"
    ];

    if (!isBuildTask) {
      return contracts;
    }

    if (roleId === "frontend" || roleId === "backend") {
      contracts.push("3) 必须在 workspace 直接创建或修改文件，不接受纯方案文本。");
      contracts.push("4) 第一行输出：CHANGED_FILES: <逗号分隔文件路径>。");
      contracts.push("5) 必须给出可执行命令（启动/测试/构建）和预期结果。");
      return contracts;
    }

    if (roleId === "qa") {
      contracts.push("3) 必须给出可执行测试步骤与通过标准，至少覆盖主流程与失败场景。");
      return contracts;
    }

    contracts.push("3) 请输出可被工程角色直接执行的明确输入（验收标准、交互规则、边界条件）。");
    return contracts;
  }

  private resolveInstancesForRole(roleId: RoleId): AgentInstance[] {
    const active = this.deps.store.listActiveAgentInstances(roleId);
    if (active.length > 0) {
      return active.slice(0, 1);
    }
    const created = this.deps.store.createAgentInstance({
      roleId,
      name: `${ROLE_LABELS[roleId]} Agent`,
      createdBy: "system",
      metadata: {
        autoCreated: true
      }
    });
    return [created];
  }

  private withTonePolicy(instruction: string, instance: AgentInstance): string {
    const tone = instance.tonePolicy.trim();
    if (!tone) {
      return instruction;
    }
    return `${instruction}\n\n协作沟通风格要求（${instance.name}）：${tone}`;
  }

  private getExecutionChildren(collaboration: AgentCollaboration): TaskRecord[] {
    return this.deps.store.listTaskChildren(collaboration.parentTaskId).filter((task) => {
      const metadata = task.metadata as {
        collaborationId?: string;
        isAggregation?: boolean;
      };
      return metadata.collaborationId === collaboration.id && !metadata.isAggregation;
    });
  }
}
