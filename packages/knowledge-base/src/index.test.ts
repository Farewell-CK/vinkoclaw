import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceKnowledgeBase } from "./index.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinkoclaw-kb-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("WorkspaceKnowledgeBase", () => {
  it("retrieves relevant chunk when signal appears near file tail", async () => {
    await withTempDir(async (root) => {
      const longPrefix = "noise ".repeat(500);
      const tailSignal = "vector retrieval anchor phrase for chunked search.";
      await writeFile(path.join(root, "notes.md"), `${longPrefix}\n${tailSignal}\n`, "utf8");
      await writeFile(path.join(root, "other.md"), "unrelated document content", "utf8");

      const kb = new WorkspaceKnowledgeBase([root], 0);
      const snippets = await kb.retrieve("anchor phrase retrieval", 3);

      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0]?.path).toBe("notes.md");
      expect(snippets[0]?.excerpt.toLowerCase()).toContain("anchor phrase");
    });
  });

  it("supports semantic fallback for chinese query phrasing mismatch", async () => {
    await withTempDir(async (root) => {
      await writeFile(
        path.join(root, "feishu.md"),
        "用户名解析失败后需要检查权限，并申请通讯录读取权限。",
        "utf8"
      );
      await writeFile(path.join(root, "random.md"), "今天吃什么", "utf8");

      const kb = new WorkspaceKnowledgeBase([root], 0);
      const snippets = await kb.retrieve("用户名解析失败怎么办", 3, {
        keywordWeight: 0.3,
        semanticWeight: 0.7,
        minSemanticScore: 0.02
      });

      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0]?.path).toBe("feishu.md");
      expect(snippets[0]?.score).toBeGreaterThan(0);
    });
  });
});
