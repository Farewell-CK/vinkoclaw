import { describe, expect, it } from "vitest";

import { buildCompanionArtifacts } from "./artifact-export.js";

describe("buildCompanionArtifacts", () => {
  it("creates html companion for markdown artifacts", () => {
    const artifacts = buildCompanionArtifacts({
      relativePath: ".vinkoclaw/tasks/123/report.md",
      title: "Report",
      content: "# 标题\n\n- 第一项\n- 第二项\n"
    });

    expect(artifacts.map((item) => item.relativePath)).toContain(".vinkoclaw/tasks/123/report.html");
    expect(artifacts[0]?.content).toContain("<h1>标题</h1>");
    expect(artifacts[0]?.content).toContain("<li>第一项</li>");
  });

  it("creates csv companion when markdown contains a table", () => {
    const artifacts = buildCompanionArtifacts({
      relativePath: ".vinkoclaw/tasks/123/report.md",
      title: "Table",
      content: [
        "# 数据",
        "",
        "| 姓名 | 分数 |",
        "| --- | --- |",
        "| Alice | 98 |",
        "| Bob | 87 |",
        ""
      ].join("\n")
    });

    const csv = artifacts.find((item) => item.relativePath.endsWith(".csv"));
    expect(csv?.content).toBe("姓名,分数\nAlice,98\nBob,87\n");
  });

  it("ignores non-markdown artifacts", () => {
    const artifacts = buildCompanionArtifacts({
      relativePath: ".vinkoclaw/tasks/123/report.txt",
      title: "Plain",
      content: "hello"
    });

    expect(artifacts).toEqual([]);
  });
});
