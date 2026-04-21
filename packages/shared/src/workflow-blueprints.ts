import type { DeliverableMode, RoleId, RoutingTaskTemplate, RoutingTemplate } from "./types.js";

export type WorkflowTaskBlueprint = {
  roleId: RoleId;
  titleTemplate: string;
  instructionTemplate: string;
  deliverableMode: DeliverableMode;
  deliverableSections: string[];
  successCriteria?: string[] | undefined;
  completionSignal?: string | undefined;
  workflowLabel?: string | undefined;
  priority: number;
};

export type WorkflowBlueprint = {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  matchMode: "any" | "all";
  enabled: boolean;
  workflowLabel?: string | undefined;
  tasks: WorkflowTaskBlueprint[];
};

type WorkflowTemplatePatch = {
  deliverableSections?: string[] | undefined;
  successCriteria?: string[] | undefined;
  completionSignal?: string | undefined;
  workflowLabel?: string | undefined;
};

function applyTaskBlueprintPatch(
  task: WorkflowTaskBlueprint,
  patch: WorkflowTemplatePatch = {}
): WorkflowTaskBlueprint {
  return {
    ...task,
    ...(Array.isArray(patch.deliverableSections) ? { deliverableSections: patch.deliverableSections } : {}),
    ...(Array.isArray(patch.successCriteria) ? { successCriteria: patch.successCriteria } : {}),
    ...(typeof patch.completionSignal === "string" ? { completionSignal: patch.completionSignal } : {}),
    ...(typeof patch.workflowLabel === "string" ? { workflowLabel: patch.workflowLabel } : {})
  };
}

export const WORKFLOW_BLUEPRINTS: WorkflowBlueprint[] = [
  {
    id: "tpl-opc-internet-launch",
    name: "互联网产品全流程交付",
    description: "将一个功能请求拆成 PM/UI/前端/后端/算法/测试 六角色并行任务。",
    triggerKeywords: ["团队执行", "全流程", "一条龙", "从需求到上线", "opc", "互联网产品"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "互联网产品全流程交付",
    tasks: [
      {
        roleId: "product",
        titleTemplate: "PM 拆解: {{input_short}}",
        instructionTemplate: "基于原始需求生成 PRD 摘要、验收标准、版本切分和优先级。原始需求：{{input}}",
        deliverableMode: "artifact_required",
        deliverableSections: ["背景", "目标用户", "核心流程", "范围", "验收标准", "风险", "下一步"],
        successCriteria: ["产出 PRD 摘要", "列出验收标准", "明确版本切分与优先级"],
        completionSignal: "PRD 可直接进入设计与研发拆解",
        workflowLabel: "产品拆解",
        priority: 95
      },
      {
        roleId: "uiux",
        titleTemplate: "UI/UX 方案: {{input_short}}",
        instructionTemplate: "输出信息架构、关键页面草案、交互细节和视觉规范建议。原始需求：{{input}}",
        deliverableMode: "artifact_preferred",
        deliverableSections: ["信息架构", "关键页面", "交互规则", "视觉规范", "待确认项"],
        successCriteria: ["关键页面齐全", "交互规则明确", "待确认项可执行"],
        completionSignal: "设计稿或结构说明可供前端实现",
        workflowLabel: "体验设计",
        priority: 88
      },
      {
        roleId: "frontend",
        titleTemplate: "前端实现: {{input_short}}",
        instructionTemplate: "给出前端实现计划、组件边界、状态管理和性能注意点。原始需求：{{input}}",
        deliverableMode: "artifact_required",
        deliverableSections: ["变更文件", "组件边界", "状态管理", "启动命令", "验证结果"],
        successCriteria: ["存在真实改动文件", "组件边界明确", "可运行或可验证"],
        completionSignal: "前端交付可被 QA 验收",
        workflowLabel: "前端实现",
        priority: 85
      },
      {
        roleId: "backend",
        titleTemplate: "后端实现: {{input_short}}",
        instructionTemplate: "给出后端 API、数据模型、鉴权、观测性和发布策略。原始需求：{{input}}",
        deliverableMode: "artifact_required",
        deliverableSections: ["接口设计", "数据模型", "鉴权", "观测性", "发布方案"],
        successCriteria: ["接口设计完整", "数据模型明确", "上线与观测路径清晰"],
        completionSignal: "后端能力可被前端联调",
        workflowLabel: "后端实现",
        priority: 85
      },
      {
        roleId: "algorithm",
        titleTemplate: "算法/模型方案: {{input_short}}",
        instructionTemplate: "评估模型/检索/推理方案，输出延迟、成本、质量权衡及参数建议。原始需求：{{input}}",
        deliverableMode: "artifact_preferred",
        deliverableSections: ["方案对比", "延迟与成本", "质量权衡", "参数建议", "风险"],
        successCriteria: ["给出方案对比", "明确成本质量权衡", "提供可执行参数建议"],
        completionSignal: "模型策略可供研发与产品采用",
        workflowLabel: "算法方案",
        priority: 82
      },
      {
        roleId: "qa",
        titleTemplate: "测试与验收: {{input_short}}",
        instructionTemplate: "产出测试矩阵（功能/回归/性能/异常）、验收用例和上线风险清单。原始需求：{{input}}",
        deliverableMode: "artifact_required",
        deliverableSections: ["测试矩阵", "验收用例", "异常场景", "上线风险", "结论"],
        successCriteria: ["覆盖功能与异常场景", "给出上线风险", "形成验收结论"],
        completionSignal: "交付具备上线前验收依据",
        workflowLabel: "测试验收",
        priority: 90
      }
    ]
  },
  {
    id: "tpl-founder-delivery-loop",
    name: "Delivery Workflow",
    description: "将一个复杂目标按 规划 → 实现 → QA → 总结 的顺序自动推进。",
    triggerKeywords: ["从想法到交付", "交付闭环", "idea to delivery", "founder delivery", "产品交付闭环", "从0到1", "自动推进"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Delivery Workflow",
    tasks: [
      {
        roleId: "product",
        titleTemplate: "Delivery Workflow / Spec: {{input_short}}",
        instructionTemplate:
          "你正在启动通用交付工作流。请先将以下目标沉淀成可执行规划，后续实现、验证和总结会基于这份产物继续推进。原始目标：{{input}}",
        deliverableMode: "artifact_required",
        deliverableSections: ["背景", "目标用户", "核心流程", "需求范围", "验收标准", "风险", "下一步"],
        successCriteria: ["产出结构化目标与验收标准", "生成可见 artifact", "为实现与验证阶段提供明确输入"],
        completionSignal: "规划能直接驱动实现阶段",
        workflowLabel: "Delivery Workflow / Spec",
        priority: 98
      }
    ]
  },
  {
    id: "tpl-founder-prd",
    name: "Founder PRD",
    description: "将创始人想法直接沉淀为可执行 PRD 文档。",
    triggerKeywords: ["写prd", "产品需求文档", "需求文档", "prd", "产品方案"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder PRD",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "product",
          titleTemplate: "PRD: {{input_short}}",
          instructionTemplate:
            "请将以下创始人想法整理为结构化 PRD，包含背景、目标用户、核心流程、范围、验收标准、风险与下一步。原始需求：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["背景", "目标用户", "核心流程", "需求范围", "验收标准", "风险", "下一步"],
          priority: 96
        },
        {
          successCriteria: ["需求范围清晰", "验收标准明确", "下一步可直接执行"],
          completionSignal: "PRD 可直接进入评审或研发拆解",
          workflowLabel: "Founder PRD"
        }
      )
    ]
  },
  {
    id: "tpl-founder-research-report",
    name: "Founder Research Report",
    description: "产出结构化调研报告和结论摘要。",
    triggerKeywords: ["调研报告", "研究报告", "竞品分析", "市场调研", "分析报告"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Research Report",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "research",
          titleTemplate: "调研报告: {{input_short}}",
          instructionTemplate: "请围绕以下主题输出结构化调研报告，包含结论、证据、对比、风险和建议。原始主题：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["结论摘要", "关键证据", "对比分析", "风险", "建议动作"],
          priority: 92
        },
        {
          successCriteria: ["先给结论", "证据和对比充分", "建议动作可执行"],
          completionSignal: "调研结果可供创始人决策",
          workflowLabel: "Founder Research"
        }
      )
    ]
  },
  {
    id: "tpl-founder-research-recurring",
    name: "Founder Research Recurring",
    description: "将创始人的周期竞品/市场跟踪需求整理成固定节奏的调研执行清单。",
    triggerKeywords: ["周期调研", "定期调研", "每周调研", "竞品跟踪", "市场跟踪", "weekly research", "recurring research", "competitor tracking"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Research Recurring",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "research",
          titleTemplate: "周期调研清单: {{input_short}}",
          instructionTemplate:
            "请将以下创始人请求整理为周期执行的调研清单，明确周期/触发规则、跟踪对象、核心观察维度、输出结构、完成信号和建议动作。原始输入：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["周期与触发规则", "跟踪对象", "核心观察维度", "输出结构", "完成信号", "建议动作"],
          priority: 91
        },
        {
          successCriteria: ["周期清晰", "跟踪维度可执行", "输出结构稳定可复用"],
          completionSignal: "后续可按周期重复执行",
          workflowLabel: "Research Recurring"
        }
      )
    ]
  },
  {
    id: "tpl-founder-weekly-recap",
    name: "Founder Weekly Recap",
    description: "沉淀本周进展、阻塞与下周计划。",
    triggerKeywords: ["周报", "weekly recap", "本周总结", "周总结", "每周复盘"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Weekly Recap",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "operations",
          titleTemplate: "周报: {{input_short}}",
          instructionTemplate:
            "请将以下内容整理为创始人周报，包含已完成事项、关键指标/进展、阻塞问题、下周计划和待决策项。原始输入：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["已完成事项", "关键进展", "阻塞问题", "下周计划", "待决策项"],
          priority: 88
        },
        {
          successCriteria: ["本周进展清晰", "阻塞与决策项明确", "下周计划可直接执行"],
          completionSignal: "创始人可直接阅读并安排下周动作",
          workflowLabel: "Weekly Recap"
        }
      )
    ]
  },
  {
    id: "tpl-founder-ops-recurring",
    name: "Founder Ops Recurring",
    description: "将创始人的周期性提醒、例行跟进和重复运营动作整理成周期执行清单。",
    triggerKeywords: ["周期性", "每周", "每天", "每天提醒", "每周提醒", "周期提醒", "定期跟进", "daily reminder", "weekly follow up", "recurring"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Ops Recurring",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "operations",
          titleTemplate: "周期运营清单: {{input_short}}",
          instructionTemplate:
            "请将以下创始人请求整理为周期执行的运营清单，明确周期/触发规则、本轮待办、责任归属、完成信号、风险和下一步。原始输入：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["周期与触发规则", "本轮待办", "责任归属", "完成信号", "风险", "下一步"],
          priority: 87
        },
        {
          successCriteria: ["周期规则明确", "责任归属清晰", "完成信号可验证"],
          completionSignal: "运营动作可按周期自动执行或提醒",
          workflowLabel: "Ops Recurring"
        }
      )
    ]
  },
  {
    id: "tpl-founder-recap-recurring",
    name: "Founder Recap Recurring",
    description: "将创始人的周期复盘请求整理成固定节奏的复盘执行清单。",
    triggerKeywords: ["周期复盘", "每周固定复盘", "复盘提醒", "weekly recap reminder", "weekly recurring recap", "weekly review reminder"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Recap Recurring",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "operations",
          titleTemplate: "周期复盘清单: {{input_short}}",
          instructionTemplate:
            "请将以下创始人请求整理为周期执行的复盘清单，明确周期/触发规则、本轮输入项、输出结构、责任归属、完成信号和下一步。原始输入：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["周期与触发规则", "本轮输入项", "输出结构", "责任归属", "完成信号", "下一步"],
          priority: 87
        },
        {
          successCriteria: ["输入项固定", "输出结构稳定", "后续复盘节奏明确"],
          completionSignal: "复盘模板可重复使用",
          workflowLabel: "Recap Recurring"
        }
      )
    ]
  },
  {
    id: "tpl-founder-ops-followup",
    name: "Founder Ops Follow-up",
    description: "将创始人的待办、提醒、跟进与后续动作整理成可执行运营清单。",
    triggerKeywords: ["提醒我", "跟进", "待办", "follow up", "follow-up", "reminder", "提醒事项", "后续动作"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Ops Follow-up",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "operations",
          titleTemplate: "运营跟进: {{input_short}}",
          instructionTemplate:
            "请将以下创始人请求整理为可执行运营跟进清单，包含当前目标、待办项、提醒时间/触发条件、责任归属、风险和下一步。原始输入：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["当前目标", "待办清单", "提醒与触发条件", "责任归属", "风险", "下一步"],
          priority: 86
        },
        {
          successCriteria: ["待办清单可执行", "触发条件明确", "责任归属清晰"],
          completionSignal: "后续动作可被持续跟进",
          workflowLabel: "Ops Follow-up"
        }
      )
    ]
  },
  {
    id: "tpl-founder-implementation-task",
    name: "Founder Implementation Task",
    description: "将一个实现需求拆成开发与测试交付。",
    triggerKeywords: ["实现功能", "写代码", "开发这个", "修复这个", "实现这个需求"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Implementation Task",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "frontend",
          titleTemplate: "实现任务: {{input_short}}",
          instructionTemplate: "请基于以下需求直接在 workspace 中落地实现，输出变更文件、启动/验证命令和关键说明。原始需求：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["变更文件", "实现说明", "启动命令", "验证结果", "剩余风险"],
          priority: 90
        },
        {
          successCriteria: ["存在真实改动文件", "包含验证结果", "剩余风险已说明"],
          completionSignal: "实现交付可被 QA 或创始人复核",
          workflowLabel: "Implementation"
        }
      ),
      applyTaskBlueprintPatch(
        {
          roleId: "qa",
          titleTemplate: "验证任务: {{input_short}}",
          instructionTemplate: "请基于以下需求输出测试步骤、通过标准和失败场景覆盖，并校验开发交付是否满足要求。原始需求：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["测试步骤", "通过标准", "失败场景", "验证结论", "待修复项"],
          priority: 86
        },
        {
          successCriteria: ["测试步骤完整", "通过标准明确", "验证结论可信"],
          completionSignal: "交付已具备可复验的 QA 结果",
          workflowLabel: "Verification"
        }
      )
    ]
  },
  {
    id: "tpl-founder-bugfix-followup",
    name: "Founder Bugfix Follow-up",
    description: "将创始人的修复、热修和验证需求整理成研发修复闭环任务。",
    triggerKeywords: ["修复", "bugfix", "hotfix", "回归修复", "修 bug", "fix bug", "排查并修复"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Founder Bugfix Follow-up",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "engineering",
          titleTemplate: "修复任务: {{input_short}}",
          instructionTemplate:
            "请将以下创始人请求整理为修复闭环任务，包含问题现象、修复方案、代码变更、验证结果和剩余风险。原始输入：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["问题现象", "修复方案", "代码变更", "验证结果", "剩余风险"],
          priority: 90
        },
        {
          successCriteria: ["问题与修复路径明确", "代码变更存在", "验证结果真实"],
          completionSignal: "Bugfix 可被回归验证",
          workflowLabel: "Bugfix"
        }
      )
    ]
  },
  {
    id: "tpl-skill-runtime-integration",
    name: "Skill Runtime Integration",
    description: "将 marketplace 中发现但尚未接入本地 runtime 的 skill 转成标准工程接入任务。",
    triggerKeywords: ["skill接入", "接入runtime", "远端skill", "marketplace skill", "集成skill"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Skill Runtime Integration",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "engineering",
          titleTemplate: "接入 Skill Runtime: {{input_short}}",
          instructionTemplate:
            "请将以下 marketplace skill 接入本地 runtime，补齐技能定义、安装元数据、执行约束和必要测试，确保后续可直接安装与使用。原始信息：{{input}}",
          deliverableMode: "artifact_required",
          deliverableSections: ["接入方案", "技能定义", "代码改动", "安装验证", "剩余限制"],
          priority: 91
        },
        {
          successCriteria: ["skill definition 可被识别", "安装元数据齐全", "至少有基础测试"],
          completionSignal: "skill 可进入安装或 discover-only 验证",
          workflowLabel: "Skill Integration"
        }
      )
    ]
  },
  {
    id: "tpl-skill-smoke-verify",
    name: "Skill Smoke Verify",
    description: "安装 skill 后给目标角色派发一个最小验证任务，确认 skill 已真实生效。",
    triggerKeywords: ["skill验证", "验证skill", "smoke verify", "验证已安装技能"],
    matchMode: "any",
    enabled: true,
    workflowLabel: "Skill Smoke Verify",
    tasks: [
      applyTaskBlueprintPatch(
        {
          roleId: "product",
          titleTemplate: "验证 Skill: {{input_short}}",
          instructionTemplate:
            "请使用已安装的 skill 完成一个最小验证任务，明确说明 skill 如何影响输出内容、结构或执行方式。原始信息：{{input}}",
          deliverableMode: "artifact_preferred",
          deliverableSections: ["验证任务", "执行结果", "Skill 使用证据", "结论"],
          priority: 84
        },
        {
          successCriteria: ["明确 skill 使用证据", "说明对输出的影响", "形成可判断结论"],
          completionSignal: "skill 生效状态可被确认",
          workflowLabel: "Skill Verification"
        }
      )
    ]
  }
];

export function listWorkflowBlueprints(): WorkflowBlueprint[] {
  return WORKFLOW_BLUEPRINTS.map((entry) => ({
    ...entry,
    tasks: entry.tasks.map((task) => ({
      ...task,
      deliverableSections: [...task.deliverableSections],
      ...(Array.isArray(task.successCriteria) ? { successCriteria: [...task.successCriteria] } : {})
    }))
  }));
}

export function getWorkflowBlueprint(id: string): WorkflowBlueprint | undefined {
  return listWorkflowBlueprints().find((entry) => entry.id === id);
}

export function blueprintTaskToRoutingTask(task: WorkflowTaskBlueprint): RoutingTaskTemplate {
  return {
    roleId: task.roleId,
    titleTemplate: task.titleTemplate,
    instructionTemplate: task.instructionTemplate,
    deliverableMode: task.deliverableMode,
    deliverableSections: [...task.deliverableSections],
    ...(Array.isArray(task.successCriteria) ? { successCriteria: [...task.successCriteria] } : {}),
    ...(typeof task.completionSignal === "string" ? { completionSignal: task.completionSignal } : {}),
    ...(typeof task.workflowLabel === "string" ? { workflowLabel: task.workflowLabel } : {}),
    priority: task.priority
  };
}

export function workflowBlueprintToRoutingTemplate(
  blueprint: WorkflowBlueprint,
  timestamp: string
): RoutingTemplate {
  return {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description,
    triggerKeywords: [...blueprint.triggerKeywords],
    matchMode: blueprint.matchMode,
    enabled: blueprint.enabled,
    tasks: blueprint.tasks.map(blueprintTaskToRoutingTask),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function buildTaskWorkflowBlueprintMetadata(input: {
  templateId: string;
  taskRoleId: RoleId;
  fallbackTemplateName?: string | undefined;
}): {
  routeTemplateId: string;
  routeTemplateName: string;
  workflowLabel?: string | undefined;
  workflowSuccessCriteria?: string[] | undefined;
  workflowCompletionSignal?: string | undefined;
} {
  const blueprint = getWorkflowBlueprint(input.templateId);
  const taskBlueprint = blueprint?.tasks.find((task) => task.roleId === input.taskRoleId) ?? blueprint?.tasks[0];
  return {
    routeTemplateId: input.templateId,
    routeTemplateName: blueprint?.name ?? input.fallbackTemplateName ?? input.templateId,
    ...(typeof (taskBlueprint?.workflowLabel ?? blueprint?.workflowLabel) === "string"
      ? { workflowLabel: taskBlueprint?.workflowLabel ?? blueprint?.workflowLabel }
      : {}),
    ...(Array.isArray(taskBlueprint?.successCriteria) ? { workflowSuccessCriteria: [...taskBlueprint.successCriteria] } : {}),
    ...(typeof taskBlueprint?.completionSignal === "string"
      ? { workflowCompletionSignal: taskBlueprint.completionSignal }
      : {})
  };
}
