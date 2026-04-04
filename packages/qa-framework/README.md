# flywheel-qa-framework

Reusable QA Agent Framework — plan-aware testing pipeline.

Extracted from GeoForge3D's QA Agent v2 (GEO-308). Provides a generic 5-step QA protocol that any project can adopt by providing project-specific configuration.

## Architecture

```
Layer 1: qa-framework (this package)     Layer 2: your project
├── agents/qa-parallel-executor.md  ←→   .claude/qa-config.yaml
├── skills/backend-test/SKILL.md    ←→   .claude/skills/backend-test/{project}-test-suite.md
├── orchestrator/{state,track,lock} ←→   (consumed via config-bridge.sh)
└── src/config/ (TypeScript loader)
```

## Quick Start

1. Copy `templates/qa-config.yaml` to your project's `.claude/qa-config.yaml`
2. Fill in your project's domains, API config, and test skills
3. Create a test suite config (see `templates/backend-test-suite.md`)
4. The QA agent reads your config and runs the 5-step protocol

## 5-Step Protocol

1. **Onboard** — Load config, obtain plan file, verify environment
2. **Analyze + Plan** — Extract acceptance criteria, classify changes, generate test spec
3. **Research** — Read OpenAPI spec, domain docs, existing tests
4. **Write + Execute** — Create ad hoc tests, run iteratively until all pass
5. **Finalize** — Update skill files, run regression, generate report

## Config Schema

See `templates/qa-config.yaml` for the full annotated schema.
TypeScript types: `import { QaConfig } from 'flywheel-qa-framework'`

## Examples

- `examples/geoforge3d/` — Full GeoForge3D configuration

## Contracts

- `contracts/PLAN_SOURCE_CONTRACT.md` — How QA agents obtain plan files across worktrees
- `skills/SKILL_INTERFACE.md` — Interface contract for all QA test skills
