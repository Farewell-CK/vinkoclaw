# Repository Guidelines

## Project Structure & Module Organization
VinkoClaw is an npm workspace monorepo with core code in `apps/`, `services/`, and `packages/`.

- `apps/`: entrypoints and UI surfaces such as `feishu-gateway` and `control-center`
- `services/`: long-running backend processes like `orchestrator`, `task-runner`, and `email-inbound`
- `packages/`: shared libraries, runtime modules, protocol types, and plugins under `packages/plugins/`
- `scripts/`: developer automation such as self-checks and runner orchestration
- `prompts/`, `config/`, `docs/`: role prompts, environment guidance, and architecture or delivery docs

Place tests next to source files with the `*.test.ts` suffix, for example `services/orchestrator/src/goal-run-routing.test.ts`.

## Build, Test, and Development Commands
- `npm install`: install workspace dependencies
- `npm run dev`: start orchestrator, multiple task runners, and email inbound together
- `npm run dev:orchestrator`: run only the orchestrator service
- `npm run dev:task-runner:multi`: run multiple task runners for parallel execution
- `npm run typecheck`: run TypeScript checks across workspaces
- `npm run test`: run the Vitest suite
- `npm run ci:check`: run the standard local pre-PR check (`typecheck` + `test`)
- `npm run self-check` or `npm run self-check:product`: validate environment and product behavior

## Coding Style & Naming Conventions
Use TypeScript with ES modules. Follow existing style: 2-space indentation, semicolons, and small focused modules. File names are typically kebab-case, such as `goal-run-routing.ts`; exported types and classes use PascalCase, functions and variables use camelCase, and workspace packages use the `@vinko/*` scope.

There is no separate lint config in the repo today; `npm run typecheck` is the effective quality gate and should stay clean.

## Testing Guidelines
Vitest is the test runner. Keep unit tests adjacent to implementation and name them `*.test.ts`. Cover routing, policy, and shared-library changes with targeted tests before opening a PR. Use `npm run ci:check` when touching multiple packages or services.

## Commit & Pull Request Guidelines
Recent history uses short conventional prefixes such as `feat:`, `fix(...)`, `docs:`, and `ui:`. Keep commit messages imperative and scoped when helpful, for example `fix(orchestrator): harden approval route parsing`.

PRs should include a concise summary, impacted packages or services, linked issues if applicable, and verification notes listing commands you ran. Include screenshots for `apps/control-center` changes.

## Security & Configuration Tips
Start from `config/.env.example` when adding local configuration. Do not commit secrets, generated `.env` files, or database contents from `.data/`. If you change channel integrations or model backends, run `npm run self-check:product` before merging.
