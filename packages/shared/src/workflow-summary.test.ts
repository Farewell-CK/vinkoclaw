import { describe, expect, it } from "vitest";
import { buildWorkflowStatusSummary } from "./workflow-summary.js";

describe("buildWorkflowStatusSummary", () => {
  it("renders goal, stage, next actions, blockers, and artifacts from orchestration state", () => {
    const summary = buildWorkflowStatusSummary({
      title: "实现登录页",
      status: "running",
      metadata: {
        orchestrationState: {
          ownerRoleId: "product",
          spec: {
            goal: "交付登录页 MVP",
            successCriteria: ["支持邮箱密码登录"],
            constraints: [],
            scope: []
          },
          progress: {
            stage: "implementation",
            status: "active",
            completed: ["spec"],
            inFlight: ["implementation"],
            blocked: ["等待设计确认"],
            awaitingInput: ["确认是否要第三方登录"],
            nextActions: ["完成表单校验", "补错误提示"]
          },
          decision: {
            summary: "",
            entries: []
          },
          artifactIndex: {
            items: [
              { path: "login-page.md", title: "登录页说明", stage: "implementation", status: "produced" },
              { path: "login-page.html", title: "登录页导出", stage: "implementation", status: "produced" }
            ]
          },
          updatedAt: new Date().toISOString(),
          updatedBy: "product"
        },
        toolChangedFiles: ["exports/login-page.csv"]
      }
    }, { includeArtifacts: true });

    expect(summary).toContain("**目标**：交付登录页 MVP");
    expect(summary).toContain("**当前阶段**：implementation · active");
    expect(summary).toContain("**下一步**：完成表单校验；补错误提示");
    expect(summary).toContain("**待补充**：确认是否要第三方登录");
    expect(summary).toContain("**阻塞**：等待设计确认");
    expect(summary).toContain("**产物**：登录页说明；登录页导出");
    expect(summary).toContain("**导出**：Markdown / HTML / CSV");
  });
});
