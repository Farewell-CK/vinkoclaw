# VinkoClaw Workspace Conventions

工作区根目录：`/home/xsuper/workspace`（即 `VINKOCLAW_WORKSPACE_ROOT`）

---

## 目录规范

### 新项目开发

Agent 执行的新项目统一放在工作区根目录下，以**项目名称**作为目录名：

```
/home/xsuper/workspace/
  <project-name>/          ← agent 创建的新项目
  <project-name>/
  ...
```

命名规则：
- 全小写，单词用短横线分隔：`my-project`、`landing-page`、`data-pipeline`
- 禁止使用空格、中文、下划线前缀

### 输出文档 / 交付物

- **Markdown 报告**、**分析文档**、**PRD** 等文本交付物放在工作区根目录下，按任务内容命名：
  ```
  /home/xsuper/workspace/
    embodied-ai-report/
    kdd/
  ```
- **PDF / Excel / 图表等二进制产物** 由 `run_code` 工具生成，存放于任务临时目录，执行完成后 agent 应通过 `write_file` 把最终产物复制到工作区根目录下适当位置。

### 任务临时文件

Agent 执行期间的临时脚本、中间文件存放于任务专属目录，**不应手动修改**：

```
/home/xsuper/workspace/.vinkoclaw/tasks/<task-id>/
  _run_<timestamp>.py      ← run_code 执行的临时脚本
  _run_<timestamp>.sh
  output.txt               ← 中间输出
  report.pdf               ← 最终产物（应同时 write_file 到工作区）
```

### 系统数据

```
/home/xsuper/workspace/vinkoclaw/.data/
  vinkoclaw.sqlite         ← 任务/配置数据库，禁止直接修改
```

---

## Agent 行为规范

### 创建项目时

1. 在工作区根目录下创建项目目录：`/home/xsuper/workspace/<project-name>/`
2. 初始化必要文件（README.md、package.json 等）
3. 通过 `write_file` 写入源码文件
4. 返回项目目录路径作为交付物

### 生成文档/报告时

1. 优先使用 `write_file` 写入 Markdown 到工作区根目录
2. 需要 PDF 时用 `run_code` 执行 Python（`reportlab` / `weasyprint`）生成，然后把路径写入 deliverable
3. 文件命名语义化：`<topic>-report.md`、`<topic>-prd.md`

### 执行代码时

1. 使用 `run_code` 工具，不要只输出代码文本
2. 如需安装依赖：`run_code(bash, "pip install xxx -q")`
3. 生成的文件路径在 tool result 中会自动记录

---

## 服务启动规范

| 服务 | 启动命令 | tmux session |
|------|----------|-------------|
| orchestrator | `npm run dev:orchestrator` | `vinko-orchestrator` |
| task-runner | `npm run dev:task-runner` | `vinko-runner` |
| 全部 | `npm run dev` | - |

task-runner **必须**随 orchestrator 同时启动，否则所有任务将停留在 `queued` 状态。
