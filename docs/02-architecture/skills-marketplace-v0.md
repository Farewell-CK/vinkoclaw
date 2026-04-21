# Skills Marketplace v0

## Goal

Let VinkoClaw discover skills from a local catalog and a remote registry, while keeping installation safe and explicit.

## Current Flow

1. Search marketplace candidates from local catalog plus optional `VINKO_SKILL_REGISTRY_URL`.
2. Show each candidate as one of:
   - `local_installable`: already wired into local runtime, can be installed directly.
   - `discover_only`: visible from registry, but not yet supported by local runtime.
3. If the user selects a `discover_only` skill, VinkoClaw creates an engineering task to integrate it instead of failing silently.

## Registry Contract

Use a JSON payload like [config/skills.registry.example.json](/data/workspace/code/vinkoclaw/config/skills.registry.example.json).

Supported fields:
- `id`, `skillId`, `name`, `description`, `summary`
- `allowedRoles`, `aliases`, `tags`
- `sourceLabel`, `sourceUrl`, `version`
- `installable`

`installable=true` in the registry does not mean the skill can be installed immediately. The marketplace also checks whether the local runtime already has a matching skill definition.

## Installed Binding Metadata

When a skill is installed, `skill_bindings` now records:
- `installed_at`
- `source`
- `source_label`
- `source_url`
- `version`

This gives VinkoClaw enough provenance to support future upgrade, lock, and sync behavior.

## Next Iteration

- Support remote runtime bundle download instead of only local definitions.
- Add version upgrade and reinstall actions.
- Add a dedicated task template for `discover_only -> runtime integration`.
