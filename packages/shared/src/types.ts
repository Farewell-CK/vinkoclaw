export const ROLE_IDS = [
  "ceo",
  "cto",
  "product",
  "uiux",
  "frontend",
  "backend",
  "algorithm",
  "qa",
  "developer",
  "engineering",
  "research",
  "operations"
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export const SKILL_SCOPES = ["team", "role", "agent"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

export const TASK_STATUSES = [
  "queued",
  "running",
  "paused_input",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const OPERATOR_ACTION_KINDS = [
  "set_memory_backend",
  "install_skill",
  "disable_skill",
  "send_email",
  "set_channel_enabled",
  "set_tool_provider_config",
  "set_runtime_setting",
  "add_agent_instance",
  "remove_agent_instance",
  "set_agent_tone_policy"
] as const;
export type OperatorActionKind = (typeof OPERATOR_ACTION_KINDS)[number];

export type TaskSource = "control-center" | "feishu" | "email" | "system";
export type SessionSource = TaskSource;
export const CRM_LEAD_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export type CrmLeadStage = (typeof CRM_LEAD_STAGES)[number];
export const CRM_LEAD_STATUSES = ["active", "archived"] as const;
export type CrmLeadStatus = (typeof CRM_LEAD_STATUSES)[number];
export const CRM_CADENCE_STATUSES = ["active", "paused", "completed", "archived"] as const;
export type CrmCadenceStatus = (typeof CRM_CADENCE_STATUSES)[number];

export type MemoryBackend = "none" | "sqlite" | "vector-db";
export const DELIVERABLE_MODES = ["answer_only", "artifact_preferred", "artifact_required"] as const;
export type DeliverableMode = (typeof DELIVERABLE_MODES)[number];

export interface ProjectMemoryRecord {
  version: 1;
  currentGoal: string;
  currentStage: string;
  latestUserRequest: string;
  latestSummary: string;
  keyDecisions: string[];
  unresolvedQuestions: string[];
  nextActions: string[];
  latestArtifacts: string[];
  updatedAt: string;
  updatedBy: string;
  lastTaskId?: string | undefined;
  orchestrationMode?: "main_agent" | undefined;
  orchestrationOwnerRoleId?: RoleId | undefined;
  orchestrationVerificationStatus?: "pending" | "verified" | "failed" | undefined;
}


export interface ProjectMemoryUpdate {
  currentGoal?: string | undefined;
  currentStage?: string | undefined;
  latestUserRequest?: string | undefined;
  latestSummary?: string | undefined;
  keyDecisions?: string[] | undefined;
  unresolvedQuestions?: string[] | undefined;
  nextActions?: string[] | undefined;
  latestArtifacts?: string[] | undefined;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
  lastTaskId?: string | undefined;
  orchestrationMode?: "main_agent" | undefined;
  orchestrationOwnerRoleId?: RoleId | undefined;
  orchestrationVerificationStatus?: "pending" | "verified" | "failed" | undefined;
}

export interface ProjectBoardSummary {
  activeProjects: number;
  archivedProjects: number;
  blockedTasks: number;
  awaitingInputTasks: number;
  recentArtifacts: number;
  readyRoles: number;
  verificationDebtRoles: number;
  failedSkills: number;
  activeLeads: number;
  activeCadences: number;
  overdueCadences: number;
  linkedProjectLeads: number;
}

export interface ProjectBoardPrimaryView {
  sessionId: string;
  sessionTitle: string;
  source: SessionSource;
  updatedAt: string;
  currentGoal: string;
  currentStage: string;
  latestUserRequest: string;
  latestSummary: string;
  keyDecisions: string[];
  unresolvedQuestions: string[];
  nextActions: string[];
  latestArtifacts: string[];
  lastTaskId?: string | undefined;
  orchestrationMode?: "main_agent" | undefined;
  orchestrationOwnerRoleId?: RoleId | undefined;
  orchestrationVerificationStatus?: "pending" | "verified" | "failed" | undefined;
}

export interface ProjectBoardRoleReadiness {
  roleId: RoleId;
  roleName: string;
  responsibility: string;
  totalSkills: number;
  verifiedSkills: number;
  unverifiedSkills: number;
  failedSkills: number;
  ready: boolean;
  highlightedSkills: string[];
}

export interface ProjectBoardWorkstream {
  sessionId: string;
  sessionTitle: string;
  source: SessionSource;
  updatedAt: string;
  currentGoal: string;
  currentStage: string;
  latestSummary: string;
  unresolvedQuestions: string[];
  nextActions: string[];
  latestArtifacts: string[];
  orchestrationMode?: "main_agent" | undefined;
  orchestrationOwnerRoleId?: RoleId | undefined;
  orchestrationVerificationStatus?: "pending" | "verified" | "failed" | undefined;
}

export interface ProjectBoardProjectHistoryEntry {
  kind: "session" | "workspace";
  sessionId?: string | undefined;
  sessionTitle: string;
  source: SessionSource;
  updatedAt: string;
  stage: string;
  summary: string;
  artifacts: string[];
}

export interface ProjectBoardProject {
  id: string;
  name: string;
  stage: string;
  currentGoal: string;
  latestSummary: string;
  updatedAt: string;
  sourceSessionIds: string[];
  blockers: string[];
  nextActions: string[];
  latestArtifacts: string[];
  crmLeadCount: number;
  crmActiveCadences: number;
  crmOverdueCadences: number;
  history: ProjectBoardProjectHistoryEntry[];
}

export interface ProjectBoardSnapshot {
  generatedAt: string;
  summary: ProjectBoardSummary;
  primary: ProjectBoardPrimaryView | null;
  blockers: string[];
  pendingDecisions: string[];
  nextActions: string[];
  latestArtifacts: string[];
  teamReadiness: ProjectBoardRoleReadiness[];
  workstreams: ProjectBoardWorkstream[];
  projects: ProjectBoardProject[];
  archivedProjects: ProjectBoardProject[];
}

export interface ReflectionNote {
  score: number;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
  risks: string[];
  improvements: string[];
}

export interface TaskResult {
  summary: string;
  deliverable: string;
  citations: Citation[];
  followUps: string[];
}

export interface Citation {
  path: string;
  excerpt: string;
}

export interface TaskAttachment {
  kind: "image" | "video";
  url: string;
  detail?: "auto" | "low" | "high";
  name?: string;
}

export interface CrmLeadRecord {
  id: string;
  name: string;
  company?: string | undefined;
  title?: string | undefined;
  email?: string | undefined;
  source: string;
  stage: CrmLeadStage;
  status: CrmLeadStatus;
  tags: string[];
  latestSummary: string;
  nextAction?: string | undefined;
  ownerRoleId?: RoleId | undefined;
  linkedProjectId?: string | undefined;
  lastContactAt?: string | undefined;
  archivedAt?: string | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCrmLeadInput {
  name: string;
  company?: string | undefined;
  title?: string | undefined;
  email?: string | undefined;
  source: string;
  stage?: CrmLeadStage | undefined;
  tags?: string[] | undefined;
  latestSummary?: string | undefined;
  nextAction?: string | undefined;
  ownerRoleId?: RoleId | undefined;
  linkedProjectId?: string | undefined;
  lastContactAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateCrmLeadInput {
  name?: string | undefined;
  company?: string | undefined;
  title?: string | undefined;
  email?: string | undefined;
  source?: string | undefined;
  stage?: CrmLeadStage | undefined;
  status?: CrmLeadStatus | undefined;
  tags?: string[] | undefined;
  latestSummary?: string | undefined;
  nextAction?: string | undefined;
  ownerRoleId?: RoleId | undefined;
  linkedProjectId?: string | undefined;
  lastContactAt?: string | undefined;
  archivedAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface CrmCadenceRecord {
  id: string;
  leadId: string;
  label: string;
  channel: "feishu" | "email" | "manual";
  intervalDays: number;
  status: CrmCadenceStatus;
  objective: string;
  nextRunAt: string;
  lastRunAt?: string | undefined;
  ownerRoleId?: RoleId | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCrmCadenceInput {
  leadId: string;
  label: string;
  channel?: "feishu" | "email" | "manual" | undefined;
  intervalDays: number;
  objective: string;
  nextRunAt: string;
  ownerRoleId?: RoleId | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateCrmCadenceInput {
  label?: string | undefined;
  channel?: "feishu" | "email" | "manual" | undefined;
  intervalDays?: number | undefined;
  status?: CrmCadenceStatus | undefined;
  objective?: string | undefined;
  nextRunAt?: string | undefined;
  lastRunAt?: string | undefined;
  ownerRoleId?: RoleId | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TaskMetadata {
  attachments?: TaskAttachment[];
  [key: string]: unknown;
}

export interface StageHandoffArtifact {
  stage: GoalRunStage;
  taskId?: string | undefined;
  taskTraceId?: string | undefined;
  summary: string;
  artifacts: string[];
  decisions: string[];
  unresolvedQuestions: string[];
  nextActions: string[];
  approvalNeeds: string[];
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  sessionId?: string | undefined;
  source: TaskSource;
  roleId: RoleId;
  title: string;
  instruction: string;
  status: TaskStatus;
  priority: number;
  chatId?: string | undefined;
  requestedBy?: string | undefined;
  metadata: TaskMetadata;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  result?: TaskResult | undefined;
  reflection?: ReflectionNote | undefined;
  errorText?: string | undefined;
  /** Set when the task is paused awaiting user input. The worker detected that it needs more info. */
  pendingInput?: {
    question: string;
    pausedAt: string;
    context?: string | undefined;
  } | undefined;
}

export interface CreateTaskInput {
  sessionId?: string | undefined;
  source: TaskSource;
  roleId: RoleId;
  title: string;
  instruction: string;
  priority?: number | undefined;
  chatId?: string | undefined;
  requestedBy?: string | undefined;
  metadata?: TaskMetadata | undefined;
  status?: TaskStatus | undefined;
}

export interface SessionRecord {
  id: string;
  source: SessionSource;
  sourceKey: string;
  title: string;
  status: "active" | "archived";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface CreateSessionInput {
  source: SessionSource;
  sourceKey: string;
  title?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SessionMessageRecord {
  id: string;
  sessionId: string;
  actorType: "user" | "role" | "system";
  actorId: string;
  roleId?: RoleId | undefined;
  messageType: "text" | "event";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateSessionMessageInput {
  sessionId: string;
  actorType: SessionMessageRecord["actorType"];
  actorId: string;
  roleId?: RoleId | undefined;
  messageType?: SessionMessageRecord["messageType"] | undefined;
  content: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface TaskRelationRecord {
  id: string;
  parentTaskId: string;
  childTaskId: string;
  relationType: "split" | "review" | "aggregate";
  createdAt: string;
}

export interface CreateTaskRelationInput {
  parentTaskId: string;
  childTaskId: string;
  relationType: TaskRelationRecord["relationType"];
}

export interface ApprovalRecord {
  id: string;
  kind: OperatorActionKind | "task_execution";
  taskId?: string | undefined;
  operatorActionId?: string | undefined;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy?: string | undefined;
  decidedBy?: string | undefined;
  decisionNote?: string | undefined;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | undefined;
}

export interface ApprovalEventRecord {
  id: string;
  approvalId: string;
  eventType: "created" | "approved" | "rejected";
  actor?: string | undefined;
  note?: string | undefined;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalWorkflowRecord {
  id: string;
  approvalId: string;
  status: "pending" | "in_review" | "approved" | "rejected" | "escalated" | "cancelled";
  currentStepIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalWorkflowStepRecord {
  id: string;
  workflowId: string;
  stepIndex: number;
  roleId: RoleId;
  status: "pending" | "approved" | "rejected" | "skipped";
  decidedBy?: string | undefined;
  decisionNote?: string | undefined;
  decidedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApprovalInput {
  kind: OperatorActionKind | "task_execution";
  summary: string;
  payload: Record<string, unknown>;
  taskId?: string | undefined;
  operatorActionId?: string | undefined;
  requestedBy?: string | undefined;
}

export interface ApprovalDecisionInput {
  status: Extract<ApprovalStatus, "approved" | "rejected">;
  decidedBy: string;
  decisionNote?: string | undefined;
}

export interface OperatorActionRecord {
  id: string;
  kind: OperatorActionKind;
  status: "pending" | "approved" | "rejected" | "applied";
  summary: string;
  payload: Record<string, unknown>;
  targetRoleId?: RoleId | undefined;
  skillId?: string | undefined;
  approvalId?: string | undefined;
  createdBy?: string | undefined;
  createdAt: string;
  updatedAt: string;
  executedAt?: string | undefined;
}

export interface CreateOperatorActionInput {
  kind: OperatorActionKind;
  summary: string;
  payload: Record<string, unknown>;
  targetRoleId?: RoleId | undefined;
  skillId?: string | undefined;
  createdBy?: string | undefined;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  allowedRoles: RoleId[];
  defaultConfig: Record<string, unknown>;
  aliases: string[];
}

export interface SkillMarketplaceEntry {
  id: string;
  skillId: string;
  name: string;
  description: string;
  summary: string;
  allowedRoles: RoleId[];
  aliases: string[];
  tags: string[];
  source: "catalog" | "remote";
  sourceLabel?: string | undefined;
  sourceUrl?: string | undefined;
  version?: string | undefined;
  runtimeAvailable: boolean;
  installState: "local_installable" | "discover_only";
  installable: boolean;
}

export interface MarketplaceRoleBindingState {
  installed: boolean;
  verificationStatus?: SkillBindingRecord["verificationStatus"] | "";
  installedAt?: string | undefined;
  verifiedAt?: string | undefined;
}

export interface MarketplaceRecommendation {
  score: number;
  state:
    | "ready_verified"
    | "ready_unverified"
    | "ready_failed"
    | "install_recommended"
    | "integration_required";
  label: string;
}

export interface SkillBindingRecord {
  id: string;
  scope: SkillScope;
  scopeId: string;
  skillId: string;
  status: "enabled" | "disabled";
  verificationStatus?: "unverified" | "verified" | "failed" | undefined;
  config: Record<string, unknown>;
  installedBy?: string | undefined;
  installedAt?: string | undefined;
  verifiedAt?: string | undefined;
  lastVerifiedTaskId?: string | undefined;
  source?: string | undefined;
  sourceLabel?: string | undefined;
  sourceUrl?: string | undefined;
  version?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export const TOOL_PROVIDER_IDS = ["opencode", "codex", "claude"] as const;
export type ToolProviderId = (typeof TOOL_PROVIDER_IDS)[number];

export const TOOL_RUN_STATUSES = [
  "queued",
  "approval_pending",
  "running",
  "completed",
  "failed",
  "blocked"
] as const;
export type ToolRunStatus = (typeof TOOL_RUN_STATUSES)[number];

export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolApprovalStatus = "not_required" | "pending" | "approved" | "rejected" | "auto_approved";
export type ToolApprovalMode = "cto_auto_owner_fallback" | "manual_owner";

export interface ToolExecPolicy {
  providerOrder: ToolProviderId[];
  workspaceOnly: boolean;
  timeoutMs: number;
  approvalMode: ToolApprovalMode;
  ctoRoleId: RoleId;
  ownerRoleId: RoleId;
  highRiskKeywords: string[];
  providerModels: Partial<Record<ToolProviderId, string>>;
  providerBaseUrls: Partial<Record<ToolProviderId, string>>;
}

export interface ToolRunRecord {
  id: string;
  taskId: string;
  roleId: RoleId;
  providerId: ToolProviderId;
  title: string;
  instruction: string;
  command: string;
  args: string[];
  riskLevel: ToolRiskLevel;
  status: ToolRunStatus;
  approvalStatus: ToolApprovalStatus;
  requestedBy?: string | undefined;
  approvedBy?: string | undefined;
  approvalId?: string | undefined;
  outputText?: string | undefined;
  errorText?: string | undefined;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface CreateToolRunInput {
  taskId: string;
  roleId: RoleId;
  providerId: ToolProviderId;
  title: string;
  instruction: string;
  command: string;
  args: string[];
  riskLevel: ToolRiskLevel;
  requestedBy?: string | undefined;
  approvalStatus?: ToolApprovalStatus | undefined;
  approvalId?: string | undefined;
  status?: ToolRunStatus | undefined;
}

export interface ToolProviderStatus {
  providerId: ToolProviderId;
  binaryName: string;
  available: boolean;
  binaryPath?: string | undefined;
  keyEnvName?: string | undefined;
  keyConfigured: boolean;
  note?: string | undefined;
}

export interface RuntimeConfig {
  memory: {
    defaultBackend: MemoryBackend;
    roleBackends: Partial<Record<RoleId, MemoryBackend>>;
  };
  routing: {
    primaryBackend: "sglang" | "ollama" | "zhipu" | "openai";
    fallbackBackend: "ollama" | "sglang" | "zhipu" | "openai";
  };
  channels: {
    feishuEnabled: boolean;
    emailEnabled: boolean;
  };
  approvals: {
    requireForConfigMutation: boolean;
    requireForEmailSend: boolean;
  };
  queue: {
    sla: QueueSlaPolicy;
  };
  tools: ToolExecPolicy;
  collaboration: {
    enabled: boolean;
    triggerKeywords: string[];
    defaultParticipants: RoleId[];
    defaultConfig: CollaborationConfig;
  };
}

export interface AuditEventRecord {
  id: string;
  category: string;
  entityType: string;
  entityId: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardSnapshot {
  config: RuntimeConfig;
  routingTemplates: RoutingTemplate[];
  queueMetrics: QueueMetrics;
  toolRuns: ToolRunRecord[];
  tasks: TaskRecord[];
  approvals: ApprovalRecord[];
  operatorActions: OperatorActionRecord[];
  skillBindings: SkillBindingRecord[];
  auditEvents: AuditEventRecord[];
}

export interface ParsedOperatorAction {
  action: CreateOperatorActionInput;
  needsApproval: boolean;
}

export interface RoutingTaskTemplate {
  roleId: RoleId;
  titleTemplate: string;
  instructionTemplate: string;
  deliverableMode?: DeliverableMode | undefined;
  deliverableSections?: string[] | undefined;
  successCriteria?: string[] | undefined;
  completionSignal?: string | undefined;
  workflowLabel?: string | undefined;
  priority?: number | undefined;
}

export interface RoutingTemplate {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  matchMode: "any" | "all";
  enabled: boolean;
  tasks: RoutingTaskTemplate[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoutingTemplateInput {
  name: string;
  description?: string | undefined;
  triggerKeywords: string[];
  matchMode?: "any" | "all" | undefined;
  enabled?: boolean | undefined;
  tasks: RoutingTaskTemplate[];
}

export interface UpdateRoutingTemplateInput {
  name?: string | undefined;
  description?: string | undefined;
  triggerKeywords?: string[] | undefined;
  matchMode?: "any" | "all" | undefined;
  enabled?: boolean | undefined;
  tasks?: RoutingTaskTemplate[] | undefined;
}

export interface QueueMetricItem {
  id: string;
  label: string;
  queued: number;
  running: number;
  avgWaitMs: number;
  avgRunMs: number;
}

export interface QueueSlaPolicy {
  warningWaitMs: number;
  criticalWaitMs: number;
}

export interface QueueAlert {
  level: "warning" | "critical";
  message: string;
  queuedCount: number;
  oldestQueuedWaitMs: number;
  warningWaitMs: number;
  criticalWaitMs: number;
}

export interface QueueMetrics {
  queuedCount: number;
  runningCount: number;
  completedCountLast24h: number;
  avgWaitMsLast24h: number;
  avgRunMsLast24h: number;
  oldestQueuedWaitMs: number;
  alertLevel: "ok" | "warning" | "critical";
  alerts: QueueAlert[];
  byRole: QueueMetricItem[];
  byTemplate: QueueMetricItem[];
  updatedAt: string;
}

export const GOAL_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_input",
  "awaiting_authorization",
  "completed",
  "failed",
  "cancelled"
] as const;
export type GoalRunStatus = (typeof GOAL_RUN_STATUSES)[number];

export const GOAL_RUN_STAGES = ["discover", "plan", "execute", "verify", "deploy", "accept"] as const;
export type GoalRunStage = (typeof GOAL_RUN_STAGES)[number];

export interface GoalRunResult {
  summary: string;
  deliverable: string;
  nextActions: string[];
}

export interface GoalRunRecord {
  id: string;
  source: TaskSource;
  objective: string;
  status: GoalRunStatus;
  currentStage: GoalRunStage;
  requestedBy?: string | undefined;
  chatId?: string | undefined;
  sessionId?: string | undefined;
  language: string;
  metadata: Record<string, unknown>;
  context: Record<string, unknown>;
  plan?: Record<string, unknown> | undefined;
  result?: GoalRunResult | undefined;
  currentTaskId?: string | undefined;
  retryCount: number;
  maxRetries: number;
  awaitingInputFields: string[];
  awaitingInputPrompt?: string | undefined;
  errorText?: string | undefined;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface CreateGoalRunInput {
  source: TaskSource;
  objective: string;
  requestedBy?: string | undefined;
  chatId?: string | undefined;
  sessionId?: string | undefined;
  language?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  context?: Record<string, unknown> | undefined;
  maxRetries?: number | undefined;
}

export type GoalRunTimelineEventType =
  | "run_created"
  | "stage_changed"
  | "input_required"
  | "input_received"
  | "task_created"
  | "task_completed"
  | "task_failed"
  | "retry_scheduled"
  | "authorization_required"
  | "authorization_granted"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "status";

export interface GoalRunTimelineEventRecord {
  id: string;
  goalRunId: string;
  stage: GoalRunStage;
  eventType: GoalRunTimelineEventType;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GoalRunTraceRecord {
  id: string;
  goalRunId: string;
  stage: GoalRunStage;
  status: "started" | "completed" | "failed" | "awaiting_input" | "awaiting_authorization" | "resumed";
  taskId?: string | undefined;
  taskTraceId?: string | undefined;
  inputSummary: string;
  outputSummary: string;
  artifactFiles: string[];
  completedRoles: RoleId[];
  failedRoles: RoleId[];
  approvalGateHits: number;
  failureCategory?: string | undefined;
  handoffArtifactId?: string | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GoalRunHarnessGradeRecord {
  suite: string;
  grade: "pass" | "warn" | "fail" | "unknown";
  failedInvariant?: string | undefined;
  traceSummary?: string | undefined;
  handoffCoverage?: number | undefined;
  approvalCoverage?: number | undefined;
  resumeCoverage?: number | undefined;
  stateCompleteness?: boolean | undefined;
  generatedAt: string;
}

export interface GoalRunInputRecord {
  id: string;
  goalRunId: string;
  inputKey: string;
  value: unknown;
  createdBy?: string | undefined;
  createdAt: string;
}

export type RunAuthTokenStatus = "active" | "used" | "expired" | "revoked";

export interface RunAuthTokenRecord {
  id: string;
  goalRunId: string;
  token: string;
  scope: string;
  status: RunAuthTokenStatus;
  reason?: string | undefined;
  expiresAt: string;
  usedBy?: string | undefined;
  usedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunAuthTokenInput {
  goalRunId: string;
  scope: string;
  ttlMs?: number | undefined;
  reason?: string | undefined;
}

export interface CredentialRecord {
  id: string;
  providerId: string;
  credentialKey: string;
  displayName?: string | undefined;
  valueMasked: string;
  metadata: Record<string, unknown>;
  createdBy?: string | undefined;
  lastUsedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCredentialInput {
  providerId: string;
  credentialKey: string;
  value: string;
  displayName?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdBy?: string | undefined;
}

export type UserRole = "owner" | "operator" | "viewer";

export interface UserRecord {
  id: string;
  username: string;
  email?: string | undefined;
  passwordHash: string;
  role: UserRole;
  displayName: string;
  isActive: boolean;
  lastLoginAt?: string | undefined;
  loginCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  username: string;
  email?: string | undefined;
  password: string;
  role?: UserRole | undefined;
  displayName?: string | undefined;
}

export interface UpdateUserInput {
  email?: string | undefined;
  displayName?: string | undefined;
  isActive?: boolean | undefined;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  token: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  expiresAt: string;
  createdAt: string;
  lastAccessedAt: string;
}

export interface CreateAuthSessionInput {
  userId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  rememberMe?: boolean | undefined;
}

export interface LoginInput {
  username: string;
  password: string;
  rememberMe?: boolean | undefined;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface LoginResult {
  success: boolean;
  user?: UserRecord | undefined;
  token?: string | undefined;
  expiresAt?: string | undefined;
  error?: string | undefined;
}

export interface AuthMetrics {
  totalUsers: number;
  activeUsers: number;
  activeSessions: number;
  loginAttempts24h: number;
  failedLogins24h: number;
}

export type AuthErrorCode =
  | "username_and_password_required"
  | "invalid_credentials"
  | "account_locked"
  | "account_inactive"
  | "missing_token"
  | "invalid_token"
  | "token_expired"
  | "rate_limited"
  | "internal_error";

export interface AuthError {
  ok: false;
  error: AuthErrorCode;
  message: string;
  retryAfter?: number;
}

export interface LoginAttempt {
  username: string;
  ipAddress: string;
  success: boolean;
  reason?: string;
  timestamp: string;
}

// ============ Feishu Emoji Types ============

export const FEISHU_EMOJI_TYPES = [
  "THUMBSUP",
  "THUMBSDOWN",
  "HEART",
  "STAR",
  "OK",
  "YES",
  "NO",
  "CLAP",
  "COOL",
  "THINKING",
  "LAUGH",
  "CRY",
  "ANGRY",
  "SURPRISED",
  "CHECK",
  "CROSS",
  "QUESTION",
  "ROCKET",
  "FIRE",
  "PARTY",
  "MUSCLE",
  "PRAY",
  "FINGERHEART",
  "APPLAUSE"
] as const;

export type FeishuEmojiType = (typeof FEISHU_EMOJI_TYPES)[number];

export type EmojiScene =
  | "taskQueued"
  | "taskCompleted"
  | "taskFailed"
  | "approvalPending"
  | "agentDiscussion"
  | "finalSummary";

export interface EmojiReactionConfig {
  defaultEmoji: FeishuEmojiType;
  sceneEmojis: Partial<Record<EmojiScene, FeishuEmojiType | FeishuEmojiType[]>>;
  randomMode: boolean;
}

// ============ Agent Collaboration Types ============

export type AgentMessageType =
  | "task_assignment"
  | "progress_update"
  | "discussion"
  | "question"
  | "answer"
  | "review_request"
  | "review_result"
  | "summary"
  | "final_report";

export type CollaborationPhase =
  | "classify"
  | "assignment"
  | "execution"
  | "discussion"
  | "converge"
  | "aggregation"
  | "verify"
  | "await_user"
  | "completed";

export interface AgentMessage {
  id: string;
  collaborationId: string;
  taskId: string;
  fromRoleId: RoleId;
  toRoleIds: RoleId[];
  messageType: AgentMessageType;
  content: string;
  metadata: {
    parentMessageId?: string;
    isIntermediateResult?: boolean;
    agentInstanceId?: string;
    agentInstanceName?: string;
  };
  createdAt: string;
}

export interface AgentCollaboration {
  id: string;
  parentTaskId: string;
  sessionId?: string;
  chatId?: string;
  status: "active" | "completed" | "failed" | "cancelled";
  participants: RoleId[];
  facilitator: RoleId;
  currentPhase: CollaborationPhase;
  phaseResults: CollaborationPhaseResult[];
  config: CollaborationConfig;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CollaborationPhaseResult {
  phase: string;
  completedBy: RoleId[];
  outputs: CollaborationPhaseOutput[];
}

export interface CollaborationPhaseOutput {
  roleId: RoleId;
  summary: string;
}

export interface CollaborationConfig {
  maxRounds: number;
  discussionTimeoutMs: number;
  requireConsensus: boolean;
  pushIntermediateResults: boolean;
  autoAggregateOnComplete: boolean;
  aggregateTimeoutMs: number;
}

export type CollaborationLevel = "none" | "light" | "standard" | "full";

export interface CollaborationPlan {
  level: CollaborationLevel;
  complexity: "trivial" | "simple" | "moderate" | "complex";
  risk: "low" | "medium" | "high";
  suggestedReviewers: RoleId[];
  rationale: string;
}

export interface QualityAssessment {
  score: number;
  passesThreshold: boolean;
  issues: string[];
  recommendation: "approve" | "revise" | "escalate";
}

export interface CreateAgentCollaborationInput {
  parentTaskId: string;
  sessionId?: string;
  chatId?: string;
  participants?: RoleId[];
  facilitator?: RoleId;
  config?: Partial<CollaborationConfig>;
}

export interface SendAgentMessageInput {
  collaborationId: string;
  taskId: string;
  fromRoleId: RoleId;
  toRoleIds: RoleId[];
  messageType: AgentMessageType;
  content: string;
  metadata?: AgentMessage["metadata"];
}

export const AGENT_INSTANCE_STATUSES = ["active", "inactive"] as const;
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

export interface AgentInstance {
  id: string;
  roleId: RoleId;
  name: string;
  tonePolicy: string;
  status: AgentInstanceStatus;
  metadata: Record<string, unknown>;
  createdBy?: string | undefined;
  createdAt: string;
  updatedAt: string;
  deactivatedAt?: string | undefined;
}

export interface CreateAgentInstanceInput {
  roleId: RoleId;
  name?: string | undefined;
  tonePolicy?: string | undefined;
  status?: AgentInstanceStatus | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdBy?: string | undefined;
}

export interface UpdateAgentInstanceInput {
  name?: string | undefined;
  tonePolicy?: string | undefined;
  status?: AgentInstanceStatus | undefined;
  metadata?: Record<string, unknown> | undefined;
  deactivatedAt?: string | undefined;
}

export type CollaborationTimelineEventType =
  | "collaboration_started"
  | "task_assigned"
  | "task_completed"
  | "task_failed"
  | "phase_changed"
  | "aggregation_started"
  | "aggregation_completed"
  | "collaboration_completed"
  | "collaboration_failed"
  | "status";

export interface CollaborationTimelineEvent {
  id: string;
  collaborationId: string;
  eventType: CollaborationTimelineEventType;
  message: string;
  roleId?: RoleId | undefined;
  taskId?: string | undefined;
  agentInstanceId?: string | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
}
