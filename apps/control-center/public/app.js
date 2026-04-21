import {
  isAuthenticated,
  getCurrentUser,
  logout,
  validateSession
} from "./auth.js";

const roleSelect = document.querySelector("#task-role");
const rolesContainer = document.querySelector("#roles");
const approvalsContainer = document.querySelector("#approvals");
const tasksContainer = document.querySelector("#tasks");
const toolRunsContainer = document.querySelector("#tool-runs");
const auditContainer = document.querySelector("#audit");
const telemetryBoardContainer = document.querySelector("#telemetry-board");
const traceDetailContainer = document.querySelector("#trace-detail");
const goalRunsContainer = document.querySelector("#goal-runs");
const goalRunDetailContainer = document.querySelector("#goal-run-detail");
const messageResult = document.querySelector("#message-result");
const taskResult = document.querySelector("#task-result");
const taskDetailContainer = document.querySelector("#task-detail");
const projectMemoryBoardContainer = document.querySelector("#project-memory-board");
const harnessBoardContainer = document.querySelector("#harness-board");
const crmBoardContainer = document.querySelector("#crm-board");
const crmRunDueResult = document.querySelector("#crm-run-due-result");
const skillsMarketRoleSelect = document.querySelector("#skills-market-role");
const skillsMarketResult = document.querySelector("#skills-market-result");
const skillsMarketListContainer = document.querySelector("#skills-market-list");
const routingTemplatesContainer = document.querySelector("#routing-templates");
const templateResult = document.querySelector("#template-result");
const queueOverviewContainer = document.querySelector("#queue-overview");
const queueAlertsContainer = document.querySelector("#queue-alerts");
const queueByRoleContainer = document.querySelector("#queue-by-role");
const queueByTemplateContainer = document.querySelector("#queue-by-template");
const queueSlaResult = document.querySelector("#queue-sla-result");
const channelsStatusContainer = document.querySelector("#channels-status");
const providersStatusContainer = document.querySelector("#providers-status");
const workflowShortcutContainer = document.querySelector("#workflow-shortcuts");
const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const viewPanels = Array.from(document.querySelectorAll(".view-panel"));
const langButtons = Array.from(document.querySelectorAll(".lang-btn"));
const menuToggle = document.querySelector(".menu-toggle");
const viewNav = document.querySelector(".view-nav");
let selectedTaskId = "";
let selectedTaskDetail = null;
let selectedGoalRunId = "";
let selectedGoalRunDetail = null;
let lastRolesPayload = null;
let lastSkillsMarketResults = [];
let selectedTraceTaskId = "";
let lastRuntimeHarnessPayload = null;

const I18N = {
  zh: {
    "app.title": "VinkoClaw 指挥中心",
    "nav.workbench": "工作台",
    "nav.routing": "模板与队列",
    "nav.config": "团队与渠道",
    "nav.execution": "审批与执行",
    "nav.telemetry": "遥测",
    "nav.audit": "审计",
    "nav.logout": "退出",
    "hero.title": "OPC 指挥中心",
    "hero.lede": "一个飞书指挥室，一个 DGX Spark 总部。多角色智能体团队具备角色技能、审批、记忆策略与反思执行能力。",
    "meta.execution": "执行",
    "meta.approvals": "审批",
    "meta.memory": "记忆",
    "meta.tasks": "{count} 个任务",
    "meta.pending": "{count} 个待审批",
    "panel.natural.title": "自然语言命令",
    "panel.natural.desc": "像在飞书里一样发送命令。运维动作会进入审批。",
    "panel.natural.placeholder": "例如：请配置研究助理的记忆为向量数据库",
    "panel.natural.requestedByPlaceholder": "发起人",
    "panel.natural.submit": "分发",
    "panel.task.title": "直接派单",
    "panel.task.desc": "直接给指定内部角色下达任务。",
    "panel.task.requestedByPlaceholder": "发起人",
    "panel.task.titlePlaceholder": "任务标题",
    "panel.task.instructionPlaceholder": "描述你希望这个角色完成的结果。",
    "panel.task.imagePlaceholder": "图片 URL（每行一个，可选）",
    "panel.task.videoPlaceholder": "视频 URL（每行一个，可选）",
    "panel.task.submit": "入队任务",
    "panel.projects.title": "CEO 项目记忆",
    "panel.projects.desc": "最近会话、当前目标、阶段和待解决问题。",
    "panel.skillsMarket.title": "Skill Marketplace",
    "panel.skillsMarket.desc": "搜索 skill、查看候选并安装到角色。",
    "panel.skillsMarket.queryPlaceholder": "搜索 skill，例如：写 PRD / 调研报告 / 测试回归",
    "panel.skillsMarket.search": "搜索",
    "panel.workflows.title": "Founder 工作流入口",
    "panel.workflows.desc": "给创始人常用工作流的快捷触发入口。",
    "panel.harness.title": "Product Harness",
    "panel.harness.desc": "最近回归套件、通过状态和输出尾部。",
    "panel.crm.title": "CRM 跟进节奏",
    "panel.crm.desc": "查看线索跟进健康度、到期 cadence，并一键触发本轮跟进。",
    "panel.crm.runDue": "运行到期跟进",
    "panel.goalRuns.title": "Goal Runs",
    "panel.goalRuns.desc": "分阶段推进的运行流，包含 harness 评分、handoff、恢复态与审批。",
    "panel.routing.title": "路由模板",
    "panel.routing.desc": "管理任务路由模板，支持创建、更新、删除。",
    "panel.routing.templateNamePlaceholder": "模板名称",
    "panel.routing.descriptionPlaceholder": "描述（可选）",
    "panel.routing.keywordsPlaceholder": "关键词（逗号分隔）",
    "panel.routing.tasksPlaceholder": "任务 JSON，例如 [{\"roleId\":\"frontend\",\"titleTemplate\":\"...\",\"instructionTemplate\":\"...\"}]",
    "panel.routing.mode.any": "匹配任一关键词",
    "panel.routing.mode.all": "匹配全部关键词",
    "panel.routing.importMode.merge": "导入合并",
    "panel.routing.importMode.replace": "导入覆盖",
    "panel.routing.export": "导出 JSON",
    "panel.routing.import": "导入 JSON",
    "panel.routing.jsonIoPlaceholder": "模板 JSON 导入/导出区，例如 {\"templates\":[...]}",
    "panel.routing.save": "保存模板",
    "panel.routing.new": "新建模板",
    "panel.queue.title": "队列指标",
    "panel.queue.desc": "过去 24 小时队列深度与吞吐，按角色和模板拆分。",
    "panel.queue.warningPlaceholder": "预警等待（分钟）",
    "panel.queue.criticalPlaceholder": "严重等待（分钟）",
    "panel.queue.updateSla": "更新 SLA",
    "panel.channel.title": "渠道就绪状态",
    "panel.channel.desc": "飞书/邮件配置完整度与工具提供方可用性。",
    "panel.team.title": "团队状态",
    "panel.team.desc": "角色职责、已装技能、记忆后端策略。",
    "panel.approvals.title": "审批",
    "panel.approvals.desc": "配置变更与外部动作都会先在这里审批。",
    "panel.tasks.title": "任务",
    "panel.tasks.desc": "实时执行流与反思结果。",
    "panel.toolRuns.title": "工具执行",
    "panel.toolRuns.desc": "通过 opencode、codex、claude 的开发任务执行记录。",
    "panel.audit.title": "审计轨迹",
    "panel.audit.desc": "所有运维动作、审批与任务状态变更可追踪。",
    "panel.traces.title": "Agent 遥测轨迹",
    "panel.traces.desc": "LLM 决策时间线、工具调用、Token 用量和规则拦截。",
    "trace.round": "轮次 {round}",
    "trace.backend": "后端: {backend}",
    "trace.model": "模型: {model}",
    "trace.duration": "耗时: {duration}ms",
    "trace.tokens": "Tokens: {tokens}",
    "trace.toolCalls": "工具调用: {count}",
    "trace.blocked": "拦截: {count}",
    "trace.noTrace": "暂无遥测数据",
    "trace.noData": "该任务尚无遥测记录",
    "trace.back": "← 返回遥测列表",
    "common.yes": "是",
    "common.no": "否",
    "common.none": "无",
    "common.pending": "待审批",
    "common.skillsEmpty": "无技能",
    "common.noKeywords": "无关键词",
    "common.unavailable": "不可用",
    "common.failedLoadChannels": "无法加载 /api/channels/status。",
    "common.failedLoadProviders": "无法加载 /api/tool-providers。",
    "status.pending": "待审批",
    "status.queued": "排队中",
    "status.completed": "已完成",
    "status.running": "执行中",
    "status.resuming": "恢复中",
    "status.failed": "失败",
    "status.cancelled": "已取消",
    "status.awaiting_input": "待补充输入",
    "status.awaiting_authorization": "待授权",
    "status.await_user": "待补充",
    "status.partial": "部分完成",
    "status.approved": "已通过",
    "status.rejected": "已拒绝",
    "status.enabled": "启用",
    "status.disabled": "停用",
    "status.configured": "已配置",
    "status.missingConfig": "缺少配置",
    "status.available": "可用",
    "status.missingBinary": "缺少二进制",
    "status.keyOk": "密钥已配置",
    "queue.overview": "概览",
    "queue.queued": "排队",
    "queue.running": "执行中",
    "queue.completed24h": "24h完成",
    "queue.avgWait24h": "24h平均等待",
    "queue.avgRun24h": "24h平均执行",
    "queue.oldestWait": "最久等待",
    "queue.level": "等级",
    "queue.alerts": "SLA 告警",
    "queue.noAlerts": "暂无 SLA 告警。",
    "queue.byRole": "按角色",
    "queue.byTemplate": "按模板",
    "queue.noRoleMetrics": "暂无角色指标。",
    "queue.noTemplateMetrics": "暂无模板指标。",
    "queue.items": "{count} 项",
    "channels.title": "渠道",
    "channels.feishu": "飞书",
    "channels.email": "邮件",
    "channels.inbound": "邮件收件",
    "channels.enabled": "启用",
    "channels.ownerOpenIds": "ownerOpenIds",
    "channels.domain": "域名",
    "channels.verifyToken": "验证令牌",
    "channels.encryptKey": "加密密钥",
    "channels.missing": "缺失项",
    "channels.mailbox": "邮箱文件夹",
    "channels.subjectPrefix": "主题前缀",
    "channels.pollIntervalSec": "轮询间隔(秒)",
    "channels.rateLimit": "限流(每分钟)",
    "channels.senderWhitelist": "发件人白名单",
    "channels.senderWhitelistConfigured": "已配置({count})",
    "channels.senderWhitelistEmpty": "未配置（允许全部）",
    "channels.ledgerCount": "收件台账",
    "channels.lastReceivedAt": "最近收件",
    "providers.title": "工具提供方",
    "providers.policy": "工具策略",
    "providers.order": "顺序",
    "providers.workspaceOnly": "仅工作区",
    "providers.timeout": "超时",
    "providers.binaryPath": "二进制路径",
    "providers.missingKey": "缺少 {name}",
    "approval.status": "状态",
    "approval.approve": "通过",
    "approval.reject": "拒绝",
    "task.attachments": "附件",
    "task.reflection": "反思分 {score} / 置信度 {confidence}",
    "tool.task": "任务",
    "form.slaMustNumber": "SLA 参数必须是数字",
    "form.criticalGreater": "严重阈值必须大于预警阈值",
    "form.queueUpdated": "已更新队列 SLA：预警={warning}m，严重={critical}m",
    "form.invalidTasksJson": "Tasks JSON 无效: {error}",
    "form.updatedTemplate": "已更新模板 {id}",
    "form.createdTemplate": "已创建模板 {id}",
    "form.exportedTemplates": "已导出 {count} 个模板",
    "form.emptyTemplateJson": "模板 JSON 为空",
    "form.invalidImportJson": "导入 JSON 无效: {error}",
    "form.importMustArray": "导入 JSON 必须是数组或包含 templates[]",
    "form.importedTemplates": "已导入模板，模式={mode}，当前数量={count}",
    "form.editingTemplate": "正在编辑 {id}",
    "form.enabledTemplate": "已启用模板 {id}",
    "form.disabledTemplate": "已停用模板 {id}",
    "form.deletedTemplate": "已删除模板 {id}",
    "form.queuedTask": "任务已入队 {id} -> {roleId}",
    "routing.match": "匹配",
    "routing.tasks": "任务"
  },
  en: {
    "app.title": "VinkoClaw Command Room",
    "nav.workbench": "Workbench",
    "nav.routing": "Templates & Queue",
    "nav.config": "Team & Channels",
    "nav.execution": "Approvals & Execution",
    "nav.telemetry": "Telemetry",
    "nav.audit": "Audit",
    "nav.logout": "Logout",
    "hero.title": "OPC Command Room",
    "hero.lede": "One Feishu command room, one DGX Spark headquarters. A multi-role team with scoped skills, approvals, memory policy, and reflective execution.",
    "meta.execution": "Execution",
    "meta.approvals": "Approvals",
    "meta.memory": "Memory",
    "meta.tasks": "{count} tasks",
    "meta.pending": "{count} pending",
    "panel.natural.title": "Natural Command",
    "panel.natural.desc": "Send a command as if it came from Feishu. Operator actions will become approvals.",
    "panel.natural.placeholder": "Example: configure research assistant memory to vector database",
    "panel.natural.requestedByPlaceholder": "requested by",
    "panel.natural.submit": "Dispatch",
    "panel.task.title": "Direct Task",
    "panel.task.desc": "Queue a task to a specific internal role.",
    "panel.task.requestedByPlaceholder": "requested by",
    "panel.task.titlePlaceholder": "Task title",
    "panel.task.instructionPlaceholder": "Describe the outcome you want from this role.",
    "panel.task.imagePlaceholder": "Image URL(s), one per line. Optional.",
    "panel.task.videoPlaceholder": "Video URL(s), one per line. Optional.",
    "panel.task.submit": "Queue Task",
    "panel.projects.title": "CEO Project Memory",
    "panel.projects.desc": "Recent sessions, current goals, stages, and unresolved questions.",
    "panel.skillsMarket.title": "Skill Marketplace",
    "panel.skillsMarket.desc": "Search skills, inspect matches, and install them to a role.",
    "panel.skillsMarket.queryPlaceholder": "Search skill, e.g. PRD writing / research report / regression testing",
    "panel.skillsMarket.search": "Search",
    "panel.workflows.title": "Founder Workflows",
    "panel.workflows.desc": "Shortcut prompts for founder delivery, PRD, research, and recap flows.",
    "panel.harness.title": "Product Harness",
    "panel.harness.desc": "Latest regression suites, pass/fail status, and output tails.",
    "panel.crm.title": "CRM Cadences",
    "panel.crm.desc": "Lead follow-up health, overdue cadences, and one-click follow-up execution.",
    "panel.crm.runDue": "Run Due Follow-ups",
    "panel.goalRuns.title": "Goal Runs",
    "panel.goalRuns.desc": "Stage-driven runs with harness evidence, handoffs, resume state, and approvals.",
    "panel.routing.title": "Routing Templates",
    "panel.routing.desc": "Manage task-routing templates with create, update, and delete operations.",
    "panel.routing.templateNamePlaceholder": "Template name",
    "panel.routing.descriptionPlaceholder": "Description (optional)",
    "panel.routing.keywordsPlaceholder": "Keywords (comma separated)",
    "panel.routing.tasksPlaceholder": "Tasks JSON, e.g. [{\"roleId\":\"frontend\",\"titleTemplate\":\"...\",\"instructionTemplate\":\"...\"}]",
    "panel.routing.mode.any": "Match any keyword",
    "panel.routing.mode.all": "Match all keywords",
    "panel.routing.importMode.merge": "Import merge",
    "panel.routing.importMode.replace": "Import replace",
    "panel.routing.export": "Export JSON",
    "panel.routing.import": "Import JSON",
    "panel.routing.jsonIoPlaceholder": "Template JSON import/export area, e.g. {\"templates\":[...]}",
    "panel.routing.save": "Save Template",
    "panel.routing.new": "New Template",
    "panel.queue.title": "Queue Metrics",
    "panel.queue.desc": "Queue depth and throughput for the last 24h, split by role and template.",
    "panel.queue.warningPlaceholder": "warning wait (minutes)",
    "panel.queue.criticalPlaceholder": "critical wait (minutes)",
    "panel.queue.updateSla": "Update SLA",
    "panel.channel.title": "Channel Readiness",
    "panel.channel.desc": "Feishu / Email configuration completeness and tool provider availability.",
    "panel.team.title": "Team State",
    "panel.team.desc": "Role ownership, installed skills, and memory backend policy.",
    "panel.approvals.title": "Approvals",
    "panel.approvals.desc": "Config changes and external actions stop here before execution.",
    "panel.tasks.title": "Tasks",
    "panel.tasks.desc": "Live execution feed with reflective outputs.",
    "panel.toolRuns.title": "Tool Runs",
    "panel.toolRuns.desc": "Developer/code-executor task runs through opencode, codex, or claude.",
    "panel.audit.title": "Audit Trail",
    "panel.audit.desc": "Every operator action, approval, and task transition stays visible.",
    "panel.traces.title": "Agent Traces",
    "panel.traces.desc": "LLM decision timeline, tool calls, token usage, and rule blocks per task.",
    "trace.round": "Round {round}",
    "trace.backend": "Backend: {backend}",
    "trace.model": "Model: {model}",
    "trace.duration": "Duration: {duration}ms",
    "trace.tokens": "Tokens: {tokens}",
    "trace.toolCalls": "Tool calls: {count}",
    "trace.blocked": "Blocked: {count}",
    "trace.noTrace": "No telemetry data yet",
    "trace.noData": "No trace recorded for this task.",
    "trace.back": "← Back to Traces",
    "common.yes": "yes",
    "common.no": "no",
    "common.none": "none",
    "common.pending": "pending",
    "common.skillsEmpty": "No skills",
    "common.noKeywords": "No keywords",
    "common.unavailable": "unavailable",
    "common.failedLoadChannels": "Cannot load /api/channels/status.",
    "common.failedLoadProviders": "Cannot load /api/tool-providers.",
    "status.pending": "pending",
    "status.queued": "queued",
    "status.completed": "completed",
    "status.running": "running",
    "status.resuming": "resuming",
    "status.failed": "failed",
    "status.cancelled": "cancelled",
    "status.awaiting_input": "awaiting input",
    "status.awaiting_authorization": "awaiting authorization",
    "status.await_user": "awaiting input",
    "status.partial": "partial",
    "status.approved": "approved",
    "status.rejected": "rejected",
    "status.enabled": "enabled",
    "status.disabled": "disabled",
    "status.configured": "configured",
    "status.missingConfig": "missing config",
    "status.available": "available",
    "status.missingBinary": "missing binary",
    "status.keyOk": "key ok",
    "queue.overview": "Overview",
    "queue.queued": "queued",
    "queue.running": "running",
    "queue.completed24h": "completed(24h)",
    "queue.avgWait24h": "avg wait(24h)",
    "queue.avgRun24h": "avg run(24h)",
    "queue.oldestWait": "oldest queued wait",
    "queue.level": "level",
    "queue.alerts": "SLA Alerts",
    "queue.noAlerts": "No SLA alerts.",
    "queue.byRole": "By Role",
    "queue.byTemplate": "By Template",
    "queue.noRoleMetrics": "No role metrics yet.",
    "queue.noTemplateMetrics": "No template metrics yet.",
    "queue.items": "{count} items",
    "channels.title": "Channels",
    "channels.feishu": "Feishu",
    "channels.email": "Email",
    "channels.inbound": "Email Inbound",
    "channels.enabled": "enabled",
    "channels.ownerOpenIds": "ownerOpenIds",
    "channels.domain": "domain",
    "channels.verifyToken": "verify token",
    "channels.encryptKey": "encrypt key",
    "channels.missing": "missing",
    "channels.mailbox": "mailbox",
    "channels.subjectPrefix": "subject prefix",
    "channels.pollIntervalSec": "poll interval (s)",
    "channels.rateLimit": "rate limit (/min)",
    "channels.senderWhitelist": "sender whitelist",
    "channels.senderWhitelistConfigured": "configured ({count})",
    "channels.senderWhitelistEmpty": "not configured (allow all)",
    "channels.ledgerCount": "inbound ledger",
    "channels.lastReceivedAt": "last received",
    "providers.title": "Tool Providers",
    "providers.policy": "Tool Policy",
    "providers.order": "order",
    "providers.workspaceOnly": "workspaceOnly",
    "providers.timeout": "timeout",
    "providers.binaryPath": "binary path",
    "providers.missingKey": "missing {name}",
    "approval.status": "Status",
    "approval.approve": "Approve",
    "approval.reject": "Reject",
    "task.attachments": "Attachments",
    "task.reflection": "Reflection score {score} / confidence {confidence}",
    "tool.task": "task",
    "form.slaMustNumber": "SLA values must be numbers",
    "form.criticalGreater": "Critical minutes must be greater than warning minutes",
    "form.queueUpdated": "Updated queue SLA: warning={warning}m, critical={critical}m",
    "form.invalidTasksJson": "Invalid tasks JSON: {error}",
    "form.updatedTemplate": "Updated template {id}",
    "form.createdTemplate": "Created template {id}",
    "form.exportedTemplates": "Exported {count} templates",
    "form.emptyTemplateJson": "Template JSON is empty",
    "form.invalidImportJson": "Invalid import JSON: {error}",
    "form.importMustArray": "Import JSON must be an array or object with templates[]",
    "form.importedTemplates": "Imported templates with mode={mode}, current count={count}",
    "form.editingTemplate": "Editing {id}",
    "form.enabledTemplate": "Enabled template {id}",
    "form.disabledTemplate": "Disabled template {id}",
    "form.deletedTemplate": "Deleted template {id}",
    "form.queuedTask": "Queued {id} for {roleId}",
    "routing.match": "match",
    "routing.tasks": "tasks"
  }
};

const VIEW_IDS = new Set(["workbench", "routing", "config", "execution", "telemetry", "audit"]);
let currentLang = localStorage.getItem("vinkoclaw.lang") === "en" ? "en" : "zh";
let currentView = VIEW_IDS.has(localStorage.getItem("vinkoclaw.view")) ? localStorage.getItem("vinkoclaw.view") : "workbench";

// Filter state
let approvalFilter = "all";
let taskFilter = "all";

function t(key, params = {}) {
  const primary = I18N[currentLang] || I18N.en;
  const fallback = I18N.en;
  const template = primary[key] || fallback[key] || key;
  return Object.entries(params).reduce(
    (value, [name, replaceValue]) => value.replaceAll(`{${name}}`, String(replaceValue)),
    template
  );
}

function translateStatus(status) {
  const normalized = String(status || "").toLowerCase();
  const key = `status.${normalized}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function yesNo(value) {
  return value ? t("common.yes") : t("common.no");
}

function localeCode() {
  return currentLang === "zh" ? "zh-CN" : "en-US";
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(localeCode());
}

function formatClock(value) {
  return new Date(value).toLocaleTimeString(localeCode());
}

function applyI18n() {
  document.title = t("app.title");
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (key) {
      element.textContent = t(key);
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    if (key) {
      element.setAttribute("placeholder", t(key));
    }
  });
}

function applyView() {
  viewPanels.forEach((panel) => {
    panel.classList.toggle("is-hidden", panel.getAttribute("data-view") !== currentView);
  });
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-view") === currentView);
  });
}

function setView(viewId) {
  if (!VIEW_IDS.has(viewId)) {
    return;
  }
  currentView = viewId;
  localStorage.setItem("vinkoclaw.view", viewId);
  applyView();
}

async function setLanguage(lang) {
  if (lang !== "zh" && lang !== "en") {
    return;
  }
  currentLang = lang;
  localStorage.setItem("vinkoclaw.lang", lang);
  langButtons.forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-lang-switch") === currentLang);
  });
  applyI18n();
  await refresh();
}

function parseKeywords(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseUrlLines(rawValue) {
  return String(rawValue || "")
    .split(/\r?\n/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildAttachments() {
  const imageUrls = parseUrlLines(document.querySelector("#task-image-urls").value);
  const videoUrls = parseUrlLines(document.querySelector("#task-video-urls").value);

  return [
    ...imageUrls.map((url) => ({
      kind: "image",
      url
    })),
    ...videoUrls.map((url) => ({
      kind: "video",
      url
    }))
  ];
}

function defaultTemplateTasksJson() {
  return JSON.stringify(
    [
      {
        roleId: "product",
        titleTemplate: "PM拆解: {{input_short}}",
        instructionTemplate: "请拆解需求并给出验收标准：{{input}}",
        priority: 90
      },
      {
        roleId: "qa",
        titleTemplate: "QA验证: {{input_short}}",
        instructionTemplate: "请输出测试矩阵与回归策略：{{input}}",
        priority: 85
      }
    ],
    null,
    2
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getProjectHistoryKindLabel(kind) {
  if (kind === "crm_lead") {
    return currentLang === "zh" ? "线索" : "Lead";
  }
  if (kind === "crm_cadence") {
    return currentLang === "zh" ? "跟进节奏" : "Cadence";
  }
  if (kind === "crm_contact") {
    return currentLang === "zh" ? "跟进记录" : "Contact";
  }
  if (kind === "goal_run") {
    return currentLang === "zh" ? "目标流程" : "Goal run";
  }
  if (kind === "goal_run_handoff") {
    return currentLang === "zh" ? "流程交接" : "Goal-run handoff";
  }
  if (kind === "goal_run_trace") {
    return currentLang === "zh" ? "流程轨迹" : "Goal-run trace";
  }
  if (kind === "workspace") {
    return currentLang === "zh" ? "项目状态" : "Workspace";
  }
  if (kind === "orchestration_decision") {
    return currentLang === "zh" ? "主 Agent 决策" : "Main-agent decision";
  }
  if (kind === "orchestration_verification") {
    return currentLang === "zh" ? "主 Agent 验证" : "Main-agent verification";
  }
  if (kind === "orchestration_artifact") {
    return currentLang === "zh" ? "主 Agent 交付" : "Main-agent artifact";
  }
  return currentLang === "zh" ? "会话" : "Session";
}

function getProjectHealthLabel(value) {
  if (value === "blocked") {
    return currentLang === "zh" ? "阻塞" : "Blocked";
  }
  if (value === "watch") {
    return currentLang === "zh" ? "关注" : "Watch";
  }
  return currentLang === "zh" ? "健康" : "Healthy";
}

function getProjectPriorityLabel(value) {
  if (value === "high") {
    return currentLang === "zh" ? "高优先级" : "High priority";
  }
  if (value === "medium") {
    return currentLang === "zh" ? "中优先级" : "Medium priority";
  }
  return currentLang === "zh" ? "低优先级" : "Low priority";
}

function formatStructuredValue(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const PLAYGROUND_PREFIX = "/home/xsuper/workspace/playground/";

function normalizeArtifactPath(input) {
  if (!input) {
    return "";
  }
  return String(input)
    .trim()
    .replaceAll("\\", "/")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[),.;]+$/g, "");
}

function toPlaygroundUrl(pathValue) {
  const normalized = normalizeArtifactPath(pathValue);
  if (!normalized.startsWith(PLAYGROUND_PREFIX)) {
    return "";
  }
  const relative = normalized.slice(PLAYGROUND_PREFIX.length);
  if (!relative) {
    return "";
  }
  return `/playground/${encodeURI(relative)}`;
}

function extractWorkspacePaths(text) {
  const source = String(text || "");
  if (!source) {
    return [];
  }
  const matches = source.match(/\/home\/xsuper\/workspace\/[^\s"'`]+/g) || [];
  return matches.map((value) => normalizeArtifactPath(value)).filter(Boolean);
}

function collectTaskArtifactPaths(task) {
  const fromEvidence = Array.isArray(task?.completionEvidence?.artifactFiles)
    ? task.completionEvidence.artifactFiles
    : [];
  const fromMetadata = Array.isArray(task?.metadata?.toolChangedFiles) ? task.metadata.toolChangedFiles : [];
  const fromText = [
    ...extractWorkspacePaths(task?.result?.deliverable),
    ...extractWorkspacePaths(task?.result?.summary)
  ];
  return Array.from(
    new Set([...fromEvidence, ...fromMetadata, ...fromText].map((value) => normalizeArtifactPath(value)).filter(Boolean))
  );
}

function inferArtifactFormats(paths) {
  const formats = new Map();
  for (const item of Array.isArray(paths) ? paths : []) {
    const value = normalizeArtifactPath(item).toLowerCase();
    if (!value) continue;
    if (value.endsWith(".md")) formats.set("md", "Markdown");
    else if (value.endsWith(".html")) formats.set("html", "HTML");
    else if (value.endsWith(".csv")) formats.set("csv", "CSV");
    else if (value.endsWith(".pdf")) formats.set("pdf", "PDF");
    else if (value.endsWith(".doc") || value.endsWith(".docx")) formats.set("doc", "DOCX");
    else if (value.endsWith(".xls") || value.endsWith(".xlsx")) formats.set("xls", "Excel");
  }
  return Array.from(formats.values());
}

function renderTaskArtifactLinks(task) {
  const links = collectTaskArtifactPaths(task)
    .map((artifactPath) => {
      const url = toPlaygroundUrl(artifactPath);
      if (!url) {
        return "";
      }
      const baseName = artifactPath.split("/").pop() || artifactPath;
      const openLabel =
        baseName.toLowerCase().endsWith(".html") || baseName.toLowerCase().endsWith(".htm")
          ? currentLang === "zh"
            ? "打开页面"
            : "Open page"
          : currentLang === "zh"
            ? "打开文件"
            : "Open file";
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${openLabel}: ${escapeHtml(baseName)}</a>`;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (links.length === 0) {
    return "";
  }
  return `<div class="task-artifact-links">${links.join("")}</div>`;
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const safeLabel = escapeHtml(label);
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  });
  html = html.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
    const safeUrl = escapeHtml(match);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
  });
  html = html.replace(/(\/home\/xsuper\/workspace\/playground\/[^\s<]+)/g, (match) => {
    const url = toPlaygroundUrl(match);
    if (!url) {
      return escapeHtml(match);
    }
    const safeUrl = escapeHtml(url);
    const safeLabel = escapeHtml(match);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function renderMarkdown(rawValue, maxLength = 6000) {
  const raw = String(rawValue || "").slice(0, maxLength);
  if (!raw.trim()) {
    return "";
  }

  const lines = raw.split(/\r?\n/g);
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = "";

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = "";
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      closeList();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  closeList();
  return `<div class="markdown-body">${html.join("")}</div>`;
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (value <= 0) {
    return "0s";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatPercent(value, total) {
  const safeTotal = Number(total || 0);
  if (safeTotal <= 0) {
    return "0%";
  }
  return `${Math.round((Number(value || 0) / safeTotal) * 100)}%`;
}

function renderHarnessGradeBadge(harness) {
  const grade = String(harness?.grade || "F").toUpperCase();
  const score = Number(harness?.score || 0);
  return `<span class="pill harness-grade harness-grade-${grade.toLowerCase()}">${escapeHtml(grade)} · ${score}</span>`;
}

function renderHarnessSummaryLine(harness) {
  if (!harness) {
    return "";
  }
  const status = String(harness.status || "");
  const summary = String(harness.summary || "");
  return [status, summary].filter(Boolean).join(" · ");
}

function renderHarnessBlock(harness, options = {}) {
  if (!harness || typeof harness !== "object") {
    return "";
  }
  const title = options.title || (currentLang === "zh" ? "Harness 评分" : "Harness grade");
  const dimensions = harness.dimensions && typeof harness.dimensions === "object" ? harness.dimensions : {};
  const strengths = Array.isArray(harness.strengths) ? harness.strengths : [];
  const gaps = Array.isArray(harness.gaps) ? harness.gaps : [];
  return `
    <article class="list-card compact harness-card">
      <div class="list-head">
        <strong>${escapeHtml(title)}</strong>
        ${renderHarnessGradeBadge(harness)}
      </div>
      <p class="muted">${escapeHtml(renderHarnessSummaryLine(harness))}</p>
      <div class="pill-row">
        ${Object.entries(dimensions)
          .map(([key, value]) => `<span class="pill">${escapeHtml(key)}:${escapeHtml(String(value))}</span>`)
          .join("")}
      </div>
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "Strengths" : "Strengths"}</strong>
        ${
          strengths.length > 0
            ? `<div class="pill-row">${strengths.map((item) => `<span class="pill">${escapeHtml(String(item))}</span>`).join("")}</div>`
            : `<p class="muted">${currentLang === "zh" ? "暂无显式强项" : "No explicit strengths"}</p>`
        }
      </div>
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "Gaps" : "Gaps"}</strong>
        ${
          gaps.length > 0
            ? `<div class="pill-row">${gaps.map((item) => `<span class="pill">${escapeHtml(String(item))}</span>`).join("")}</div>`
            : `<p class="muted">${currentLang === "zh" ? "暂无缺口" : "No visible gaps"}</p>`
        }
      </div>
    </article>
  `;
}

function renderSkillBindingsSummary(skills) {
  if (!skills || typeof skills !== "object") {
    return "";
  }
  const bindings = Array.isArray(skills.bindings) ? skills.bindings : [];
  return `
    <article class="list-card compact harness-card">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "Skill Harness" : "Skill Harness"}</strong>
        <span>${escapeHtml(skills.roleId || "-")}</span>
      </div>
      <p class="muted">${
        currentLang === "zh"
          ? `总数 ${skills.total || 0} · 已验证 ${skills.verified || 0} · 未验证 ${skills.unverified || 0} · 失败 ${skills.failed || 0}`
          : `total ${skills.total || 0} · verified ${skills.verified || 0} · unverified ${skills.unverified || 0} · failed ${skills.failed || 0}`
      }</p>
      ${
        bindings.length > 0
          ? `<div class="pill-row">${bindings
              .map((binding) => {
                const label = [binding.skillId, binding.verificationStatus, binding.sourceLabel || binding.source || ""]
                  .filter(Boolean)
                  .join(" · ");
                return `<span class="pill">${escapeHtml(label)}</span>`;
              })
              .join("")}</div>`
          : `<p class="muted">${currentLang === "zh" ? "当前没有绑定的 skill" : "No bound skills for this execution"}</p>`
      }
    </article>
  `;
}

function renderRuntimeEvidenceSummary(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return "";
  }
  const runtime = evidence.runtime && typeof evidence.runtime === "object" ? evidence.runtime : {};
  const context = evidence.context && typeof evidence.context === "object" ? evidence.context : {};
  const tools = evidence.tools && typeof evidence.tools === "object" ? evidence.tools : {};
  const rules = evidence.rules && typeof evidence.rules === "object" ? evidence.rules : {};
  const telemetry = evidence.telemetry && typeof evidence.telemetry === "object" ? evidence.telemetry : {};
  const exportFormats = inferArtifactFormats(tools.changedFiles);
  return `
    <article class="list-card compact harness-card">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "Runtime Evidence" : "Runtime Evidence"}</strong>
        <span>${escapeHtml(runtime.backendUsed || runtime.modelUsed || "-")}</span>
      </div>
      <div class="pill-row">
        <span class="pill">backend:${escapeHtml(runtime.backendUsed || "-")}</span>
        <span class="pill">model:${escapeHtml(runtime.modelUsed || "-")}</span>
        <span class="pill">toolLoop:${escapeHtml(String(runtime.toolLoopEnabled === true))}</span>
        <span class="pill">tools:${escapeHtml(String(tools.totalCalls || 0))}</span>
        <span class="pill">blocked:${escapeHtml(String(rules.blockedToolCalls || 0))}</span>
        <span class="pill">turns:${escapeHtml(String(telemetry.turns || 0))}</span>
      </div>
      <p class="muted">${
        currentLang === "zh"
          ? `session=${context.sessionAttached === true ? "yes" : "no"} · memory=${context.projectMemoryPresent === true ? "yes" : "no"} · changedFiles=${
              Array.isArray(tools.changedFiles) ? tools.changedFiles.length : 0
            } · duration=${formatDuration(telemetry.durationMs || 0)}`
          : `session=${context.sessionAttached === true ? "yes" : "no"} · memory=${context.projectMemoryPresent === true ? "yes" : "no"} · changedFiles=${
              Array.isArray(tools.changedFiles) ? tools.changedFiles.length : 0
            } · duration=${formatDuration(telemetry.durationMs || 0)}`
      }</p>
      ${
        exportFormats.length > 0
          ? `<p class="muted">${currentLang === "zh" ? "导出格式" : "Export formats"}: ${escapeHtml(exportFormats.join(" / "))}</p>`
          : ""
      }
    </article>
  `;
}

function renderWorkflowSummaryBlock(summary) {
  if (typeof summary !== "string" || !summary.trim()) {
    return "";
  }
  return `
    <article class="list-card compact">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "Workflow Summary" : "Workflow Summary"}</strong>
      </div>
      <div class="markdown-content">${renderMarkdown(summary.trim())}</div>
    </article>
  `;
}

function renderGoalRunWorkflowStateBlock(workflowState) {
  if (!workflowState || typeof workflowState !== "object") {
    return "";
  }
  const renderList = (items, emptyLabel) =>
    Array.isArray(items) && items.length > 0
      ? `<ul style="margin:8px 0 0 18px;padding:0;">${items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`
      : `<p class="muted">${emptyLabel}</p>`;
  return `
    <article class="list-card compact">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "GoalRun Workflow State" : "GoalRun Workflow State"}</strong>
        <span>${escapeHtml(String(workflowState.status || "-"))}</span>
      </div>
      <p><strong>${currentLang === "zh" ? "工作流" : "Workflow"}:</strong> ${escapeHtml(workflowState.workflowLabel || "-")}</p>
      <p><strong>${currentLang === "zh" ? "目标" : "Goal"}:</strong> ${escapeHtml(workflowState.goal || "-")}</p>
      <p><strong>${currentLang === "zh" ? "阶段" : "Stage"}:</strong> ${escapeHtml(workflowState.stage || "-")}</p>
      <p><strong>${currentLang === "zh" ? "下一步" : "Next Step"}:</strong> ${escapeHtml(workflowState.nextStep || "-")}</p>
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "待补充 / 授权" : "Pending / Approval"}</strong>
        ${renderList(workflowState.pendingItems, currentLang === "zh" ? "当前无待补充项" : "No pending items")}
      </div>
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "阻塞" : "Blocked"}</strong>
        ${renderList(workflowState.blockedItems, currentLang === "zh" ? "当前无阻塞项" : "No blockers")}
      </div>
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "成功标准" : "Success Criteria"}</strong>
        ${renderList(workflowState.successCriteria, currentLang === "zh" ? "当前无成功标准" : "No success criteria")}
      </div>
      ${
        workflowState.completionSignal
          ? `<p><strong>${currentLang === "zh" ? "完成信号" : "Completion Signal"}:</strong> ${escapeHtml(workflowState.completionSignal)}</p>`
          : ""
      }
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "最近产物" : "Recent Artifacts"}</strong>
        ${renderList(workflowState.recentArtifacts, currentLang === "zh" ? "当前无产物" : "No recent artifacts")}
      </div>
      ${
        workflowState.handoffSummary
          ? `<p><strong>${currentLang === "zh" ? "最近交接" : "Latest Handoff"}:</strong> ${escapeHtml(workflowState.handoffSummary)}</p>`
          : ""
      }
    </article>
  `;
}

function renderRuntimeHarnessBoard(payload) {
  if (!payload) {
    return "";
  }
  const toolRegistry = payload.toolRegistry || {};
  const rulesEngine = payload.rulesEngine || {};
  const skills = payload.skills || {};
  const roles = Array.isArray(skills.roles) ? skills.roles : [];
  const totalBoundSkills = roles.reduce((sum, role) => sum + Number(role.total || 0), 0);
  const verifiedBoundSkills = roles.reduce((sum, role) => sum + Number(role.verified || 0), 0);
  const failedBoundSkills = roles.reduce((sum, role) => sum + Number(role.failed || 0), 0);
  return `
    <article class="list-card compact harness-card">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "Runtime Harness Snapshot" : "Runtime Harness Snapshot"}</strong>
        <span>${escapeHtml(String(toolRegistry.mode || "default"))}</span>
      </div>
      <div class="pill-row">
        <span class="pill">tools:${escapeHtml(String(toolRegistry.total || 0))}</span>
        <span class="pill">rules:${escapeHtml(String(rulesEngine.total || 0))}</span>
        <span class="pill">catalog:${escapeHtml(String(skills.catalogTotal || 0))}</span>
        <span class="pill">bound:${escapeHtml(String(totalBoundSkills))}</span>
        <span class="pill">verified:${escapeHtml(String(verifiedBoundSkills))}</span>
        ${failedBoundSkills > 0 ? `<span class="pill">failed:${escapeHtml(String(failedBoundSkills))}</span>` : ""}
      </div>
      <div class="memory-block">
        <strong>${currentLang === "zh" ? "Role Bindings" : "Role Bindings"}</strong>
        ${
          roles.length > 0
            ? `<div class="pill-row">${roles
                .filter((role) => Number(role.total || 0) > 0)
                .map(
                  (role) =>
                    `<span class="pill">${escapeHtml(role.roleId)} · ${escapeHtml(
                      `${role.total} / ${formatPercent(role.verified || 0, role.total || 0)} verified`
                    )}</span>`
                )
                .join("")}</div>`
            : `<p class="muted">${currentLang === "zh" ? "暂无角色 skill 绑定" : "No role skill bindings yet"}</p>`
        }
      </div>
    </article>
  `;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function renderRoles(payload) {
  lastRolesPayload = payload;
  roleSelect.innerHTML = payload.roles
    .map((role) => `<option value="${role.id}">${role.name}</option>`)
    .join("");
  if (skillsMarketRoleSelect) {
    skillsMarketRoleSelect.innerHTML = payload.roles
      .map((role) => `<option value="${role.id}">${role.name}</option>`)
      .join("");
  }

  rolesContainer.innerHTML = payload.roles
    .map((role) => {
      const skills = role.skills.length
        ? role.skills
            .map((skill) => {
              const label = [skill.skillId, skill.version ? `v${skill.version}` : "", skill.sourceLabel || skill.source || ""]
                .filter(Boolean)
                .join(" · ");
              const verificationLabel =
                skill.verificationStatus === "verified"
                  ? currentLang === "zh"
                    ? "已验证"
                    : "verified"
                  : skill.verificationStatus === "failed"
                    ? currentLang === "zh"
                      ? "验证失败"
                      : "verify-failed"
                    : currentLang === "zh"
                      ? "未验证"
                      : "unverified";
              return `<span class="pill" title="${escapeHtml(
                `${skill.skillId}${skill.installedAt ? ` @ ${skill.installedAt}` : ""}${skill.verifiedAt ? ` / verified @ ${skill.verifiedAt}` : ""}${skill.sourceUrl ? ` (${skill.sourceUrl})` : ""}`
              )}">${escapeHtml(label)}</span>`;
            })
            .join("")
        : `<span class="muted">${t("common.skillsEmpty")}</span>`;
      const verificationPills = role.skills.length
        ? role.skills
            .map((skill) => {
              const verificationLabel =
                skill.verificationStatus === "verified"
                  ? currentLang === "zh"
                    ? "已验证"
                    : "verified"
                  : skill.verificationStatus === "failed"
                    ? currentLang === "zh"
                      ? "验证失败"
                      : "verify-failed"
                    : currentLang === "zh"
                      ? "未验证"
                      : "unverified";
              return `<span class="pill">${escapeHtml(skill.skillId)} · ${escapeHtml(verificationLabel)}</span>`;
            })
            .join("")
        : "";

      return `
        <article class="role-card">
          <div class="role-head">
            <h3>${escapeHtml(role.name)}</h3>
            <span>${escapeHtml(role.id)}</span>
          </div>
          <p>${escapeHtml(role.responsibility)}</p>
          <div class="pill-row">${skills}</div>
          ${verificationPills ? `<div class="pill-row" style="margin-top:8px;">${verificationPills}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

function renderSkillsMarketResults(results) {
  lastSkillsMarketResults = Array.isArray(results) ? results : [];
  if (!skillsMarketListContainer) {
    return;
  }
  if (lastSkillsMarketResults.length === 0) {
    skillsMarketListContainer.innerHTML = `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "暂无候选 skill" : "No skill matches yet"}</strong>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? "输入关键词后搜索，结果会显示在这里。"
            : "Search with a keyword and results will appear here."
        }</p>
      </article>
    `;
    return;
  }
  skillsMarketListContainer.innerHTML = lastSkillsMarketResults
    .map((entry) => {
      const roles = Array.isArray(entry.allowedRoles) && entry.allowedRoles.length > 0 ? entry.allowedRoles.join(", ") : "n/a";
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      const roleBinding = entry.roleBinding || null;
      const recommendation = entry.recommendation || null;
      const alreadyInstalled = roleBinding?.installed === true;
      const verificationLabel =
        roleBinding?.verificationStatus === "verified"
          ? currentLang === "zh"
            ? "已安装并验证"
            : "installed and verified"
          : roleBinding?.verificationStatus === "failed"
            ? currentLang === "zh"
              ? "已安装但验证失败"
              : "installed but verify failed"
            : alreadyInstalled
              ? currentLang === "zh"
                ? "已安装未验证"
                : "installed but unverified"
              : "";
      const installable = entry.installState !== "discover_only" && entry.installable !== false && !alreadyInstalled;
      const sourceLabel = entry.sourceLabel || entry.source || "catalog";
      const versionLabel = entry.version ? ` · v${escapeHtml(entry.version)}` : "";
      const sourceLink = entry.sourceUrl
        ? `<p class="muted"><a href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(entry.sourceUrl)}</a></p>`
        : "";
      const recommendationLabel =
        recommendation?.state === "ready_verified"
          ? currentLang === "zh"
            ? "推荐：当前角色已验证，可直接复用"
            : "Recommended: already verified on this role"
          : recommendation?.state === "ready_unverified"
            ? currentLang === "zh"
              ? "提示：当前角色已安装，建议先跑验证"
              : "Installed on role, verify before relying on it"
            : recommendation?.state === "ready_failed"
              ? currentLang === "zh"
                ? "风险：当前角色已安装，但最近验证失败"
                : "Risk: installed on role, but last verification failed"
              : recommendation?.state === "install_recommended"
                ? currentLang === "zh"
                  ? "推荐：本地已接入，适合安装到当前角色"
                  : "Recommended: available in local runtime for this role"
                : currentLang === "zh"
                  ? "需要先完成本地 runtime 接入"
                  : "Requires local runtime integration first";
      return `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(entry.name || entry.skillId)}</strong>
            <span>${escapeHtml(sourceLabel)}${versionLabel}</span>
          </div>
          <p>${escapeHtml(entry.summary || entry.description || "")}</p>
          <p class="muted">${escapeHtml(entry.skillId || "")} · ${currentLang === "zh" ? "适用角色" : "Roles"}: ${escapeHtml(roles)}</p>
          ${sourceLink}
          <p class="muted">${escapeHtml(recommendationLabel)}</p>
          ${verificationLabel ? `<p class="muted">${escapeHtml(verificationLabel)}</p>` : ""}
          <p class="muted">${
            installable
              ? currentLang === "zh"
                ? "状态：本地可安装"
                : "State: installable in local runtime"
              : currentLang === "zh"
                ? "状态：仅可发现，暂未接入本地运行时"
                : "State: discoverable only, not available in local runtime yet"
          }</p>
          <div class="pill-row">
            ${tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}
          </div>
          <div class="action-row">
            <button type="button" data-skill-install="${escapeHtml(entry.skillId || "")}" ${installable ? "" : "disabled"}>
              ${
                installable
                  ? currentLang === "zh"
                    ? "安装到所选角色"
                    : "Install to selected role"
                  : alreadyInstalled
                    ? currentLang === "zh"
                      ? "当前角色已安装"
                      : "Already installed on role"
                  : currentLang === "zh"
                    ? "暂不可直接安装"
                    : "Not directly installable yet"
              }
            </button>
            ${
              installable
                ? ""
                : `<button type="button" class="ghost" data-skill-request-integration="${escapeHtml(entry.skillId || "")}">
                    ${
                      currentLang === "zh" ? "创建接入任务" : "Create integration task"
                    }
                  </button>`
            }
          </div>
        </article>
      `;
    })
    .join("");
}

function inferInstalledBy() {
  const currentUser = getCurrentUser();
  if (currentUser?.username) {
    return currentUser.username;
  }
  const messageUser = document.querySelector("#message-user")?.value?.trim();
  if (messageUser) {
    return messageUser;
  }
  const taskRequestedBy = document.querySelector("#task-requested-by")?.value?.trim();
  if (taskRequestedBy) {
    return taskRequestedBy;
  }
  return "owner";
}

function applyWorkflowPreset(preset) {
  const messageInput = document.querySelector("#message-text");
  const requestedByInput = document.querySelector("#message-user");
  if (!messageInput) {
    return;
  }
  const presets = {
    founder_delivery:
      currentLang === "zh"
        ? "请按从想法到交付的方式推进这个需求：做一个登录页 MVP"
        : "Run this request through idea-to-delivery workflow: build a login page MVP",
    founder_prd:
      currentLang === "zh"
        ? "请帮我写一个 PRD：面向独立开发者的 AI 团队控制台"
        : "Write a PRD for an AI team console for solo builders",
    founder_research:
      currentLang === "zh"
        ? "请做一份调研报告：AI 个人创业团队产品的竞品分析"
        : "Create a research report on competitors in AI execution teams for solo founders",
    founder_recap:
      currentLang === "zh"
        ? "请帮我整理本周复盘：已完成、阻塞、下周计划和待决策项"
        : "Create a weekly recap with completed work, blockers, next plan, and open decisions",
    founder_ops_followup:
      currentLang === "zh"
        ? "请整理一份运营跟进清单：待办事项、提醒时间、责任归属、风险和下一步"
        : "Create an ops follow-up checklist with todos, reminder timing, ownership, risks, and next actions"
  };
  messageInput.value = presets[preset] || presets.founder_delivery;
  if (requestedByInput && !requestedByInput.value.trim()) {
    requestedByInput.value = "owner";
  }
  messageInput.focus();
}

function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  const cls = `badge badge-${s}`;
  return `<span class="${cls}">${translateStatus(status)}</span>`;
}

function renderApprovals(approvals) {
  window._lastApprovals = approvals;
  const pending = approvals.filter((a) => a.status === "pending");
  document.querySelector("#meta-approvals").textContent = t("meta.pending", { count: pending.length });

  let filtered = approvals;
  if (approvalFilter !== "all") {
    filtered = approvals.filter((a) => a.status === approvalFilter);
  }

  if (filtered.length === 0) {
    approvalsContainer.innerHTML = `<p class="muted" style="text-align:center;padding:24px 0;">${approvalFilter === "all" ? "暂无审批" : `无${translateStatus(approvalFilter)}状态的审批`}</p>`;
    return;
  }

  // Group by kind
  const grouped = {};
  filtered.forEach((a) => {
    (grouped[a.kind] = grouped[a.kind] || []).push(a);
  });

  let html = "";
  for (const [kind, items] of Object.entries(grouped)) {
    if (items.length <= 1) {
      // Single item, no group needed
      html += items.map((approval) => renderApprovalCard(approval)).join("");
    } else {
      // Group with collapsible header
      const isPending = approvalFilter === "all" && items.some((i) => i.status === "pending");
      const defaultCollapsed = !isPending;
      html += `<div class="collapsible-group">
        <div class="collapsible-header ${defaultCollapsed ? "is-collapsed" : ""}" onclick="this.classList.toggle('is-collapsed');this.nextElementSibling.classList.toggle('is-collapsed');">
          <strong>${escapeHtml(kind)}</strong>
          <span class="muted">${items.length} 项 <span class="chevron">▼</span></span>
        </div>
        <div class="collapsible-body ${defaultCollapsed ? "is-collapsed" : ""}">
          ${items.map((approval) => renderApprovalCard(approval)).join("")}
        </div>
      </div>`;
    }
  }

  approvalsContainer.innerHTML = html;
}

function renderApprovalCard(approval) {
  const actions =
    approval.status === "pending"
      ? `<div class="action-row">
          <button data-approve="${approval.id}">${t("approval.approve")}</button>
          <button class="ghost" data-reject="${approval.id}">${t("approval.reject")}</button>
        </div>`
      : `<p class="muted">${statusBadge(approval.status)}</p>`;

  return `<article class="list-card">
    <div class="list-head">
      <strong>${escapeHtml(approval.kind)}</strong>
      ${statusBadge(approval.status)}
    </div>
    <p>${escapeHtml(approval.summary)}</p>
    ${actions}
  </article>`;
}

function taskStatusKey(status) {
  const s = String(status || "").toLowerCase();
  if (s === "completed") return "completed";
  if (s === "resuming") return "running";
  if (s === "running" || s === "in_progress") return "running";
  if (s === "failed" || s === "error") return "failed";
  return s;
}

function renderTasks(tasks) {
  window._lastTasks = tasks;
  document.querySelector("#meta-tasks").textContent = t("meta.tasks", { count: tasks.length });

  let filtered = tasks;
  if (taskFilter !== "all") {
    filtered = tasks.filter((t) => taskStatusKey(t.displayStatus || t.status) === taskFilter);
  }

  if (filtered.length === 0) {
    tasksContainer.innerHTML = `<p class="muted" style="text-align:center;padding:24px 0;">${taskFilter === "all" ? "暂无任务" : `无${translateStatus(taskFilter)}状态的任务`}</p>`;
    return;
  }

  tasksContainer.innerHTML = filtered
    .map((task) => {
      const attachmentCount = Array.isArray(task.metadata?.attachments) ? task.metadata.attachments.length : 0;
      const status = statusBadge(task.displayStatus || task.status);
      const reflection = task.reflection
        ? `<p class="muted">${t("task.reflection", { score: task.reflection.score, confidence: task.reflection.confidence })}</p>`
        : "";

      const summary = task.result?.summary
        ? `<p><strong>${currentLang === "zh" ? "结论" : "Summary"}:</strong> ${escapeHtml(task.result.summary)}</p>`
        : "";
      const deliverable = renderMarkdown(task.result?.deliverable || "");
      const artifactLinks = renderTaskArtifactLinks(task);
      const deliverableMode = task.completionEvidence?.deliverableMode;
      const deliverableContractViolated = task.completionEvidence?.deliverableContractViolated === true;
      const collaboration = task.completionEvidence?.collaboration;
      const skillIntegration = task.completionEvidence?.skillIntegration;
      const collaborationMeta = collaboration?.enabled
        ? `<div class="pill-row" style="margin:8px 0;">
            ${deliverableMode ? `<span class="pill">deliverable:${escapeHtml(deliverableMode)}</span>` : ""}
            <span class="pill">collab:${escapeHtml(collaboration.status || "active")}</span>
            ${collaboration.phase ? `<span class="pill">phase:${escapeHtml(collaboration.phase)}</span>` : ""}
            ${collaboration.convergenceMode ? `<span class="pill">mode:${escapeHtml(collaboration.convergenceMode)}</span>` : ""}
            ${collaboration.triggerReason ? `<span class="pill">reason:${escapeHtml(collaboration.triggerReason)}</span>` : ""}
          </div>`
        : deliverableMode
          ? `<div class="pill-row" style="margin:8px 0;"><span class="pill">deliverable:${escapeHtml(deliverableMode)}</span></div>`
        : "";
      const deliverableWarning = deliverableContractViolated
        ? `<div style="margin:10px 0;padding:10px 12px;border-radius:12px;background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);">
            <strong>${currentLang === "zh" ? "交付契约未满足" : "Deliverable Contract Failed"}</strong>
            <p class="muted" style="margin-top:6px;">${
              currentLang === "zh"
                ? "该任务要求产出持久化文件，但当前没有检测到 artifact。"
                : "This task required a persisted artifact, but none was detected."
            }</p>
          </div>`
        : "";
      const collaborationProgress = collaboration?.enabled
        ? `<p class="muted">${
            collaboration.resumeRequested
              ? currentLang === "zh"
                ? "已收到补充信息，正在重新汇总协作结果。"
                : "Supplement received, re-aggregating collaboration."
              : currentLang === "zh"
                ? "协作进度"
                : "Collaboration progress"
          } ${
            currentLang === "zh"
              ? `已完成 ${collaboration.childCompleted || 0}/${collaboration.childTotal || 0}，进行中 ${
                  collaboration.childRunning || 0
                }，待处理 ${collaboration.childPending || 0}，受阻 ${collaboration.childFailed || 0}`
              : `done ${collaboration.childCompleted || 0}/${collaboration.childTotal || 0}, running ${
                  collaboration.childRunning || 0
                }, pending ${collaboration.childPending || 0}, blocked ${collaboration.childFailed || 0}`
          }</p>`
        : "";
      const collaborationRoles =
        collaboration?.enabled &&
        ((Array.isArray(collaboration.completedRoles) && collaboration.completedRoles.length > 0) ||
          (Array.isArray(collaboration.failedRoles) && collaboration.failedRoles.length > 0))
          ? `<p class="muted">${
              Array.isArray(collaboration.completedRoles) && collaboration.completedRoles.length > 0
                ? `${currentLang === "zh" ? "已完成角色" : "Completed roles"}: ${escapeHtml(collaboration.completedRoles.join(", "))}`
                : ""
            }${
              Array.isArray(collaboration.completedRoles) &&
              collaboration.completedRoles.length > 0 &&
              Array.isArray(collaboration.failedRoles) &&
              collaboration.failedRoles.length > 0
                ? " · "
                : ""
            }${
              Array.isArray(collaboration.failedRoles) && collaboration.failedRoles.length > 0
                ? `${currentLang === "zh" ? "受阻角色" : "Blocked roles"}: ${escapeHtml(collaboration.failedRoles.join(", "))}`
                : ""
            }</p>`
          : "";
      const pendingQuestions = Array.isArray(collaboration?.pendingQuestions) && collaboration.pendingQuestions.length > 0
        ? `<div style="margin:10px 0;padding:10px 12px;border-radius:12px;background:rgba(255,184,0,0.1);border:1px solid rgba(255,184,0,0.22);">
            <strong>${currentLang === "zh" ? "待补充信息" : "Pending Input"}</strong>
            <ul style="margin:8px 0 0 18px;padding:0;">
              ${collaboration.pendingQuestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </div>`
        : "";
      const skillIntegrationStatus =
        skillIntegration?.skillId
          ? `<div style="margin:10px 0;padding:10px 12px;border-radius:12px;background:${
              skillIntegration.runtimeAvailable ? "rgba(52,199,89,0.08)" : "rgba(255,149,0,0.10)"
            };border:1px solid ${
              skillIntegration.runtimeAvailable ? "rgba(52,199,89,0.2)" : "rgba(255,149,0,0.22)"
            };">
              <strong>${currentLang === "zh" ? "Skill 接入状态" : "Skill Integration Status"}</strong>
              <p class="muted" style="margin-top:6px;">${escapeHtml(skillIntegration.skillName || skillIntegration.skillId)} · ${
                skillIntegration.targetRoleId
                  ? `${currentLang === "zh" ? "目标角色" : "Target role"}: ${escapeHtml(skillIntegration.targetRoleId)} · `
                  : ""
              }${
                skillIntegration.runtimeAvailable
                  ? currentLang === "zh"
                    ? "本地 runtime 已可安装"
                    : "Available for local installation"
                  : currentLang === "zh"
                    ? "本地 runtime 仍未识别"
                    : "Still not recognized by local runtime"
              }</p>
              ${
                skillIntegration?.suggestedAction?.kind === "install_skill"
                  ? `<div class="action-row" style="margin-top:8px;">
                      <button
                        type="button"
                        data-skill-install-ready="${escapeHtml(skillIntegration.skillId)}"
                        data-skill-install-role="${escapeHtml(skillIntegration.targetRoleId || "")}"
                      >${currentLang === "zh" ? "立即安装到目标角色" : "Install to target role now"}</button>
                    </div>`
                  : ""
              }
            </div>`
          : "";

      return `
        <article class="list-card">
          <div class="list-head">
            <strong>${escapeHtml(task.title)}</strong>
            ${status}
          </div>
          <p class="muted">${escapeHtml(task.roleId)} · ${escapeHtml(task.source)} · ${attachmentCount} ${t("task.attachments")}</p>
          <p>${escapeHtml(task.instruction)}</p>
          ${collaborationMeta}
          ${deliverableWarning}
          ${collaborationProgress}
          ${collaborationRoles}
          ${pendingQuestions}
          ${skillIntegrationStatus}
          ${reflection}
          ${summary}
          ${artifactLinks}
          ${deliverable}
          <div class="action-row">
            <button type="button" class="ghost" data-task-detail="${escapeHtml(task.id)}">${
              currentLang === "zh" ? "查看详情" : "View Details"
            }</button>
          </div>
        </article>
      `;
    })
    .join("");

  renderTaskDetail(selectedTaskId, selectedTaskDetail);
}

function renderTaskDetail(taskId, detail) {
  if (!taskId || !detail || !taskDetailContainer) {
    if (taskDetailContainer) {
      taskDetailContainer.classList.add("is-hidden");
      taskDetailContainer.innerHTML = "";
    }
    return;
  }

  const timeline = Array.isArray(detail.timeline) ? detail.timeline : [];
  const children = Array.isArray(detail.children) ? detail.children : [];
  const collaboration = detail.collaboration;
  const projectMemory = detail.session?.metadata?.projectMemory || null;
  const completionEvidence = detail.task?.completionEvidence || {};
  const harness = completionEvidence.harness || null;
  const skills = completionEvidence.skills || null;
  const orchestration = completionEvidence.orchestration || null;
  const workflowSummary = typeof detail.workflowSummary === "string" ? detail.workflowSummary : "";
  const memoryList = (items, emptyLabel) =>
    Array.isArray(items) && items.length > 0
      ? `<ul style="margin:8px 0 0 18px;padding:0;">${items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`
      : `<p class="muted">${emptyLabel}</p>`;
  taskDetailContainer.classList.remove("is-hidden");
  taskDetailContainer.innerHTML = `
    <div class="task-detail-head">
      <strong>${currentLang === "zh" ? "任务详情" : "Task Detail"}: ${escapeHtml(detail.task?.title || taskId)}</strong>
      <button type="button" class="ghost" data-task-detail-close="true">${currentLang === "zh" ? "关闭" : "Close"}</button>
    </div>
    <div class="task-detail-grid">
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "协作概览" : "Collaboration Overview"}</strong>
          <span>${escapeHtml(collaboration?.currentPhase || (currentLang === "zh" ? "未知" : "unknown"))}</span>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? `参与角色：${Array.isArray(collaboration?.participants) ? collaboration.participants.join(", ") : "无"}`
            : `Participants: ${Array.isArray(collaboration?.participants) ? collaboration.participants.join(", ") : "none"}`
        }</p>
        <p class="muted">${
          currentLang === "zh"
            ? `子任务：${children.length} · 时间线事件：${timeline.length}`
            : `Children: ${children.length} · Timeline events: ${timeline.length}`
        }</p>
      </article>
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "主 Agent 状态" : "Main Agent State"}</strong>
          <span>${escapeHtml(orchestration?.progress?.stage || (currentLang === "zh" ? "未建立" : "not set"))}</span>
        </div>
        ${
          orchestration
            ? `
              <p><strong>${currentLang === "zh" ? "目标" : "Goal"}:</strong> ${escapeHtml(orchestration.spec?.goal || "-")}</p>
              <p><strong>${currentLang === "zh" ? "Owner" : "Owner"}:</strong> ${escapeHtml(orchestration.ownerRoleId || "-")}</p>
              <p><strong>${currentLang === "zh" ? "状态" : "Status"}:</strong> ${escapeHtml(orchestration.progress?.status || "-")}</p>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "成功标准" : "Success criteria"}</strong>
                ${memoryList(orchestration.spec?.successCriteria, currentLang === "zh" ? "暂无成功标准" : "No success criteria")}
              </div>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "下一步动作" : "Next actions"}</strong>
                ${memoryList(orchestration.progress?.nextActions, currentLang === "zh" ? "当前没有下一步动作" : "No next actions")}
              </div>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "决策" : "Decisions"}</strong>
                ${memoryList(orchestration.decision?.entries, currentLang === "zh" ? "当前没有记录决策" : "No decisions recorded")}
              </div>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "产物索引" : "Artifact index"}</strong>
                ${Array.isArray(orchestration.artifactIndex?.items) && orchestration.artifactIndex.items.length > 0
                  ? `<ul style="margin:8px 0 0 18px;padding:0;">${orchestration.artifactIndex.items.map((item) => `<li>${escapeHtml(String(item.stage || ""))} · ${escapeHtml(String(item.title || item.path || ""))} · ${escapeHtml(String(item.status || "produced"))}</li>`).join("")}</ul>`
                  : `<p class="muted">${currentLang === "zh" ? "当前没有记录产物" : "No artifacts recorded"}</p>`}
              </div>
            `
            : `<p class="muted">${currentLang === "zh" ? "该任务尚未进入主 Agent 编排状态。" : "This task does not expose main-agent orchestration state yet."}</p>`
        }
      </article>
      ${renderWorkflowSummaryBlock(workflowSummary)}
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "动态记忆" : "Dynamic Memory"}</strong>
          <span>${escapeHtml(projectMemory?.currentStage || (currentLang === "zh" ? "未建立" : "not set"))}</span>
        </div>
        ${
          projectMemory
            ? `
              <p><strong>${currentLang === "zh" ? "当前目标" : "Current goal"}:</strong> ${escapeHtml(projectMemory.currentGoal || "-")}</p>
              <p><strong>${currentLang === "zh" ? "最近请求" : "Latest request"}:</strong> ${escapeHtml(projectMemory.latestUserRequest || "-")}</p>
              <p><strong>${currentLang === "zh" ? "最近结论" : "Latest summary"}:</strong> ${escapeHtml(projectMemory.latestSummary || "-")}</p>
              <p class="muted">${
                currentLang === "zh"
                  ? `最近更新：${formatDateTime(projectMemory.updatedAt)} · ${escapeHtml(projectMemory.updatedBy || "system")}`
                  : `Updated: ${formatDateTime(projectMemory.updatedAt)} · ${escapeHtml(projectMemory.updatedBy || "system")}`
              }</p>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "待解决问题" : "Open questions"}</strong>
                ${memoryList(projectMemory.unresolvedQuestions, currentLang === "zh" ? "当前没有待解决问题" : "No open questions")}
              </div>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "下一步动作" : "Next actions"}</strong>
                ${memoryList(projectMemory.nextActions, currentLang === "zh" ? "当前没有下一步动作" : "No next actions")}
              </div>
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "最近产物" : "Latest artifacts"}</strong>
                ${memoryList(projectMemory.latestArtifacts, currentLang === "zh" ? "当前没有记录的产物" : "No artifacts recorded")}
              </div>
            `
            : `<p class="muted">${currentLang === "zh" ? "该会话还没有建立项目级动态记忆。" : "No project memory has been established for this session."}</p>`
        }
      </article>
      ${renderHarnessBlock(harness, { title: currentLang === "zh" ? "Task Harness Grade" : "Task Harness Grade" })}
      ${renderRuntimeEvidenceSummary(completionEvidence)}
      ${renderSkillBindingsSummary(skills)}
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "子任务" : "Child Tasks"}</strong>
        </div>
        ${
          children.length > 0
            ? children
                .map(
                  (child) =>
                    `<p>${escapeHtml(child.roleId)} · ${statusBadge(child.displayStatus || child.status)} · ${escapeHtml(child.title)}</p>`
                )
                .join("")
            : `<p class="muted">${currentLang === "zh" ? "暂无子任务" : "No child tasks"}</p>`
        }
      </article>
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "关键时间线" : "Timeline"}</strong>
        </div>
        <div class="timeline-list">
          ${
            timeline.length > 0
              ? timeline
                  .slice(0, 12)
                  .map(
                    (entry) => `
                      <div class="timeline-item">
                        <strong>${escapeHtml(entry.eventType || "event")}</strong>
                        <p>${escapeHtml(entry.message || "")}</p>
                        <p class="muted">${formatDateTime(entry.createdAt)}</p>
                      </div>`
                  )
                  .join("")
              : `<p class="muted">${currentLang === "zh" ? "暂无时间线事件" : "No timeline events"}</p>`
          }
        </div>
      </article>
    </div>
  `;
}

async function openTaskDetail(taskId) {
  if (!taskId) {
    return;
  }
  selectedTaskId = taskId;
  try {
    selectedTaskDetail = await request(`/api/tasks/${taskId}/collaboration`);
  } catch {
    selectedTaskDetail = await request(`/api/tasks/${taskId}/children`);
  }
  renderTaskDetail(selectedTaskId, selectedTaskDetail);
}

function renderGoalRuns(goalRuns) {
  if (!goalRunsContainer) {
    return;
  }

  const runs = Array.isArray(goalRuns) ? goalRuns : [];
  if (runs.length === 0) {
    goalRunsContainer.innerHTML = `<p class="muted" style="text-align:center;padding:24px 0;">${
      currentLang === "zh" ? "暂无 GoalRun 记录" : "No GoalRun records yet"
    }</p>`;
    renderGoalRunDetail("", null);
    return;
  }

  goalRunsContainer.innerHTML = runs
    .map((run) => {
      const completionEvidence = run?.completionEvidence || {};
      const workflowState = run?.workflowState || {};
      const harness = completionEvidence.harness || null;
      const telemetry = completionEvidence.telemetry || {};
      const rules = completionEvidence.rules || {};
      const completedRoles = Array.isArray(completionEvidence.completedRoles) ? completionEvidence.completedRoles : [];
      const failedRoles = Array.isArray(completionEvidence.failedRoles) ? completionEvidence.failedRoles : [];
      const preview = workflowState?.nextStep || run?.result?.summary || run?.errorText || run?.objective || "";
      return `
        <article class="list-card ${selectedGoalRunId === run.id ? "is-selected" : ""}" data-goal-run-detail="${escapeHtml(run.id)}" style="cursor:pointer">
          <div class="list-head">
            <strong>${escapeHtml(String(run.objective || "").slice(0, 96))}${String(run.objective || "").length > 96 ? "..." : ""}</strong>
            ${statusBadge(run.status)}
          </div>
          <p class="muted">${escapeHtml(workflowState.stage || run.currentStage || "-")} · ${escapeHtml(run.source || "-")} · ${
            run.updatedAt ? formatDateTime(run.updatedAt) : "-"
          }</p>
          <p>${escapeHtml(String(preview).slice(0, 180))}${String(preview).length > 180 ? "..." : ""}</p>
          <div class="pill-row">
            ${workflowState?.workflowLabel ? `<span class="pill">${escapeHtml(String(workflowState.workflowLabel))}</span>` : ""}
            ${harness ? renderHarnessGradeBadge(harness) : ""}
            <span class="pill">retry:${escapeHtml(`${run.retryCount || 0}/${run.maxRetries || 0}`)}</span>
            <span class="pill">turns:${escapeHtml(String(telemetry.turns || 0))}</span>
            <span class="pill">approval:${escapeHtml(String(rules.approvalGateHits || completionEvidence.approvalGateHits || 0))}</span>
            <span class="pill">handoff:${escapeHtml(String(completionEvidence.handoffArtifactPresent === true))}</span>
            ${
              run.currentTaskId
                ? `<span class="pill">task:${escapeHtml(String(run.currentTaskId).slice(0, 8))}</span>`
                : ""
            }
          </div>
          <p class="muted">${
            currentLang === "zh"
              ? `完成角色 ${completedRoles.length} · 受阻角色 ${failedRoles.length}${run.requestedBy ? ` · 发起人 ${run.requestedBy}` : ""}`
              : `completed roles ${completedRoles.length} · failed roles ${failedRoles.length}${run.requestedBy ? ` · requested by ${run.requestedBy}` : ""}`
          }</p>
        </article>
      `;
    })
    .join("");

  renderGoalRunDetail(selectedGoalRunId, selectedGoalRunDetail);
}

function renderGoalRunDetail(goalRunId, detail) {
  if (!goalRunId || !detail || !goalRunDetailContainer || !detail.goalRun) {
    if (goalRunDetailContainer) {
      goalRunDetailContainer.classList.add("is-hidden");
      goalRunDetailContainer.innerHTML = "";
    }
    return;
  }

  const goalRun = detail.goalRun;
  const completionEvidence = goalRun.completionEvidence || {};
  const workflowState = goalRun.workflowState || {};
  const harness = completionEvidence.harness || null;
  const skills = completionEvidence.skills || null;
  const orchestration = completionEvidence.orchestration || null;
  const inputs = Array.isArray(detail.inputs) ? detail.inputs : [];
  const authTokens = Array.isArray(detail.authTokens) ? detail.authTokens : [];
  const timeline = Array.isArray(detail.timeline) ? detail.timeline : [];
  const traces = Array.isArray(detail.traces) ? detail.traces : [];
  const handoffs =
    Array.isArray(detail.handoffs) && detail.handoffs.length > 0
      ? detail.handoffs
      : detail.latestHandoff
        ? [detail.latestHandoff]
        : [];
  const awaitingFields = Array.isArray(goalRun.awaitingInputFields) ? goalRun.awaitingInputFields : [];
  const result = goalRun.result || null;
  const currentTask = detail.task || null;
  const renderList = (items, emptyLabel) =>
    Array.isArray(items) && items.length > 0
      ? `<ul style="margin:8px 0 0 18px;padding:0;">${items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`
      : `<p class="muted">${emptyLabel}</p>`;

  goalRunDetailContainer.classList.remove("is-hidden");
  goalRunDetailContainer.innerHTML = `
    <div class="task-detail-head">
      <strong>${currentLang === "zh" ? "GoalRun 详情" : "GoalRun Detail"}: ${escapeHtml(goalRun.objective || goalRunId)}</strong>
      <button type="button" class="ghost" data-goal-run-detail-close="true">${currentLang === "zh" ? "关闭" : "Close"}</button>
    </div>
    <div class="task-detail-grid">
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "运行概览" : "Run Overview"}</strong>
          ${statusBadge(goalRun.status)}
        </div>
        <p class="muted">${escapeHtml(workflowState.stage || goalRun.currentStage || "-")} · ${escapeHtml(goalRun.language || "-")} · ${
          goalRun.updatedAt ? formatDateTime(goalRun.updatedAt) : "-"
        }</p>
        <div class="pill-row">
          <span class="pill">retry:${escapeHtml(`${goalRun.retryCount || 0}/${goalRun.maxRetries || 0}`)}</span>
          <span class="pill">awaiting:${escapeHtml(String(awaitingFields.length))}</span>
          <span class="pill">timeline:${escapeHtml(String(timeline.length))}</span>
          <span class="pill">traces:${escapeHtml(String(traces.length))}</span>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? `发起人 ${goalRun.requestedBy || "-"} · 当前任务 ${goalRun.currentTaskId ? goalRun.currentTaskId.slice(0, 8) : "-"}`
            : `requested by ${goalRun.requestedBy || "-"} · current task ${goalRun.currentTaskId ? goalRun.currentTaskId.slice(0, 8) : "-"}`
        }</p>
        ${
          goalRun.errorText
            ? `<pre style="background:var(--red-soft);color:var(--red);border:1px solid rgba(255,59,48,0.2);">${escapeHtml(goalRun.errorText)}</pre>`
            : ""
        }
      </article>
      ${renderGoalRunWorkflowStateBlock(workflowState)}
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "结果与恢复态" : "Result & Resume State"}</strong>
          <span>${escapeHtml(workflowState.workflowLabel || goalRun.currentStage || "-")}</span>
        </div>
        ${
          result
            ? `
              <p><strong>${currentLang === "zh" ? "总结" : "Summary"}:</strong> ${escapeHtml(result.summary || "-")}</p>
              ${result.deliverable ? renderMarkdown(result.deliverable) : ""}
              <div class="memory-block">
                <strong>${currentLang === "zh" ? "下一步" : "Next Actions"}</strong>
                ${renderList(result.nextActions || [], currentLang === "zh" ? "暂无下一步" : "No next actions")}
              </div>
            `
            : `<p class="muted">${currentLang === "zh" ? "该 GoalRun 还没有最终结果。" : "This GoalRun has not produced a final result yet."}</p>`
        }
        ${
          goalRun.awaitingInputPrompt
            ? `<div class="memory-block">
                <strong>${currentLang === "zh" ? "待补充输入" : "Awaiting Input"}</strong>
                <p>${escapeHtml(goalRun.awaitingInputPrompt)}</p>
                ${renderList(awaitingFields, currentLang === "zh" ? "未声明字段" : "No explicit fields")}
              </div>`
            : ""
        }
      </article>
      ${renderHarnessBlock(harness, { title: currentLang === "zh" ? "GoalRun Harness Grade" : "GoalRun Harness Grade" })}
      ${renderRuntimeEvidenceSummary(completionEvidence)}
      ${renderSkillBindingsSummary(skills)}
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "当前任务" : "Current Task"}</strong>
          <span>${currentTask ? escapeHtml(currentTask.roleId || "-") : "-"}</span>
        </div>
        ${
          currentTask
            ? `
              <p><strong>${escapeHtml(currentTask.title || currentTask.id)}</strong></p>
              <p class="muted">${escapeHtml(currentTask.displayStatus || currentTask.status || "-")} · ${escapeHtml(
                currentTask.source || "-"
              )}</p>
              <p>${escapeHtml(currentTask.instruction || "")}</p>
              <div class="action-row">
                <button type="button" class="ghost" data-goal-run-open-task="${escapeHtml(currentTask.id)}">${
                  currentLang === "zh" ? "打开任务详情" : "Open Task Detail"
                }</button>
              </div>
            `
            : `<p class="muted">${currentLang === "zh" ? "当前没有关联任务。" : "No linked task for this GoalRun."}</p>`
        }
      </article>
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "输入与授权" : "Inputs & Authorizations"}</strong>
          <span>${escapeHtml(String(inputs.length + authTokens.length))}</span>
        </div>
        <div class="memory-block">
          <strong>${currentLang === "zh" ? "输入" : "Inputs"}</strong>
          ${
            inputs.length > 0
              ? inputs
                  .map(
                    (entry) =>
                      `<p><strong>${escapeHtml(entry.inputKey || "-")}</strong>: ${escapeHtml(formatStructuredValue(entry.value))}</p>`
                  )
                  .join("")
              : `<p class="muted">${currentLang === "zh" ? "暂无补充输入" : "No supplemental inputs"}</p>`
          }
        </div>
        <div class="memory-block">
          <strong>${currentLang === "zh" ? "授权 Token" : "Authorization Tokens"}</strong>
          ${
            authTokens.length > 0
              ? authTokens
                  .map(
                    (entry) =>
                      `<p>${escapeHtml(entry.scope || "-")} · ${escapeHtml(entry.status || "-")} · ${escapeHtml(
                        entry.token || "-"
                      )} · ${entry.expiresAt ? formatDateTime(entry.expiresAt) : "-"}</p>`
                  )
                  .join("")
              : `<p class="muted">${currentLang === "zh" ? "暂无授权 token" : "No authorization tokens"}</p>`
          }
        </div>
      </article>
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "Handoff 产物" : "Handoff Artifacts"}</strong>
          <span>${escapeHtml(String(handoffs.length))}</span>
        </div>
        ${
          handoffs.length > 0
            ? handoffs
                .slice(0, 8)
                .map(
                  (handoff) => `
                    <div class="timeline-item">
                      <strong>${escapeHtml(handoff.stage || "-")}</strong>
                      <p>${escapeHtml(handoff.summary || "-")}</p>
                      <p class="muted">${handoff.createdAt ? formatDateTime(handoff.createdAt) : "-"}</p>
                      <div class="pill-row">
                        ${(Array.isArray(handoff.artifacts) ? handoff.artifacts : [])
                          .slice(0, 4)
                          .map((item) => `<span class="pill">${escapeHtml(String(item))}</span>`)
                          .join("")}
                        ${(Array.isArray(handoff.nextActions) ? handoff.nextActions : [])
                          .slice(0, 2)
                          .map((item) => `<span class="pill">${escapeHtml(String(item))}</span>`)
                          .join("")}
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<p class="muted">${currentLang === "zh" ? "暂无 handoff 产物" : "No handoff artifacts yet"}</p>`
        }
      </article>
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "GoalRun Traces" : "GoalRun Traces"}</strong>
          <span>${escapeHtml(String(traces.length))}</span>
        </div>
        ${
          traces.length > 0
            ? traces
                .slice(0, 10)
                .map(
                  (trace) => `
                    <div class="timeline-item">
                      <strong>${escapeHtml(trace.stage || "-")} · ${escapeHtml(trace.status || "-")}</strong>
                      <p>${escapeHtml(trace.inputSummary || "-")}</p>
                      <p>${escapeHtml(trace.outputSummary || "-")}</p>
                      <div class="pill-row">
                        <span class="pill">approval:${escapeHtml(String(trace.approvalGateHits || 0))}</span>
                        <span class="pill">artifacts:${escapeHtml(String(Array.isArray(trace.artifactFiles) ? trace.artifactFiles.length : 0))}</span>
                        ${
                          trace.failureCategory
                            ? `<span class="pill">${escapeHtml(String(trace.failureCategory))}</span>`
                            : ""
                        }
                      </div>
                      ${
                        trace.taskId
                          ? `<div class="action-row">
                              <button type="button" class="ghost" data-goal-run-open-task="${escapeHtml(trace.taskId)}">${
                                currentLang === "zh" ? "打开关联任务" : "Open Linked Task"
                              }</button>
                            </div>`
                          : ""
                      }
                    </div>
                  `
                )
                .join("")
            : `<p class="muted">${currentLang === "zh" ? "暂无 GoalRun trace" : "No GoalRun traces yet"}</p>`
        }
      </article>
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "关键时间线" : "Timeline"}</strong>
          <span>${escapeHtml(String(timeline.length))}</span>
        </div>
        <div class="timeline-list">
          ${
            timeline.length > 0
              ? timeline
                  .slice(0, 16)
                  .map(
                    (entry) => `
                      <div class="timeline-item">
                        <strong>${escapeHtml(entry.eventType || "event")}</strong>
                        <p>${escapeHtml(entry.message || "")}</p>
                        <p class="muted">${entry.createdAt ? formatDateTime(entry.createdAt) : "-"}</p>
                      </div>
                    `
                  )
                  .join("")
              : `<p class="muted">${currentLang === "zh" ? "暂无时间线事件" : "No timeline events"}</p>`
          }
        </div>
      </article>
    </div>
  `;
}

async function openGoalRunDetail(goalRunId, options = {}) {
  if (!goalRunId) {
    return;
  }

  if (!options.background) {
    selectedGoalRunId = goalRunId;
  }

  const [detailResult, timelineResult, traceResult, handoffResult] = await Promise.allSettled([
    request(`/api/goal-runs/${goalRunId}`),
    request(`/api/goal-runs/${goalRunId}/timeline`),
    request(`/api/goal-runs/${goalRunId}/trace`),
    request(`/api/goal-runs/${goalRunId}/handoff?latest=false`)
  ]);

  if (detailResult.status !== "fulfilled") {
    throw detailResult.reason;
  }

  const mergedDetail = {
    ...detailResult.value,
    timeline: timelineResult.status === "fulfilled" ? timelineResult.value.timeline || [] : [],
    traces: traceResult.status === "fulfilled" ? traceResult.value.traces || [] : [],
    handoffs:
      handoffResult.status === "fulfilled"
        ? handoffResult.value.handoffs || []
        : detailResult.value.latestHandoff
          ? [detailResult.value.latestHandoff]
          : []
  };

  if (!options.background || selectedGoalRunId === goalRunId) {
    selectedGoalRunDetail = mergedDetail;
    renderGoalRuns(window._lastGoalRuns || []);
    renderGoalRunDetail(selectedGoalRunId, selectedGoalRunDetail);
  }
}

function renderToolRuns(toolRuns) {
  toolRunsContainer.innerHTML = toolRuns
    .map((run) => {
      const command = [run.command, ...(run.args || [])].join(" ");
      const isError = run.status === "failed" || run.errorText;
      const status = statusBadge(run.status);
      const approval = statusBadge(run.approvalStatus);

      const output = run.outputText
        ? `<pre>${escapeHtml(String(run.outputText).slice(0, 450))}</pre>`
        : isError && run.errorText
          ? `<pre style="background:var(--red-soft);color:var(--red);border:1px solid rgba(255,59,48,0.2);">${escapeHtml(String(run.errorText).slice(0, 450))}</pre>`
          : "";

      return `
        <article class="list-card" ${isError ? 'style="border-left:3px solid var(--red);"' : ""}>
          <div class="list-head">
            <strong>${escapeHtml(run.title)}</strong>
            <span>${status} ${approval}</span>
          </div>
          <p class="muted">${escapeHtml(run.providerId)} · ${escapeHtml(run.riskLevel)} · ${t("tool.task")} ${escapeHtml(run.taskId)}</p>
          <p class="muted" style="font-size:0.8rem;">${escapeHtml(command.slice(0, 200))}</p>
          ${output}
        </article>
      `;
    })
    .join("");
}

function renderAudit(audit) {
  auditContainer.innerHTML = audit
    .map(
      (event) => `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(event.category)}</strong>
            <span>${formatDateTime(event.createdAt)}</span>
          </div>
          <p>${escapeHtml(event.message)}</p>
          <p class="muted">${escapeHtml(event.entityType)} · ${escapeHtml(event.entityId)}</p>
        </article>
      `
    )
    .join("");
}

function renderConfig(config) {
  document.querySelector("#meta-memory").textContent = config.memory.defaultBackend;
  const warningMinutes = Math.max(0, Math.round((config.queue?.sla?.warningWaitMs || 0) / 60000));
  const criticalMinutes = Math.max(1, Math.round((config.queue?.sla?.criticalWaitMs || 0) / 60000));
  document.querySelector("#queue-warning-min").value = String(warningMinutes);
  document.querySelector("#queue-critical-min").value = String(criticalMinutes);
}

function loadTemplateToForm(template) {
  document.querySelector("#template-id").value = template.id;
  document.querySelector("#template-name").value = template.name;
  document.querySelector("#template-description").value = template.description || "";
  document.querySelector("#template-mode").value = template.matchMode || "any";
  document.querySelector("#template-keywords").value = (template.triggerKeywords || []).join(", ");
  document.querySelector("#template-tasks").value = JSON.stringify(template.tasks || [], null, 2);
}

function resetTemplateForm() {
  document.querySelector("#template-id").value = "";
  document.querySelector("#template-name").value = "";
  document.querySelector("#template-description").value = "";
  document.querySelector("#template-mode").value = "any";
  document.querySelector("#template-keywords").value = "";
  document.querySelector("#template-tasks").value = defaultTemplateTasksJson();
}

function renderRoutingTemplates(templates) {
  routingTemplatesContainer.innerHTML = templates
    .map((template) => {
      const status = template.enabled ? t("status.enabled") : t("status.disabled");
      const keywords = (template.triggerKeywords || []).map((value) => `<span class="pill">${escapeHtml(value)}</span>`).join("");
      return `
        <article class="list-card">
          <div class="list-head">
            <strong>${escapeHtml(template.name)}</strong>
            <span>${escapeHtml(status)}</span>
          </div>
          <p>${escapeHtml(template.description || "")}</p>
          <p class="muted">${escapeHtml(template.id)} · ${t("routing.match")} ${escapeHtml(template.matchMode)} · ${
            template.tasks?.length || 0
          } ${t("routing.tasks")}</p>
          <div class="pill-row">${keywords || `<span class="muted">${t("common.noKeywords")}</span>`}</div>
          <div class="action-row">
            <button data-template-edit="${template.id}">${currentLang === "zh" ? "编辑" : "Edit"}</button>
            <button class="ghost" data-template-toggle="${template.id}" data-template-enabled="${template.enabled}">
              ${template.enabled ? (currentLang === "zh" ? "停用" : "Disable") : currentLang === "zh" ? "启用" : "Enable"}
            </button>
            <button class="ghost" data-template-delete="${template.id}">${currentLang === "zh" ? "删除" : "Delete"}</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderQueueMetrics(queueMetrics) {
  const metrics = queueMetrics || {
    queuedCount: 0,
    runningCount: 0,
    completedCountLast24h: 0,
    avgWaitMsLast24h: 0,
    avgRunMsLast24h: 0,
    oldestQueuedWaitMs: 0,
    alertLevel: "ok",
    alerts: [],
    byRole: [],
    byTemplate: [],
    updatedAt: new Date().toISOString()
  };

  queueOverviewContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head"><strong>${t("queue.overview")}</strong><span>${formatClock(metrics.updatedAt)}</span></div>
      <p>${t("queue.queued")}: ${metrics.queuedCount} · ${t("queue.running")}: ${metrics.runningCount} · ${t("queue.completed24h")}: ${metrics.completedCountLast24h}</p>
      <p class="muted">${t("queue.avgWait24h")}: ${formatDuration(metrics.avgWaitMsLast24h)} · ${t("queue.avgRun24h")}: ${formatDuration(metrics.avgRunMsLast24h)}</p>
      <p class="muted">${t("queue.oldestWait")}: ${formatDuration(metrics.oldestQueuedWaitMs)} · ${t("queue.level")}: ${escapeHtml(metrics.alertLevel)}</p>
    </article>
  `;

  queueAlertsContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head"><strong>${t("queue.alerts")}</strong><span>${metrics.alerts.length}</span></div>
      ${
        metrics.alerts.length === 0
          ? `<p class="muted">${t("queue.noAlerts")}</p>`
          : metrics.alerts
              .map(
                (alert) =>
                  `<p>[${escapeHtml(alert.level)}] ${escapeHtml(alert.message)} · ${t("queue.queued")}:${alert.queuedCount} · ${t("queue.oldestWait")}:${formatDuration(alert.oldestQueuedWaitMs)}</p>`
              )
              .join("")
      }
    </article>
  `;

  queueByRoleContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head"><strong>${t("queue.byRole")}</strong><span>${t("queue.items", { count: metrics.byRole.length })}</span></div>
      ${
        metrics.byRole.length === 0
          ? `<p class="muted">${t("queue.noRoleMetrics")}</p>`
          : metrics.byRole
              .map(
                (entry) =>
                  `<p>${escapeHtml(entry.label)} · q:${entry.queued} r:${entry.running} · wait:${formatDuration(entry.avgWaitMs)} run:${formatDuration(entry.avgRunMs)}</p>`
              )
              .join("")
      }
    </article>
  `;

  queueByTemplateContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head"><strong>${t("queue.byTemplate")}</strong><span>${t("queue.items", { count: metrics.byTemplate.length })}</span></div>
      ${
        metrics.byTemplate.length === 0
          ? `<p class="muted">${t("queue.noTemplateMetrics")}</p>`
          : metrics.byTemplate
              .map(
                (entry) =>
                  `<p>${escapeHtml(entry.label)} · q:${entry.queued} r:${entry.running} · wait:${formatDuration(entry.avgWaitMs)} run:${formatDuration(entry.avgRunMs)}</p>`
              )
              .join("")
      }
    </article>
  `;
}

function renderChannelsStatus(payload) {
  if (!payload || !payload.status) {
    channelsStatusContainer.innerHTML = `
      <article class="list-card compact">
        <div class="list-head"><strong>${t("channels.title")}</strong><span>${t("common.unavailable")}</span></div>
        <p class="muted">${t("common.failedLoadChannels")}</p>
      </article>
    `;
    return;
  }

  const channels = payload.channels || {};
  const status = payload.status || {};
  const feishu = status.feishu || {};
  const email = status.email || {};
  const inbound = email.inbound || {};
  const feishuMissing = Array.isArray(feishu.missing) ? feishu.missing : [];
  const emailMissing = Array.isArray(email.missing) ? email.missing : [];
  const inboundMissing = Array.isArray(inbound.missing) ? inbound.missing : [];
  const inboundMailbox = typeof inbound.mailbox === "string" && inbound.mailbox.trim() ? inbound.mailbox.trim() : "INBOX";
  const inboundSubjectPrefix =
    typeof inbound.subjectPrefix === "string" && inbound.subjectPrefix.trim()
      ? inbound.subjectPrefix.trim()
      : t("common.none");
  const inboundPollIntervalSeconds = Number(inbound.pollIntervalSeconds || 15);
  const inboundRateLimitPerMinute = Number(inbound.rateLimitPerMinute || 20);
  const whitelistConfigured = Boolean(inbound.allowedSendersConfigured);
  const whitelistCount = Number(inbound.allowedSendersCount || 0);
  const inboundLedgerCount = Number(inbound.ledgerCount || 0);
  const inboundLastReceivedAt =
    typeof inbound.lastReceivedAt === "string" && inbound.lastReceivedAt.trim()
      ? inbound.lastReceivedAt.trim()
      : t("common.none");
  const feishuDomain = typeof feishu.domain === "string" && feishu.domain.trim() ? feishu.domain.trim() : "feishu";
  const feishuVerifyTokenConfigured = Boolean(feishu.verificationTokenConfigured);
  const feishuEncryptKeyConfigured = Boolean(feishu.encryptKeyConfigured);

  channelsStatusContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head"><strong>${t("channels.feishu")}</strong><span>${feishu.configured ? t("status.configured") : t("status.missingConfig")}</span></div>
      <p>${t("channels.enabled")}: ${yesNo(channels.feishuEnabled)} · ${t("channels.ownerOpenIds")}: ${yesNo(feishu.ownerOpenIdsConfigured)}</p>
      <p class="muted">${t("channels.domain")}: ${escapeHtml(feishuDomain)} · ${t("channels.verifyToken")}: ${yesNo(feishuVerifyTokenConfigured)} · ${t("channels.encryptKey")}: ${yesNo(feishuEncryptKeyConfigured)}</p>
      <p class="muted">${t("channels.missing")}: ${feishuMissing.length > 0 ? escapeHtml(feishuMissing.join(", ")) : t("common.none")}</p>
    </article>
    <article class="list-card compact">
      <div class="list-head"><strong>${t("channels.email")}</strong><span>${email.configured ? t("status.configured") : t("status.missingConfig")}</span></div>
      <p>${t("channels.enabled")}: ${yesNo(channels.emailEnabled)}</p>
      <p class="muted">${t("channels.missing")}: ${emailMissing.length > 0 ? escapeHtml(emailMissing.join(", ")) : t("common.none")}</p>
    </article>
    <article class="list-card compact">
      <div class="list-head"><strong>${t("channels.inbound")}</strong><span>${inbound.configured ? t("status.configured") : t("status.missingConfig")}</span></div>
      <p>${t("channels.enabled")}: ${yesNo(inbound.enabled)}</p>
      <p>${t("channels.mailbox")}: ${escapeHtml(inboundMailbox)} · ${t("channels.subjectPrefix")}: ${escapeHtml(inboundSubjectPrefix)}</p>
      <p class="muted">${t("channels.pollIntervalSec")}: ${Number.isFinite(inboundPollIntervalSeconds) ? Math.max(1, Math.round(inboundPollIntervalSeconds)) : 15} · ${t("channels.rateLimit")}: ${Number.isFinite(inboundRateLimitPerMinute) ? Math.max(1, Math.round(inboundRateLimitPerMinute)) : 20}</p>
      <p class="muted">${t("channels.senderWhitelist")}: ${
        whitelistConfigured
          ? t("channels.senderWhitelistConfigured", { count: whitelistCount })
          : t("channels.senderWhitelistEmpty")
      }</p>
      <p class="muted">${t("channels.ledgerCount")}: ${Math.max(0, Math.round(inboundLedgerCount))} · ${t("channels.lastReceivedAt")}: ${escapeHtml(inboundLastReceivedAt)}</p>
      <p class="muted">${t("channels.missing")}: ${inboundMissing.length > 0 ? escapeHtml(inboundMissing.join(", ")) : t("common.none")}</p>
    </article>
  `;
}

function renderProviderStatus(payload) {
  if (!payload || !Array.isArray(payload.providers)) {
    providersStatusContainer.innerHTML = `
      <article class="list-card compact">
        <div class="list-head"><strong>${t("providers.title")}</strong><span>${t("common.unavailable")}</span></div>
        <p class="muted">${t("common.failedLoadProviders")}</p>
      </article>
    `;
    return;
  }

  const policy = payload.policy || {};
  const providerOrder = Array.isArray(policy.providerOrder) ? policy.providerOrder.join(" > ") : "n/a";
  const approvalMode = policy.approvalMode || "n/a";
  const timeoutMs = Number(policy.timeoutMs || 0);

  providersStatusContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head"><strong>${t("providers.policy")}</strong><span>${escapeHtml(approvalMode)}</span></div>
      <p>${t("providers.order")}: ${escapeHtml(providerOrder)}</p>
      <p class="muted">${t("providers.workspaceOnly")}: ${yesNo(policy.workspaceOnly)} · ${t("providers.timeout")}: ${formatDuration(timeoutMs)}</p>
    </article>
    ${payload.providers
      .map((provider) => {
        const status = provider.available ? t("status.available") : t("status.missingBinary");
        const keyStatus = provider.keyConfigured
          ? t("status.keyOk")
          : t("providers.missingKey", { name: provider.keyEnvName || "api key" });
        const note = provider.note ? `<p class="muted">${escapeHtml(provider.note)}</p>` : "";
        return `
          <article class="list-card compact">
            <div class="list-head"><strong>${escapeHtml(provider.providerId)}</strong><span>${escapeHtml(status)}</span></div>
            <p>${escapeHtml(keyStatus)}</p>
            <p class="muted">${t("providers.binaryPath")}: ${escapeHtml(provider.binaryPath || "n/a")}</p>
            ${note}
          </article>
        `;
      })
      .join("")}
  `;
}

function renderProjectMemoryBoard(board) {
  if (!projectMemoryBoardContainer) {
    return;
  }
  const summary = board?.summary || null;
  const primary = board?.primary || null;
  const teamReadiness = Array.isArray(board?.teamReadiness) ? board.teamReadiness : [];
  const workstreams = Array.isArray(board?.workstreams) ? board.workstreams : [];
  const projects = Array.isArray(board?.projects) ? board.projects : [];
  const archivedProjects = Array.isArray(board?.archivedProjects) ? board.archivedProjects : [];
  const blockers = Array.isArray(board?.blockers) ? board.blockers.slice(0, 5) : [];
  const pendingDecisions = Array.isArray(board?.pendingDecisions) ? board.pendingDecisions.slice(0, 5) : [];
  const nextActions = Array.isArray(board?.nextActions) ? board.nextActions.slice(0, 5) : [];
  const latestArtifacts = Array.isArray(board?.latestArtifacts) ? board.latestArtifacts.slice(0, 5) : [];
  const renderMiniList = (items, emptyLabel) =>
    items.length > 0
      ? `<ul style="margin:8px 0 0 18px;padding:0;">${items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`
      : `<p class="muted">${emptyLabel}</p>`;

  if (!primary && workstreams.length === 0) {
    projectMemoryBoardContainer.innerHTML = `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "暂无项目面板数据" : "No project board data yet"}</strong>
          <span>0</span>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? "当 CEO 发起任务、团队交付结果或协作等待补充时，这里会自动累积项目态势。"
            : "This board fills automatically as the CEO creates work, the team delivers, or collaboration pauses for input."
        }</p>
      </article>
    `;
    return;
  }
  const readinessCards = teamReadiness
    .slice(0, 6)
    .map((role) => {
      const statusLabel =
        role.failedSkills > 0
          ? currentLang === "zh"
            ? "有失败 skill"
            : "has failed skills"
          : role.unverifiedSkills > 0
            ? currentLang === "zh"
              ? "待验证"
              : "verification debt"
            : currentLang === "zh"
              ? "就绪"
              : "ready";
      return `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(role.roleName)}</strong>
            <span>${escapeHtml(statusLabel)}</span>
          </div>
          <p class="muted">${escapeHtml(role.roleId)} · ${escapeHtml(role.responsibility)}</p>
          <p class="muted">${
            currentLang === "zh"
              ? `已验证 ${role.verifiedSkills} / 未验证 ${role.unverifiedSkills} / 失败 ${role.failedSkills}`
              : `verified ${role.verifiedSkills} / unverified ${role.unverifiedSkills} / failed ${role.failedSkills}`
          }</p>
          ${renderMiniList(
            role.highlightedSkills || [],
            currentLang === "zh" ? "当前没有高亮 skill" : "No highlighted skills"
          )}
        </article>
      `;
    })
    .join("");

  const workstreamCards = workstreams
    .slice(0, 4)
    .map(
      (stream) => `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(stream.currentGoal || stream.sessionTitle || stream.sessionId)}</strong>
            <span>${escapeHtml(stream.currentStage || (currentLang === "zh" ? "未设阶段" : "no stage"))}</span>
          </div>
          <p class="muted">${escapeHtml(stream.source)} · ${formatDateTime(stream.updatedAt)}</p>
          ${
            stream.orchestrationMode
              ? `<div class="pill-row" style="margin:8px 0;">
                  <span class="pill">${escapeHtml(String(stream.orchestrationMode))}</span>
                  ${stream.orchestrationOwnerRoleId ? `<span class="pill">owner:${escapeHtml(String(stream.orchestrationOwnerRoleId))}</span>` : ""}
                  ${stream.orchestrationVerificationStatus ? `<span class="pill">verify:${escapeHtml(String(stream.orchestrationVerificationStatus))}</span>` : ""}
                </div>`
              : ""
          }
          <p><strong>${currentLang === "zh" ? "最近结论" : "Latest summary"}:</strong> ${escapeHtml(stream.latestSummary || "-")}</p>
          <div class="memory-block">
            <strong>${currentLang === "zh" ? "下一步动作" : "Next actions"}</strong>
            ${renderMiniList(stream.nextActions || [], currentLang === "zh" ? "暂无动作" : "No actions")}
          </div>
        </article>
      `
    )
    .join("");
  const projectCards = projects
    .slice(0, 4)
    .map(
      (project) => `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(project.name || project.currentGoal || project.id)}</strong>
            <span>${escapeHtml(project.stage || (currentLang === "zh" ? "未设阶段" : "no stage"))}</span>
          </div>
          <p class="muted">${formatDateTime(project.updatedAt)}</p>
          <div class="pill-row" style="margin:8px 0;">
            <span class="pill">${escapeHtml(getProjectHealthLabel(project.health))}</span>
            <span class="pill">${escapeHtml(getProjectPriorityLabel(project.priority))}</span>
          </div>
          <p><strong>${currentLang === "zh" ? "当前目标" : "Current goal"}:</strong> ${escapeHtml(project.currentGoal || "-")}</p>
          <p><strong>${currentLang === "zh" ? "最近结论" : "Latest summary"}:</strong> ${escapeHtml(project.latestSummary || "-")}</p>
          <div class="pill-row" style="margin:8px 0;">
            <span class="pill">${currentLang === "zh" ? "线索" : "Leads"} · ${Number(project.crmLeadCount ?? 0)}</span>
            <span class="pill">${currentLang === "zh" ? "活跃 cadence" : "Active cadences"} · ${Number(project.crmActiveCadences ?? 0)}</span>
            <span class="pill">${currentLang === "zh" ? "到期 cadence" : "Overdue cadences"} · ${Number(project.crmOverdueCadences ?? 0)}</span>
          </div>
          <div class="memory-block">
            <strong>${currentLang === "zh" ? "项目时间线" : "Project history"}</strong>
            ${
              Array.isArray(project.history) && project.history.length > 0
                ? `<ul style="margin:8px 0 0 18px;padding:0;">${project.history
                    .slice(0, 4)
                    .map(
                      (entry) =>
                        `<li><strong>${escapeHtml(getProjectHistoryKindLabel(entry.kind))}</strong> · ${escapeHtml(entry.stage || "-")} · ${escapeHtml(entry.summary || entry.sessionTitle || "-")} <span class="muted">(${formatDateTime(entry.updatedAt)})</span></li>`
                    )
                    .join("")}</ul>`
                : `<p class="muted">${currentLang === "zh" ? "暂无项目历史" : "No project history yet"}</p>`
            }
          </div>
        </article>
      `
    )
    .join("");
  const archivedProjectCards = archivedProjects
    .slice(0, 3)
    .map(
      (project) => `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(project.name || project.currentGoal || project.id)}</strong>
            <span>${currentLang === "zh" ? "已归档" : "archived"}</span>
          </div>
          <p class="muted">${formatDateTime(project.updatedAt)}</p>
          <p>${escapeHtml(project.latestSummary || project.currentGoal || "-")}</p>
        </article>
      `
    )
    .join("");

  projectMemoryBoardContainer.innerHTML = `
    <article class="list-card compact">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "CEO 总览" : "CEO Overview"}</strong>
        <span>${formatDateTime(board?.generatedAt || new Date().toISOString())}</span>
      </div>
      <div class="pill-row">
        <span class="pill">${currentLang === "zh" ? "项目" : "Projects"} · ${summary?.activeProjects ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "归档项目" : "Archived"} · ${summary?.archivedProjects ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "阻塞任务" : "Blocked"} · ${summary?.blockedTasks ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "待补充" : "Awaiting input"} · ${summary?.awaitingInputTasks ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "角色就绪" : "Roles ready"} · ${summary?.readyRoles ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "验证债务" : "Verification debt"} · ${summary?.verificationDebtRoles ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "活跃线索" : "Active leads"} · ${summary?.activeLeads ?? 0}</span>
        <span class="pill">${currentLang === "zh" ? "到期 cadence" : "Overdue cadences"} · ${summary?.overdueCadences ?? 0}</span>
      </div>
    </article>
    ${
      primary
        ? `
          <article class="list-card compact">
            <div class="list-head">
              <strong>${escapeHtml(primary.currentGoal || primary.sessionTitle || primary.sessionId)}</strong>
              <span>${escapeHtml(primary.currentStage || (currentLang === "zh" ? "未设阶段" : "no stage"))}</span>
            </div>
            <p class="muted">${escapeHtml(primary.source)} · ${formatDateTime(primary.updatedAt)}</p>
            ${
              primary.orchestrationMode
                ? `<div class="pill-row" style="margin:8px 0;">
                    <span class="pill">${escapeHtml(String(primary.orchestrationMode))}</span>
                    ${primary.orchestrationOwnerRoleId ? `<span class="pill">owner:${escapeHtml(String(primary.orchestrationOwnerRoleId))}</span>` : ""}
                    ${primary.orchestrationVerificationStatus ? `<span class="pill">verify:${escapeHtml(String(primary.orchestrationVerificationStatus))}</span>` : ""}
                  </div>`
                : ""
            }
            <p><strong>${currentLang === "zh" ? "最近请求" : "Latest request"}:</strong> ${escapeHtml(primary.latestUserRequest || "-")}</p>
            <p><strong>${currentLang === "zh" ? "最近结论" : "Latest summary"}:</strong> ${escapeHtml(primary.latestSummary || "-")}</p>
            <div class="memory-block">
              <strong>${currentLang === "zh" ? "关键决策 / 待决策" : "Decisions / Pending"}</strong>
              ${renderMiniList(pendingDecisions, currentLang === "zh" ? "暂无待决策项" : "No pending decisions")}
            </div>
            <div class="memory-block">
              <strong>${currentLang === "zh" ? "阻塞与风险" : "Blockers & Risks"}</strong>
              ${renderMiniList(blockers, currentLang === "zh" ? "暂无阻塞" : "No blockers")}
            </div>
            <div class="memory-block">
              <strong>${currentLang === "zh" ? "下一步动作" : "Next actions"}</strong>
              ${renderMiniList(nextActions, currentLang === "zh" ? "暂无下一步" : "No next actions")}
            </div>
            <div class="memory-block">
              <strong>${currentLang === "zh" ? "最近产物" : "Recent artifacts"}</strong>
              ${renderMiniList(latestArtifacts, currentLang === "zh" ? "暂无产物" : "No artifacts")}
            </div>
          </article>
        `
        : ""
    }
    ${readinessCards}
    ${
      projectCards
        ? `
          <article class="list-card compact">
            <div class="list-head">
              <strong>${currentLang === "zh" ? "多项目视图" : "Multi-project view"}</strong>
              <span>${projects.length}</span>
            </div>
            <p class="muted">${
              currentLang === "zh"
                ? "按项目聚合主目标、最近结论和历史节点。"
                : "Grouped by project with current goals, summaries, and history."
            }</p>
          </article>
          ${projectCards}
        `
        : ""
    }
    ${workstreamCards}
    ${
      archivedProjectCards
        ? `
          <article class="list-card compact">
            <div class="list-head">
              <strong>${currentLang === "zh" ? "项目归档" : "Project archive"}</strong>
              <span>${archivedProjects.length}</span>
            </div>
            <p class="muted">${
              currentLang === "zh"
                ? "保留最近归档项目，便于回看结论和产物。"
                : "Recently archived projects for historical context."
            }</p>
          </article>
          ${archivedProjectCards}
        `
        : ""
    }
  `;
}

function renderHarnessBoard(payload, gradesPayload, runtimeHarnessPayload) {
  if (!harnessBoardContainer) {
    return;
  }
  const grades = Array.isArray(gradesPayload?.grades) ? gradesPayload.grades : [];
  const gradeBySuite = new Map(grades.map((entry) => [String(entry.suite || ""), entry]));
  const runtimeCard = renderRuntimeHarnessBoard(runtimeHarnessPayload);
  if (!payload?.configured) {
    harnessBoardContainer.innerHTML = `
      ${runtimeCard}
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "Harness 未配置" : "Harness not configured"}</strong>
          <span>0</span>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? "运行一次 harness 脚本后，这里会显示最近的回归结果。"
            : "Run a harness script once and the latest regression results will appear here."
        }</p>
      </article>
    `;
    return;
  }
  const suites = Array.isArray(payload?.suites) ? payload.suites : [];
  if (suites.length === 0) {
    harnessBoardContainer.innerHTML = `
      ${runtimeCard}
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "暂无 Harness 结果" : "No harness results yet"}</strong>
          <span>0</span>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? "执行 npm run harness:product 或 npm run harness:founder-delivery 后，这里会自动展示最近一次结果。"
            : "Run npm run harness:product or npm run harness:founder-delivery and the latest result will appear here."
        }</p>
      </article>
    `;
    return;
  }
  harnessBoardContainer.innerHTML = `${runtimeCard}${suites
    .map((suiteEntry) => {
      const latest = suiteEntry?.latest ?? null;
      const suiteGrade = gradeBySuite.get(String(suiteEntry?.suite ?? ""));
      const ok = latest?.ok === true;
      const statusLabel = latest
        ? ok
          ? currentLang === "zh"
            ? "通过"
            : "pass"
          : currentLang === "zh"
            ? "失败"
            : "fail"
        : currentLang === "zh"
          ? "未运行"
          : "not run";
      const tail = [latest?.stderrTail, latest?.stdoutTail]
        .find((value) => typeof value === "string" && value.trim())
        ?.trim();
      const stageSummary =
        latest?.stageSummary && typeof latest.stageSummary === "object" ? latest.stageSummary : null;
      const stageEntries = stageSummary ? Object.entries(stageSummary).slice(0, 6) : [];
      const summaryBits = [];
      if (typeof latest?.durationMs === "number") {
        summaryBits.push(`${currentLang === "zh" ? "耗时" : "duration"} ${formatDuration(latest.durationMs)}`);
      }
      if (typeof latest?.budgetMs === "number") {
        summaryBits.push(`${currentLang === "zh" ? "预算" : "budget"} ${formatDuration(latest.budgetMs)}`);
      }
      if (latest?.exceededBudget === true && typeof latest?.overBudgetMs === "number") {
        summaryBits.push(`${currentLang === "zh" ? "超预算" : "over budget"} ${formatDuration(latest.overBudgetMs)}`);
      }
      if (typeof latest?.finishedAt === "string") {
        summaryBits.push(`${currentLang === "zh" ? "完成于" : "finished"} ${formatDateTime(latest.finishedAt)}`);
      }
      if (typeof latest?.regressionCategory === "string" && latest.regressionCategory && latest.regressionCategory !== "none") {
        summaryBits.push(
          `${currentLang === "zh" ? "类别" : "category"} ${String(latest.regressionCategory)}`
        );
      }
      if (typeof latest?.failedStage === "string" && latest.failedStage) {
        summaryBits.push(`${currentLang === "zh" ? "阶段" : "stage"} ${String(latest.failedStage)}`);
      }
      if (typeof latest?.failedStageBudgetMs === "number") {
        summaryBits.push(`${currentLang === "zh" ? "阶段预算" : "stage budget"} ${formatDuration(latest.failedStageBudgetMs)}`);
      }
      if (typeof latest?.failedStageOverBudgetMs === "number" && latest.failedStageOverBudgetMs > 0) {
        summaryBits.push(`${currentLang === "zh" ? "阶段超预算" : "stage over budget"} ${formatDuration(latest.failedStageOverBudgetMs)}`);
      }
      if (typeof latest?.stateCompleteness === "boolean") {
        summaryBits.push(
          latest.stateCompleteness
            ? currentLang === "zh"
              ? "状态完整"
              : "state complete"
            : currentLang === "zh"
              ? "状态缺失"
              : "state incomplete"
        );
      }
      if (latest?.projectBoardSummary && typeof latest.projectBoardSummary === "object") {
        const board = latest.projectBoardSummary;
        if (typeof board.blockedTasks === "number" || typeof board.awaitingInputTasks === "number") {
          summaryBits.push(
            `${
              currentLang === "zh" ? "阻塞" : "blocked"
            } ${Number(board.blockedTasks ?? 0)} / ${currentLang === "zh" ? "待补充" : "awaiting"} ${Number(
              board.awaitingInputTasks ?? 0
            )}`
          );
        }
      }
      return `
        <article class="list-card compact">
          <div class="list-head">
            <strong>${escapeHtml(String(suiteEntry?.suite ?? "unknown"))}</strong>
            <span>${escapeHtml(statusLabel)}${suiteGrade?.grade ? ` · ${escapeHtml(String(suiteGrade.grade))}` : ""}</span>
          </div>
          <p class="muted">${escapeHtml(summaryBits.join(" · ") || (currentLang === "zh" ? "暂无摘要" : "No summary"))}</p>
          ${
            suiteGrade
              ? `<div class="pill-row">
                  <span class="pill">grade:${escapeHtml(String(suiteGrade.grade || "unknown"))}</span>
                  ${
                    suiteGrade.failedInvariant
                      ? `<span class="pill">${escapeHtml(String(suiteGrade.failedInvariant))}</span>`
                      : ""
                  }
                  ${
                    typeof suiteGrade.handoffCoverage === "number"
                      ? `<span class="pill">handoff:${escapeHtml(String(suiteGrade.handoffCoverage))}</span>`
                      : ""
                  }
                  ${
                    typeof suiteGrade.approvalCoverage === "number"
                      ? `<span class="pill">approval:${escapeHtml(String(suiteGrade.approvalCoverage))}</span>`
                      : ""
                  }
                  ${
                    typeof suiteGrade.stateCompleteness === "boolean"
                      ? `<span class="pill">state:${suiteGrade.stateCompleteness ? "ok" : "missing"}</span>`
                      : ""
                  }
                </div>`
              : ""
          }
          ${
            typeof latest?.detail === "string" && latest.detail.trim()
              ? `<p><strong>${currentLang === "zh" ? "细节" : "Detail"}:</strong> ${escapeHtml(latest.detail.trim())}</p>`
              : ""
          }
          ${
            stageEntries.length > 0
              ? `<div class="memory-block">
                  <strong>${currentLang === "zh" ? "阶段摘要" : "Stage summary"}</strong>
                  <ul style="margin:8px 0 0 18px;padding:0;">${stageEntries
                    .map(([name, value]) => {
                      const bits = [];
                      if (value?.status) bits.push(String(value.status));
                      if (typeof value?.artifactCount === "number") bits.push(`artifacts ${value.artifactCount}`);
                      if (value?.deliverableMode) bits.push(String(value.deliverableMode));
                      if (value?.deliverableContractViolated === true) bits.push("contract violated");
                      return `<li>${escapeHtml(name)}${bits.length > 0 ? ` · ${escapeHtml(bits.join(" / "))}` : ""}</li>`;
                    })
                    .join("")}</ul>
                </div>`
              : ""
          }
          ${
            tail
              ? `<pre class="code-block" style="white-space:pre-wrap;margin-top:10px;">${escapeHtml(
                  tail.slice(-600)
                )}</pre>`
              : `<p class="muted">${currentLang === "zh" ? "暂无输出尾部" : "No output tail"}</p>`
          }
        </article>
      `;
    })
    .join("")}`;
}

function renderCrmBoard(board) {
  if (!crmBoardContainer) {
    return;
  }
  const summary = board?.summary || null;
  const overdueCadences = Array.isArray(board?.overdueCadences) ? board.overdueCadences : [];
  const activeLeads = Array.isArray(board?.activeLeads) ? board.activeLeads : [];
  const recentContacts = Array.isArray(board?.recentContacts) ? board.recentContacts : [];
  const contactOutcomes = board?.contactOutcomes && typeof board.contactOutcomes === "object" ? board.contactOutcomes : {};
  if (!summary && overdueCadences.length === 0 && activeLeads.length === 0) {
    crmBoardContainer.innerHTML = `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${currentLang === "zh" ? "暂无 CRM 数据" : "No CRM data yet"}</strong>
          <span>0</span>
        </div>
        <p class="muted">${
          currentLang === "zh"
            ? "创建线索和 cadence 后，这里会显示跟进健康度与到期任务。"
            : "Create leads and cadences to see follow-up health and due tasks here."
        }</p>
      </article>
    `;
    return;
  }

  const overviewCard = `
    <article class="list-card compact">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "CRM 概览" : "CRM overview"}</strong>
        <span>${escapeHtml(String(summary?.activeCadences ?? 0))}</span>
      </div>
      <p class="muted">${
        currentLang === "zh"
          ? `活跃线索 ${Number(summary?.activeLeads ?? 0)} · 活跃 cadence ${Number(summary?.activeCadences ?? 0)}`
          : `active leads ${Number(summary?.activeLeads ?? 0)} · active cadences ${Number(summary?.activeCadences ?? 0)}`
      }</p>
      <p class="muted">${
        currentLang === "zh"
          ? `到期 cadence ${Number(summary?.overdueCadences ?? 0)} · 完成 cadence ${Number(summary?.completedCadences ?? 0)} · 关联项目 ${Number(summary?.projectLinkedLeads ?? 0)}`
          : `overdue cadences ${Number(summary?.overdueCadences ?? 0)} · linked projects ${Number(
              summary?.projectLinkedLeads ?? 0
            )} · completed cadences ${Number(summary?.completedCadences ?? 0)}`
      }</p>
      <p class="muted">${
        currentLang === "zh"
          ? `联系记录 ${Number(summary?.totalContacts ?? 0)} · 正向反馈 ${Number(summary?.positiveContacts ?? 0)}`
          : `contacts ${Number(summary?.totalContacts ?? 0)} · positive ${Number(summary?.positiveContacts ?? 0)}`
      }</p>
      <p class="muted">${
        summary?.lastRunAt
          ? currentLang === "zh"
            ? `最近运行 ${formatDateTime(summary.lastRunAt)}`
            : `last run ${formatDateTime(summary.lastRunAt)}`
          : currentLang === "zh"
            ? "暂无运行记录"
            : "no recent runs"
      }</p>
    </article>
  `;

  const overdueCards = overdueCadences.slice(0, 8).map((cadence) => {
    const objective = typeof cadence?.objective === "string" ? cadence.objective : "";
    const label = typeof cadence?.label === "string" ? cadence.label : "cadence";
    const leadId = typeof cadence?.leadId === "string" ? cadence.leadId : "lead";
    const nextRunAt = typeof cadence?.nextRunAt === "string" ? cadence.nextRunAt : "";
    return `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(nextRunAt || (currentLang === "zh" ? "已到期" : "due"))}</span>
        </div>
        <p class="muted">${escapeHtml(leadId)} · ${escapeHtml(String(cadence?.channel ?? "manual"))}</p>
        <p>${escapeHtml(objective || (currentLang === "zh" ? "无目标描述" : "No objective"))}</p>
      </article>
    `;
  });

  const leadCards = activeLeads.slice(0, 8).map((lead) => {
    const name = typeof lead?.name === "string" ? lead.name : "lead";
    const stage = typeof lead?.stage === "string" ? lead.stage : "new";
    const summaryText = typeof lead?.latestSummary === "string" ? lead.latestSummary : "";
    return `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(stage)}</span>
        </div>
        <p class="muted">${escapeHtml(String(lead?.source ?? "manual"))}${
          lead?.linkedProjectId ? ` · ${escapeHtml(String(lead.linkedProjectId))}` : ""
        }</p>
        <p>${escapeHtml(summaryText || (currentLang === "zh" ? "暂无摘要" : "No summary"))}</p>
      </article>
    `;
  });

  const contactCards = recentContacts.slice(0, 4).map((contact) => {
    const summaryText = typeof contact?.summary === "string" ? contact.summary : "";
    const outcome = typeof contact?.outcome === "string" ? contact.outcome : "note";
    const happenedAt = typeof contact?.happenedAt === "string" ? contact.happenedAt : "";
    return `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${escapeHtml(outcome)}</strong>
          <span>${escapeHtml(String(contact?.channel ?? "manual"))}</span>
        </div>
        <p class="muted">${escapeHtml(happenedAt ? formatDateTime(happenedAt) : currentLang === "zh" ? "无时间" : "No timestamp")}</p>
        <p>${escapeHtml(summaryText || (currentLang === "zh" ? "暂无摘要" : "No summary"))}</p>
      </article>
    `;
  });

  const outcomeSummary = Object.entries(contactOutcomes)
    .slice(0, 6)
    .map(([outcome, count]) => `<span class="pill">${escapeHtml(outcome)} · ${Number(count)}</span>`)
    .join("");

  const recentRuns = Array.isArray(board?.history?.recentRuns) ? board.history.recentRuns : [];
  const recentRunCards = recentRuns.slice(0, 4).map((run) => {
    const title = typeof run?.title === "string" ? run.title : run?.cadenceId || "run";
    const status = typeof run?.status === "string" ? run.status : "unknown";
    const triggeredAt = typeof run?.triggeredAt === "string" ? run.triggeredAt : "";
    return `
      <article class="list-card compact">
        <div class="list-head">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(status)}</span>
        </div>
        <p class="muted">${escapeHtml(String(run?.cadenceId ?? "-"))}</p>
        <p>${escapeHtml(triggeredAt ? formatDateTime(triggeredAt) : currentLang === "zh" ? "无时间" : "No timestamp")}</p>
      </article>
    `;
  });

  crmBoardContainer.innerHTML = `
    ${overviewCard}
    ${
      overdueCards.length > 0
        ? overdueCards.join("")
        : `<article class="list-card compact"><div class="list-head"><strong>${
            currentLang === "zh" ? "到期跟进" : "Due follow-ups"
          }</strong><span>0</span></div><p class="muted">${
            currentLang === "zh" ? "当前没有到期 cadence。" : "No overdue cadences right now."
          }</p></article>`
    }
    ${
      leadCards.length > 0
        ? leadCards.join("")
        : `<article class="list-card compact"><div class="list-head"><strong>${
            currentLang === "zh" ? "活跃线索" : "Active leads"
          }</strong><span>0</span></div><p class="muted">${
            currentLang === "zh" ? "当前没有活跃线索。" : "No active leads right now."
          }</p></article>`
    }
    <article class="list-card compact">
      <div class="list-head">
        <strong>${currentLang === "zh" ? "联系结果分布" : "Contact outcomes"}</strong>
        <span>${Number(summary?.totalContacts ?? 0)}</span>
      </div>
      <div class="pill-row">${outcomeSummary || `<span class="pill">${currentLang === "zh" ? "暂无记录" : "No records"}</span>`}</div>
    </article>
    ${
      contactCards.length > 0
        ? contactCards.join("")
        : `<article class="list-card compact"><div class="list-head"><strong>${
            currentLang === "zh" ? "最近联系" : "Recent contacts"
          }</strong><span>0</span></div><p class="muted">${
            currentLang === "zh" ? "当前没有联系记录。" : "No contact records yet."
          }</p></article>`
    }
    ${
      recentRunCards.length > 0
        ? recentRunCards.join("")
        : `<article class="list-card compact"><div class="list-head"><strong>${
            currentLang === "zh" ? "最近运行" : "Recent recurring runs"
          }</strong><span>0</span></div><p class="muted">${
            currentLang === "zh" ? "当前没有运行记录。" : "No recurring runs yet."
          }</p></article>`
    }
  `;
}

async function refresh() {
  const [dashboard, rolesPayload, channelsPayload, providersPayload, projectBoardPayload, goalRunsPayload, harnessPayload, telemetryPayload, runtimeHarnessPayload, harnessGradesPayload, crmBoardPayload] = await Promise.all([
    request("/api/dashboard"),
    request("/api/roles"),
    request("/api/channels/status").catch(() => null),
    request("/api/tool-providers").catch(() => null),
    request("/api/project-board").catch(() => null),
    request("/api/goal-runs?limit=40").catch(() => []),
    request("/api/system/harness").catch(() => null),
    request("/api/system/telemetry").catch(() => null),
    request("/api/system/runtime-harness").catch(() => null),
    request("/api/system/harness/grades").catch(() => null),
    request("/api/crm/dashboard").catch(() => null)
  ]);

  renderRoles(rolesPayload);
  renderApprovals(dashboard.approvals);
  renderTasks(dashboard.tasks);
  renderToolRuns(dashboard.toolRuns || []);
  renderAudit(dashboard.auditEvents);
  renderConfig(dashboard.config);
  renderRoutingTemplates(dashboard.routingTemplates || []);
  renderQueueMetrics(dashboard.queueMetrics);
  renderChannelsStatus(channelsPayload);
  renderProviderStatus(providersPayload);
  renderProjectMemoryBoard(projectBoardPayload);
  window._lastGoalRuns = Array.isArray(goalRunsPayload) ? goalRunsPayload : [];
  renderGoalRuns(window._lastGoalRuns);
  lastRuntimeHarnessPayload = runtimeHarnessPayload;
  renderHarnessBoard(harnessPayload, harnessGradesPayload, runtimeHarnessPayload);
  renderCrmBoard(crmBoardPayload);
  renderSkillsMarketResults(lastSkillsMarketResults);
  renderTelemetryBoard(telemetryPayload, runtimeHarnessPayload);
  if (selectedGoalRunId) {
    openGoalRunDetail(selectedGoalRunId, { background: true }).catch(() => null);
  }
}

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const viewId = button.getAttribute("data-view");
    setView(viewId);
  });
});

langButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const lang = button.getAttribute("data-lang-switch");
    await setLanguage(lang);
  });
});

// Filter tabs — approvals
document.querySelectorAll("#approval-filters .filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#approval-filters .filter-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    approvalFilter = tab.getAttribute("data-filter");
    renderApprovals(window._lastApprovals || []);
  });
});

// Filter tabs — tasks
document.querySelectorAll("#task-filters .filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#task-filters .filter-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    taskFilter = tab.getAttribute("data-filter");
    renderTasks(window._lastTasks || []);
  });
});

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    text: document.querySelector("#message-text").value,
    requestedBy: document.querySelector("#message-user").value,
    source: "control-center"
  };

  const result = await request("/api/messages", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  messageResult.textContent = result.message;
  event.target.reset();
  document.querySelector("#message-user").value = "owner";
  await refresh();
});

document.querySelector("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const attachments = buildAttachments();
  const payload = {
    source: "control-center",
    roleId: document.querySelector("#task-role").value,
    title: document.querySelector("#task-title").value,
    instruction: document.querySelector("#task-instruction").value,
    requestedBy: document.querySelector("#task-requested-by").value,
    metadata: attachments.length > 0 ? { attachments } : {}
  };

  const result = await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  taskResult.textContent = t("form.queuedTask", { id: result.id, roleId: result.roleId });
  event.target.reset();
  document.querySelector("#task-requested-by").value = "owner";
  await refresh();
});

workflowShortcutContainer?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-workflow-preset]") : null;
  if (!target) {
    return;
  }
  applyWorkflowPreset(target.getAttribute("data-workflow-preset") || "");
});

document.querySelector("#crm-run-due-btn")?.addEventListener("click", async () => {
  try {
    const result = await request("/api/recurring/run-due", {
      method: "POST"
    });
    const recurring = result?.crm ?? result;
    if (crmRunDueResult) {
      crmRunDueResult.textContent =
        currentLang === "zh"
          ? `已处理到期 cadence：${Number(recurring?.summary?.triggered ?? 0)} 条，跳过 ${Number(recurring?.summary?.skipped ?? 0)} 条。`
          : `Processed due cadences: ${Number(recurring?.summary?.triggered ?? 0)} triggered, ${Number(
              recurring?.summary?.skipped ?? 0
            )} skipped.`;
    }
    await refresh();
  } catch (error) {
    if (crmRunDueResult) {
      crmRunDueResult.textContent = error instanceof Error ? error.message : String(error);
    }
  }
});

document.querySelector("#skills-market-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = document.querySelector("#skills-market-query")?.value?.trim() || "";
  const roleId = skillsMarketRoleSelect?.value || "";
  if (!query) {
    skillsMarketResult.textContent =
      currentLang === "zh" ? "请输入要搜索的 skill 关键词。" : "Enter a keyword to search skills.";
    renderSkillsMarketResults([]);
    return;
  }

  skillsMarketResult.textContent = currentLang === "zh" ? "正在搜索 skill..." : "Searching skills...";
  try {
    const payload = await request(
      `/api/skills/market/search?q=${encodeURIComponent(query)}&limit=8&roleId=${encodeURIComponent(roleId)}`
    );
    const results = Array.isArray(payload?.results) ? payload.results : [];
    renderSkillsMarketResults(results);
    skillsMarketResult.textContent =
      currentLang === "zh"
        ? `已为角色 ${roleId || "-"} 找到 ${results.length} 个候选 skill。`
        : `Found ${results.length} skill candidates for role ${roleId || "-"}.`;
  } catch (error) {
    renderSkillsMarketResults([]);
    skillsMarketResult.textContent = error instanceof Error ? error.message : String(error);
  }
});

document.querySelector("#queue-sla-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const warningMinutes = Number(document.querySelector("#queue-warning-min").value);
  const criticalMinutes = Number(document.querySelector("#queue-critical-min").value);
  if (!Number.isFinite(warningMinutes) || !Number.isFinite(criticalMinutes)) {
    queueSlaResult.textContent = t("form.slaMustNumber");
    return;
  }

  if (warningMinutes < 0 || criticalMinutes <= warningMinutes) {
    queueSlaResult.textContent = t("form.criticalGreater");
    return;
  }

  await request("/api/config/queue-sla", {
    method: "PUT",
    body: JSON.stringify({
      warningWaitMs: Math.round(warningMinutes * 60 * 1000),
      criticalWaitMs: Math.round(criticalMinutes * 60 * 1000)
    })
  });
  queueSlaResult.textContent = t("form.queueUpdated", { warning: warningMinutes, critical: criticalMinutes });
  await refresh();
});

document.querySelector("#template-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const templateId = document.querySelector("#template-id").value.trim();
  const tasksRaw = document.querySelector("#template-tasks").value.trim();
  let tasks = [];

  try {
    const parsed = JSON.parse(tasksRaw || "[]");
    if (!Array.isArray(parsed)) {
      throw new Error("tasks must be an array");
    }
    tasks = parsed;
  } catch (error) {
    templateResult.textContent = t("form.invalidTasksJson", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const payload = {
    name: document.querySelector("#template-name").value.trim(),
    description: document.querySelector("#template-description").value.trim(),
    triggerKeywords: parseKeywords(document.querySelector("#template-keywords").value),
    matchMode: document.querySelector("#template-mode").value,
    enabled: true,
    tasks
  };

  if (templateId) {
    await request(`/api/routing-templates/${templateId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    templateResult.textContent = t("form.updatedTemplate", { id: templateId });
  } else {
    const created = await request("/api/routing-templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    templateResult.textContent = t("form.createdTemplate", { id: created.id });
  }

  resetTemplateForm();
  await refresh();
});

document.querySelector("#template-reset").addEventListener("click", () => {
  resetTemplateForm();
  templateResult.textContent = "";
});

document.querySelector("#template-export").addEventListener("click", async () => {
  const payload = await request("/api/routing-templates/export");
  document.querySelector("#template-json-io").value = JSON.stringify(payload, null, 2);
  templateResult.textContent = t("form.exportedTemplates", {
    count: Array.isArray(payload.templates) ? payload.templates.length : 0
  });
});

document.querySelector("#template-import").addEventListener("click", async () => {
  const raw = document.querySelector("#template-json-io").value.trim();
  if (!raw) {
    templateResult.textContent = t("form.emptyTemplateJson");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    templateResult.textContent = t("form.invalidImportJson", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const templates = Array.isArray(parsed) ? parsed : parsed?.templates;
  if (!Array.isArray(templates)) {
    templateResult.textContent = t("form.importMustArray");
    return;
  }

  const mode = document.querySelector("#template-import-mode").value === "replace" ? "replace" : "merge";
  const result = await request("/api/routing-templates/import", {
    method: "POST",
    body: JSON.stringify({
      mode,
      templates
    })
  });

  templateResult.textContent = t("form.importedTemplates", { mode, count: result.count });
  await refresh();
});

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const skillInstallButton = target ? target.closest("[data-skill-install]") : null;
  const skillReadyInstallButton = target ? target.closest("[data-skill-install-ready]") : null;
  const skillIntegrationButton = target ? target.closest("[data-skill-request-integration]") : null;
  const approveId = target ? target.getAttribute("data-approve") : null;
  const rejectId = target ? target.getAttribute("data-reject") : null;
  const templateEditId = target ? target.getAttribute("data-template-edit") : null;
  const templateToggleId = target ? target.getAttribute("data-template-toggle") : null;
  const templateDeleteId = target ? target.getAttribute("data-template-delete") : null;
  const taskDetailId = target ? target.closest("[data-task-detail]")?.getAttribute("data-task-detail") : null;
  const closeTaskDetail = target ? target.closest("[data-task-detail-close]") : null;
  const goalRunDetailId = target ? target.closest("[data-goal-run-detail]")?.getAttribute("data-goal-run-detail") : null;
  const closeGoalRunDetail = target ? target.closest("[data-goal-run-detail-close]") : null;
  const goalRunTaskId = target ? target.closest("[data-goal-run-open-task]")?.getAttribute("data-goal-run-open-task") : null;

  if (skillReadyInstallButton) {
    const skillId = skillReadyInstallButton.getAttribute("data-skill-install-ready") || "";
    const roleId =
      skillReadyInstallButton.getAttribute("data-skill-install-role") || skillsMarketRoleSelect?.value || "";
    if (!skillId || !roleId) {
      skillsMarketResult.textContent =
        currentLang === "zh" ? "缺少可安装的 skill 或目标角色。" : "Missing installable skill or target role.";
      return;
    }
    skillReadyInstallButton.setAttribute("disabled", "true");
    skillsMarketResult.textContent =
      currentLang === "zh" ? `正在安装 ${skillId} 到 ${roleId}...` : `Installing ${skillId} to ${roleId}...`;
    try {
      const result = await request("/api/skills/market/install", {
        method: "POST",
        body: JSON.stringify({
          skillId,
          roleId,
          installedBy: inferInstalledBy()
        })
      });
      skillsMarketResult.textContent =
        currentLang === "zh"
          ? `已安装 ${result?.skill?.skillId || skillId} 到 ${result?.roleId || roleId}。${
              result?.verifyTask?.id ? `已创建验证任务 ${String(result.verifyTask.id).slice(0, 8)}。` : ""
            }`
          : `Installed ${result?.skill?.skillId || skillId} to ${result?.roleId || roleId}.${
              result?.verifyTask?.id ? ` Verification task ${String(result.verifyTask.id).slice(0, 8)} created.` : ""
            }`;
      await refresh();
    } catch (error) {
      skillsMarketResult.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      skillReadyInstallButton.removeAttribute("disabled");
    }
    return;
  }

  if (skillInstallButton) {
    const skillId = skillInstallButton.getAttribute("data-skill-install") || "";
    const roleId = skillsMarketRoleSelect?.value || "";
    if (!skillId || !roleId) {
      skillsMarketResult.textContent =
        currentLang === "zh" ? "请选择目标角色后再安装 skill。" : "Choose a target role before installing the skill.";
      return;
    }

    skillInstallButton.setAttribute("disabled", "true");
    skillsMarketResult.textContent =
      currentLang === "zh" ? `正在安装 ${skillId} 到 ${roleId}...` : `Installing ${skillId} to ${roleId}...`;
    try {
      const result = await request("/api/skills/market/install", {
        method: "POST",
        body: JSON.stringify({
          skillId,
          roleId,
          installedBy: inferInstalledBy()
        })
      });
      skillsMarketResult.textContent =
        currentLang === "zh"
          ? `已安装 ${result?.skill?.skillId || skillId} 到 ${result?.roleId || roleId}。${
              result?.verifyTask?.id ? `已创建验证任务 ${String(result.verifyTask.id).slice(0, 8)}。` : ""
            }`
          : `Installed ${result?.skill?.skillId || skillId} to ${result?.roleId || roleId}.${
              result?.verifyTask?.id ? ` Verification task ${String(result.verifyTask.id).slice(0, 8)} created.` : ""
            }`;
      await refresh();
    } catch (error) {
      skillsMarketResult.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      skillInstallButton.removeAttribute("disabled");
    }
    return;
  }

  if (skillIntegrationButton) {
    const skillId = skillIntegrationButton.getAttribute("data-skill-request-integration") || "";
    if (!skillId) {
      return;
    }
    skillIntegrationButton.setAttribute("disabled", "true");
    skillsMarketResult.textContent =
      currentLang === "zh" ? `正在为 ${skillId} 创建接入任务...` : `Creating integration task for ${skillId}...`;
    try {
      const result = await request("/api/skills/market/request-integration", {
        method: "POST",
        body: JSON.stringify({
          skillId,
          targetRoleId: skillsMarketRoleSelect?.value || "",
          requestedBy: inferInstalledBy(),
          source: "control-center"
        })
      });
      skillsMarketResult.textContent = result?.message || (currentLang === "zh" ? "已创建接入任务。" : "Integration task created.");
      await refresh();
    } catch (error) {
      skillsMarketResult.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      skillIntegrationButton.removeAttribute("disabled");
    }
    return;
  }

  if (closeTaskDetail) {
    selectedTaskId = "";
    selectedTaskDetail = null;
    renderTaskDetail("", null);
    return;
  }

  if (closeGoalRunDetail) {
    selectedGoalRunId = "";
    selectedGoalRunDetail = null;
    renderGoalRunDetail("", null);
    renderGoalRuns(window._lastGoalRuns || []);
    return;
  }

  if (goalRunTaskId) {
    await openTaskDetail(goalRunTaskId);
    return;
  }

  if (taskDetailId) {
    try {
      await openTaskDetail(taskDetailId);
    } catch (error) {
      taskResult.textContent = error instanceof Error ? error.message : String(error);
    }
    return;
  }

  if (goalRunDetailId) {
    try {
      await openGoalRunDetail(goalRunDetailId);
    } catch (error) {
      if (goalRunDetailContainer) {
        goalRunDetailContainer.innerHTML = `<p class="muted" style="padding:16px;color:var(--red);">${escapeHtml(
          error instanceof Error ? error.message : String(error)
        )}</p>`;
        goalRunDetailContainer.classList.remove("is-hidden");
      }
    }
    return;
  }

  if (templateEditId || templateToggleId || templateDeleteId) {
    const templates = await request("/api/routing-templates");

    if (templateEditId) {
      const template = templates.find((entry) => entry.id === templateEditId);
      if (template) {
        loadTemplateToForm(template);
        templateResult.textContent = t("form.editingTemplate", { id: template.id });
      }
      return;
    }

    if (templateToggleId) {
      const enabled = event.target.getAttribute("data-template-enabled") === "true";
      await request(`/api/routing-templates/${templateToggleId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !enabled })
      });
      templateResult.textContent = !enabled
        ? t("form.enabledTemplate", { id: templateToggleId })
        : t("form.disabledTemplate", { id: templateToggleId });
      await refresh();
      return;
    }

    if (templateDeleteId) {
      await request(`/api/routing-templates/${templateDeleteId}`, {
        method: "DELETE"
      });
      templateResult.textContent = t("form.deletedTemplate", { id: templateDeleteId });
      await refresh();
      return;
    }
  }

  if (!approveId && !rejectId) {
    return;
  }

  const approvalId = approveId || rejectId;
  const status = approveId ? "approved" : "rejected";

  await request(`/api/approvals/${approvalId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      status,
      decidedBy: "owner"
    })
  });

  await refresh();
});

applyI18n();
setView(currentView);
langButtons.forEach((button) => {
  button.classList.toggle("active", button.getAttribute("data-lang-switch") === currentLang);
});

// ─── Telemetry ──────────────────────────────────────────────────────────

function buildHarnessAssessmentFromTrace(trace) {
  const metrics = trace?.metrics || {};
  const blockedToolCalls = Array.isArray(trace?.turns)
    ? trace.turns.reduce(
        (sum, turn) =>
          sum +
          ((Array.isArray(turn.toolCalls) ? turn.toolCalls : []).filter((call) => typeof call.blocked === "string" && call.blocked.trim()).length),
        0
      )
    : 0;
  const totalToolCalls = Number(metrics.toolCalls || 0);
  const failedTools = Array.isArray(trace?.turns)
    ? trace.turns.reduce(
        (sum, turn) =>
          sum +
          ((Array.isArray(turn.toolCalls) ? turn.toolCalls : []).filter((call) => String(call.output || "").toLowerCase().includes("error")).length),
        0
      )
    : 0;
  return {
    grade:
      totalToolCalls > 0 && blockedToolCalls === 0 && Number(metrics.errors || 0) === 0
        ? "A"
        : blockedToolCalls === 0
          ? "B"
          : blockedToolCalls <= 1
            ? "C"
            : "D",
    score: Math.max(
      0,
      Math.min(
        100,
        72 +
          Math.min(20, Number(trace?.turns?.length || 0) * 4) +
          Math.min(8, totalToolCalls * 2) -
          blockedToolCalls * 10 -
          Number(metrics.errors || 0) * 8 -
          failedTools * 4
      )
    ),
    status: blockedToolCalls > 1 ? "partial" : Number(metrics.errors || 0) > 0 ? "good" : "strong",
    summary: blockedToolCalls > 0 ? "trace-with-guardrail-events" : "trace-clean",
    strengths: [
      "trace_recorded",
      ...(trace?.turns?.length > 0 ? ["multi_turn_observed"] : []),
      ...(totalToolCalls > 0 ? ["tool_usage_observed"] : [])
    ],
    gaps: [
      ...(blockedToolCalls > 0 ? ["blocked_tool_calls_present"] : []),
      ...(Number(metrics.errors || 0) > 0 ? ["execution_errors_present"] : [])
    ],
    dimensions: {
      context: trace?.instruction ? 8 : 0,
      runtime: trace?.backendUsed || trace?.turns?.[0]?.backendUsed ? 16 : 8,
      skills: 0,
      governance: Math.max(0, 12 - blockedToolCalls * 4),
      observability: 24,
      delivery: totalToolCalls > 0 ? 16 : 8
    }
  };
}

function renderTelemetryBoard(payload, runtimeHarnessPayload) {
  if (!telemetryBoardContainer) return;

  const traces = payload?.traces ?? [];
  if (traces.length === 0) {
    telemetryBoardContainer.innerHTML = `${renderRuntimeHarnessBoard(runtimeHarnessPayload)}<p class="muted" style="text-align:center;padding:24px 0;">${t("trace.noTrace")}</p>`;
    if (traceDetailContainer) {
      traceDetailContainer.classList.add("is-hidden");
      traceDetailContainer.innerHTML = "";
    }
    return;
  }

  let html = `${renderRuntimeHarnessBoard(runtimeHarnessPayload)}${traces.map((trace) => {
    const m = trace.metrics || {};
    const status = trace.completedAt ? "completed" : "running";
    const statusBadgeHtml = `<span class="pill status-${status}">${status}</span>`;
    const harness = buildHarnessAssessmentFromTrace(trace);
    const timeStr = trace.startedAt ? new Date(trace.startedAt).toLocaleTimeString() : "";

    return `
      <article class="list-card" style="cursor:pointer" data-trace-id="${escapeHtml(trace.taskId)}">
        <div class="list-head">
          <strong>${escapeHtml(trace.instruction.slice(0, 80))}${trace.instruction.length > 80 ? "..." : ""}</strong>
          ${statusBadgeHtml}
        </div>
        <p class="muted">${escapeHtml(trace.roleId)} · ${timeStr}</p>
        <div class="pill-row">
          ${renderHarnessGradeBadge(harness)}
          <span class="pill">rounds:${trace.turns.length}</span>
          <span class="pill">tokens:${m.totalTokens ?? 0}</span>
          <span class="pill">tools:${m.toolCalls ?? 0}</span>
          ${m.roundsBlocked > 0 ? `<span class="pill" style="background:var(--red-soft);color:var(--red)">blocked:${m.roundsBlocked}</span>` : ""}
        </div>
      </article>
    `;
  }).join("")}`;

  telemetryBoardContainer.innerHTML = html;
  if (traceDetailContainer) {
    traceDetailContainer.classList.add("is-hidden");
    traceDetailContainer.innerHTML = "";
  }

  telemetryBoardContainer.querySelectorAll("[data-trace-id]").forEach((card) => {
    card.addEventListener("click", () => {
      loadTraceDetail(card.getAttribute("data-trace-id"));
    });
  });
}

async function loadTraceDetail(taskId) {
  if (!traceDetailContainer) return;

  try {
    const trace = await request(`/api/tasks/${taskId}/trace`);
    renderTraceDetail(trace);
  } catch (err) {
    traceDetailContainer.innerHTML = `<p class="muted" style="padding:16px;color:var(--red);">${t("trace.noData")} ${escapeHtml(err.message || "")}</p>`;
    traceDetailContainer.classList.remove("is-hidden");
  }
}

function renderTraceDetail(trace) {
  if (!traceDetailContainer) return;

  const m = trace.metrics || {};
  const turns = trace.turns || [];
  const harness = buildHarnessAssessmentFromTrace(trace);

  const turnsHtml = turns.map((turn) => {
    const toolTags = turn.toolCalls.map((tc) => {
      if (tc.blocked) {
        return `<span class="tool-tag blocked" title="${escapeHtml(tc.blocked)}">${escapeHtml(tc.toolName)} (blocked)</span>`;
      }
      return `<span class="tool-tag">${escapeHtml(tc.toolName)}</span>`;
    }).join("");

    return `
      <div class="trace-turn">
        <div class="turn-round">${t("trace.round", { round: turn.round })} · ${turn.backendUsed} · ${turn.modelUsed} · ${turn.durationMs > 0 ? turn.durationMs + "ms" : ""}</div>
        <div class="turn-output">${escapeHtml(turn.modelOutputSummary.slice(0, 500))}</div>
        ${toolTags ? `<div class="turn-tools">${toolTags}</div>` : ""}
      </div>
    `;
  }).join("");

  traceDetailContainer.innerHTML = `
    <div class="trace-detail-panel">
      <div class="trace-header">
        <h3>${escapeHtml(trace.instruction.slice(0, 100))}</h3>
        <div class="trace-meta">
          ${trace.roleId} · started ${new Date(trace.startedAt).toLocaleString()}
          ${trace.completedAt ? " → completed " + new Date(trace.completedAt).toLocaleString() : " (running)"}
        </div>
      </div>
      ${renderHarnessBlock(harness, { title: currentLang === "zh" ? "Trace Harness Grade" : "Trace Harness Grade" })}
      <div class="trace-metrics">
        <span class="trace-metric"><strong>Token</strong> ${m.totalTokens ?? 0}</span>
        <span class="trace-metric"><strong>Tool</strong> ${m.toolCalls ?? 0}</span>
        <span class="trace-metric"><strong>Blocked</strong> ${m.roundsBlocked ?? 0}</span>
        <span class="trace-metric"><strong>Duration</strong> ${m.durationMs ? (m.durationMs / 1000).toFixed(1) + "s" : "N/A"}</span>
      </div>
      <div class="trace-timeline">${turnsHtml || `<p class="muted" style="padding:16px">${t("trace.noData")}</p>`}</div>
      <button class="trace-back" id="trace-back-btn">${t("trace.back")}</button>
    </div>
  `;
  traceDetailContainer.classList.remove("is-hidden");

  document.getElementById("trace-back-btn").addEventListener("click", () => {
    traceDetailContainer.classList.add("is-hidden");
    traceDetailContainer.innerHTML = "";
  });
}

// 汉堡菜单交互
if (menuToggle && viewNav) {
  menuToggle.addEventListener("click", () => {
    viewNav.classList.toggle("is-open");
  });

  // 点击导航按钮后自动收起菜单
  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      viewNav.classList.remove("is-open");
    });
  });
}

resetTemplateForm();

async function initAuth() {
  const loggedIn = await validateSession();
  if (!loggedIn) {
    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
    return;
  }

  const user = getCurrentUser();
  if (user) {
    const displayNameEl = document.querySelector("#user-display-name");
    if (displayNameEl) {
      displayNameEl.textContent = user.displayName || user.username;
    }
  }

  const logoutBtn = document.querySelector("#logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (confirm(currentLang === "zh" ? "确定要退出登录吗？" : "Are you sure you want to logout?")) {
        await logout();
        window.location.href = "/login.html";
      }
    });
  }

  await refresh();
  setInterval(refresh, 5000);
}

initAuth();
