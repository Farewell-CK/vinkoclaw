import type { FeishuClient } from "@vinko/feishu-gateway";
import { buildEvolutionStatusCard } from "@vinko/feishu-gateway";
import {
  getEvolutionState,
  type EvolutionState,
  type VinkoStore
} from "@vinko/shared";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLikelyFeishuChatId(chatId: string): boolean {
  return /^oc_[a-z0-9]{20,}$/i.test(chatId.trim());
}

function summarizeEvolutionKind(kind: string): string {
  switch (kind) {
    case "workspace_preference":
      return "工作区偏好已更新";
    case "router_bias":
      return "路由偏好已更新";
    case "template_trigger":
      return "路由模板提示已增强";
    case "skill_recommendation":
      return "技能推荐已更新";
    case "intake_policy":
      return "入口澄清策略已更新";
    case "collaboration_policy":
      return "协作收敛策略已更新";
    default:
      return kind;
  }
}

function buildEvolutionSummary(change: EvolutionState["appliedChanges"][number]): string {
  return `自动进化已应用一条低风险运行时调整：**${summarizeEvolutionKind(change.kind)}**。`;
}

function buildEvolutionWorkflowSummary(change: EvolutionState["appliedChanges"][number]): string {
  return [
    `**变更类型**：${change.kind}`,
    `**变更来源**：${change.proposalId}`,
    `**生效时间**：${change.appliedAt}`
  ].join("\n");
}

export async function notifyEvolutionAppliedChanges(input: {
  store: VinkoStore;
  feishuClient: FeishuClient | undefined;
  chatId: string | undefined;
  beforeState?: EvolutionState | undefined;
  afterState?: EvolutionState | undefined;
}): Promise<void> {
  const chatId = clean(input.chatId);
  if (!chatId || !isLikelyFeishuChatId(chatId) || !input.feishuClient) {
    return;
  }

  const before = input.beforeState ?? getEvolutionState(input.store);
  const after = input.afterState ?? getEvolutionState(input.store);
  const knownIds = new Set(before.appliedChanges.map((entry) => entry.id));
  const newChanges = after.appliedChanges.filter((entry) => !knownIds.has(entry.id));
  if (newChanges.length === 0) {
    return;
  }

  const latest = newChanges[newChanges.length - 1];
  if (!latest) {
    return;
  }
  await input.feishuClient.sendCardToChat(
    chatId,
    buildEvolutionStatusCard({
      eventType: "evolution_change_applied",
      title: "系统学习已生效",
      summary: buildEvolutionSummary(latest),
      workflowSummary: buildEvolutionWorkflowSummary(latest),
      nextActions: ["后续任务会自动按新策略执行", "如需观察影响，可在控制台查看 evolution 状态"]
    })
  );
}
