# Scripts

Development, bootstrap, and deployment scripts live here.

- `run-task-runners.mjs`: spawn multiple `@vinko/task-runner` processes with `RUNNER_INSTANCE_ID`.
- `self-check.mjs`: legacy smoke check for queue/collaboration basics.
- `persona-test.mjs`: humanized end-to-end scenarios for routing/execution/reply quality.
  - `PERSONA_TASK_TIMEOUT_MS`: single-task timeout (default 900000).
  - `PERSONA_MAX_WALL_CLOCK_MS`: max wall-clock for a full run (default 1800000).
- `product-selfcheck.mjs`: end-to-end product behavior check (smalltalk fast-path, routing, continue semantics, cancel APIs, stale task/goal-run/approval cleanup).
- `product-selfcheck-watch.mjs`: periodic runner for `product-selfcheck`, writes reports to `.run/product-selfcheck/`.
- `product-selfcheck-daemon.mjs`: daemon manager for `product-selfcheck-watch` (`start|stop|status|restart`), writes PID to `.run/product-selfcheck/watch.pid` and logs to `.run/product-selfcheck/watch.log`.
