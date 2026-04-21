# VinkoClaw Workspace Conventions

工作区根目录：本系统目录 `vinkoclaw/`

---

## 目录规范 (Project-Centric Organization)

为了应对多项目并发开发，防止文件混乱，VinkoClaw 采用**以项目为中心**的目录隔离规范。所有生成的项目内容统一存放在 `./projects/` 目录下。

### 1. 项目主目录 (Project Root)

AI 执行创建的所有独立项目（包括源码、交付物、资产等）必须按项目名称隔离，存放在 `./projects/<project-name>/` 下：

```
./projects/
  chain-hotel-system/      ← 酒店管理系统
    code/                  ← 源码工程
    docs/                  ← PRD、架构设计、报价单、合同
    assets/                ← Logo、UI 原型、架构图、效果图
    reports/               ← 测试报告、竞品分析调研
  coffee-shop-app/         ← 咖啡店小程序
    code/
    docs/
    assets/
```

命名规则：项目名称全小写，单词用短横线分隔。禁止使用空格、中文。

### 2. 全局模板 (Templates)

跨项目通用的标准化文档模板：

```
./templates/
  prd-template.md          ← 标准产品需求文档模板
  quote-template.md        ← 标准外包报价单模板
```

### 3. 任务临时文件 (Temporary Sandbox)

Agent 执行期间的临时脚本、中间产物，严格限制在沙箱内，系统会自动清理：

```
./.vinkoclaw/tasks/<task-id>/
```

### 4. 系统数据 (System Data)

```
./.data/
  vinkoclaw.sqlite         ← 核心数据库，禁止直接修改
```

---

## Agent 行为规范

1. **确立项目代号**：在多角色协作 (GoalRun) 开始时，PM 或 CTO 必须先明确当前项目的英文代号（如 `chain-hotel`）。
2. **源码落地**：前端/后端在生成独立系统时，必须写入 `./projects/<project-name>/code/` 目录。
3. **文档归档**：所有文本和图片输出，必须严格写入 `./projects/<project-name>/` 下的对应子目录（`docs/`, `assets/`, `reports/`）。
4. **禁止越权**：严禁修改 `vinkoclaw` 自身的 `src/` 或 `packages/` 核心代码。

---

## 服务启动规范

| 服务 | 启动命令 | tmux session |
|------|----------|-------------|
| orchestrator | `npm run dev:orchestrator` | `vinko-orchestrator` |
| task-runner | `npm run dev:task-runner` | `vinko-runner` |
| 全部 | `npm run dev` | - |

task-runner **必须**随 orchestrator 同时启动。