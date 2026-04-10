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
const messageResult = document.querySelector("#message-result");
const taskResult = document.querySelector("#task-result");
const routingTemplatesContainer = document.querySelector("#routing-templates");
const templateResult = document.querySelector("#template-result");
const queueOverviewContainer = document.querySelector("#queue-overview");
const queueAlertsContainer = document.querySelector("#queue-alerts");
const queueByRoleContainer = document.querySelector("#queue-by-role");
const queueByTemplateContainer = document.querySelector("#queue-by-template");
const queueSlaResult = document.querySelector("#queue-sla-result");
const channelsStatusContainer = document.querySelector("#channels-status");
const providersStatusContainer = document.querySelector("#providers-status");
const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const viewPanels = Array.from(document.querySelectorAll(".view-panel"));
const langButtons = Array.from(document.querySelectorAll(".lang-btn"));
const menuToggle = document.querySelector(".menu-toggle");
const viewNav = document.querySelector(".view-nav");

const I18N = {
  zh: {
    "app.title": "VinkoClaw 指挥中心",
    "nav.workbench": "工作台",
    "nav.routing": "模板与队列",
    "nav.config": "团队与渠道",
    "nav.execution": "审批与执行",
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

const VIEW_IDS = new Set(["workbench", "routing", "config", "execution", "audit"]);
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
  roleSelect.innerHTML = payload.roles
    .map((role) => `<option value="${role.id}">${role.name}</option>`)
    .join("");

  rolesContainer.innerHTML = payload.roles
    .map((role) => {
      const skills = role.skills.length
        ? role.skills
            .map((skill) => `<span class="pill">${escapeHtml(skill.skillId)}</span>`)
            .join("")
        : `<span class="muted">${t("common.skillsEmpty")}</span>`;

      return `
        <article class="role-card">
          <div class="role-head">
            <h3>${escapeHtml(role.name)}</h3>
            <span>${escapeHtml(role.id)}</span>
          </div>
          <p>${escapeHtml(role.responsibility)}</p>
          <div class="pill-row">${skills}</div>
        </article>
      `;
    })
    .join("");
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
  if (s === "running" || s === "in_progress") return "running";
  if (s === "failed" || s === "error") return "failed";
  return s;
}

function renderTasks(tasks) {
  window._lastTasks = tasks;
  document.querySelector("#meta-tasks").textContent = t("meta.tasks", { count: tasks.length });

  let filtered = tasks;
  if (taskFilter !== "all") {
    filtered = tasks.filter((t) => taskStatusKey(t.status) === taskFilter);
  }

  if (filtered.length === 0) {
    tasksContainer.innerHTML = `<p class="muted" style="text-align:center;padding:24px 0;">${taskFilter === "all" ? "暂无任务" : `无${translateStatus(taskFilter)}状态的任务`}</p>`;
    return;
  }

  tasksContainer.innerHTML = filtered
    .map((task) => {
      const attachmentCount = Array.isArray(task.metadata?.attachments) ? task.metadata.attachments.length : 0;
      const status = statusBadge(task.status);
      const reflection = task.reflection
        ? `<p class="muted">${t("task.reflection", { score: task.reflection.score, confidence: task.reflection.confidence })}</p>`
        : "";

      // Format collaboration output by role sections
      let deliverable = "";
      const raw = task.result?.deliverable || "";
      if (raw) {
        const sections = raw.split(/\n(?=\【[^\]]+\】)/);
        if (sections.length > 1) {
          deliverable = sections.map((sec) => {
            const match = sec.match(/^\【([^\]]+)\】\s*(.*)/s);
            if (match) {
              return `<div class="collab-section"><div class="collab-role">${escapeHtml(match[1])}</div><p>${escapeHtml(match[2].trim())}</p></div>`;
            }
            return `<pre>${escapeHtml(sec.slice(0, 450))}</pre>`;
          }).join("");
        } else {
          deliverable = `<pre>${escapeHtml(raw.slice(0, 450))}</pre>`;
        }
      }

      return `
        <article class="list-card">
          <div class="list-head">
            <strong>${escapeHtml(task.title)}</strong>
            ${status}
          </div>
          <p class="muted">${escapeHtml(task.roleId)} · ${escapeHtml(task.source)} · ${attachmentCount} ${t("task.attachments")}</p>
          <p>${escapeHtml(task.instruction)}</p>
          ${reflection}
          ${deliverable}
        </article>
      `;
    })
    .join("");
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

async function refresh() {
  const [dashboard, rolesPayload, channelsPayload, providersPayload] = await Promise.all([
    request("/api/dashboard"),
    request("/api/roles"),
    request("/api/channels/status").catch(() => null),
    request("/api/tool-providers").catch(() => null)
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
  const approveId = event.target.getAttribute("data-approve");
  const rejectId = event.target.getAttribute("data-reject");
  const templateEditId = event.target.getAttribute("data-template-edit");
  const templateToggleId = event.target.getAttribute("data-template-toggle");
  const templateDeleteId = event.target.getAttribute("data-template-delete");

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
