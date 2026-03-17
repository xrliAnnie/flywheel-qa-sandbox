# Contributing to Flywheel

**Last Updated:** 2026-03-06

## Project Overview

Flywheel is a TypeScript orchestrator (forked from [Cyrus](https://github.com/ceedaragents/cyrus)) that automates developer workflow:

```
Linear issues -> DAG resolver -> Claude Code sessions (tmux) -> auto PR -> Decision Layer -> Slack notifications
```

The goal is autonomous dev execution where human attention is the bottleneck, not AI capability. CEO sets direction, Flywheel executes continuously, only escalating when it genuinely needs a human decision.

## Prerequisites

- **Node.js** >= 22 (CI pins to Node 22 LTS via `.node-version`; ES2022 target)
- **pnpm** 10.13.1 (`corepack enable && corepack prepare pnpm@10.13.1 --activate`)
- **TypeScript** ^5.3.3

## Setup

```bash
git clone https://github.com/ceedaragents/flywheel.git
cd flywheel
pnpm install
pnpm build
```

## Scripts Reference

All scripts are run from the monorepo root.

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `pnpm build` | Build all packages recursively (`pnpm -r build`) |
| `dev` | `pnpm dev` | Watch mode for all packages in parallel |
| `test` | `pnpm test` | Run all tests across the monorepo |
| `lint` | `pnpm lint` | Run Biome linter checks |
| `format` | `pnpm format` | Auto-format with Biome (write + unsafe fixes) |
| `test:packages` | `pnpm test:packages` | Test `packages/*` only |
| `test:packages:run` | `pnpm test:packages:run` | Single-run tests for `packages/*` (no watch) |
| `test:apps` | `pnpm test:apps` | Test `apps/*` only |
| `typecheck` | `pnpm typecheck` | TypeScript type checking across all packages |
| `prepare` | `pnpm prepare` | Husky git hooks setup (runs automatically on install) |

To run scripts for a specific package:

```bash
pnpm --filter flywheel-teamlead test
pnpm --filter flywheel-edge-worker build
```

## Packages

The monorepo contains 9 packages under `packages/`:

| Package | npm Name | Description |
|---------|----------|-------------|
| `core` | `flywheel-core` | Shared types, interfaces, and Zod schemas used across all packages |
| `config` | `flywheel-config` | Configuration loader for `.flywheel/config.yaml` project files |
| `dag-resolver` | `flywheel-dag-resolver` | Dependency DAG resolution using Kahn's topological sort for Linear issues |
| `claude-runner` | `flywheel-claude-runner` | Claude Code CLI execution wrapper (tmux/cmux session management) |
| `edge-worker` | `flywheel-edge-worker` | Main orchestrator: Blueprint generation, Decision Layer, Reactions engine |
| `linear-event-transport` | `flywheel-linear-event-transport` | Linear webhook receiving and signature verification |
| `github-event-transport` | `flywheel-github-event-transport` | GitHub webhook receiving and signature verification |
| `slack-event-transport` | `flywheel-slack-event-transport` | Slack webhook receiving and verification |
| `teamlead` | `flywheel-teamlead` | TeamLead daemon: event pipeline, Socket Mode Slack, template notifications, action execution |

### Dependency Graph (internal)

```
teamlead
  -> edge-worker
       -> claude-runner -> core
       -> config
       -> core
       -> dag-resolver
       -> linear-event-transport -> core
       -> github-event-transport -> core
       -> slack-event-transport  -> core
  -> core
```

## Testing

- **Framework**: [Vitest](https://vitest.dev/)
- **Approach**: TDD (RED -> GREEN -> REFACTOR)
- **Coverage target**: 80%+

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter flywheel-teamlead test

# Single-run (no watch mode) for CI
pnpm test:packages:run

# Run with coverage (where configured)
pnpm --filter flywheel-edge-worker test:coverage
```

Test files live in `__tests__/` directories alongside the source code they test.

## Linting and Formatting

- **Linter/Formatter**: [Biome](https://biomejs.dev/) (v2.1.3+)
- **Pre-commit hooks**: Husky + lint-staged runs `biome check --write --unsafe` on staged `*.{js,jsx,ts,tsx,json}` files

```bash
# Check for lint errors
pnpm lint

# Auto-fix and format
pnpm format
```

Biome configuration is in `biome.json` at the repo root. Notable settings:
- `noNonNullAssertion`: off
- `noExplicitAny`: off
- VCS-aware (uses `.gitignore`)

## Git Workflow

### Branching

- **Main branch**: `main`
- **Feature branches**: `feat/<description>` (e.g., `feat/v0.2-step2c-notifications`)
- **Fix branches**: `fix/<description>`

### Commits

Use [conventional commits](https://www.conventionalcommits.org/):

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

Examples:
```
feat: add stuck watcher for long-running sessions
fix: use character-level truncation for commit messages in Block Kit
refactor: simplify stub handler to use shared postSlackResponse utility
docs: add v0.2 Step 2c implementation plan
```

### Pull Requests

- PRs target `main`
- Code review required before merge
- All CI checks must pass (lint, typecheck, tests)
- Link relevant Linear issues in the PR body

## TypeScript Configuration

The monorepo uses a shared `tsconfig.base.json` with:
- **Target**: ES2022
- **Module**: ESNext
- **Strict mode**: enabled
- **Additional strictness**: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`

Each package extends the base config in its own `tsconfig.json`.

## Project Structure

```
flywheel/
  CLAUDE.md              # AI assistant instructions
  VISION.md              # Product vision
  biome.json             # Linter/formatter config
  tsconfig.base.json     # Shared TypeScript config
  package.json           # Root scripts and devDependencies
  pnpm-workspace.yaml    # Workspace definition
  packages/
    core/                # Shared types
    config/              # Config loader
    dag-resolver/        # DAG resolution
    claude-runner/       # Claude CLI wrapper
    edge-worker/         # Main orchestrator
    linear-event-transport/
    github-event-transport/
    slack-event-transport/
    teamlead/            # Daemon process
  doc/                   # Design docs, plans, research
    architecture/        # Architecture documents
    exploration/         # Product exploration / design
    research/            # Technical research
    deep-research/       # External LLM research
    plan/                # Implementation plans
    implementation/      # Implementation notes
    reference/           # Reference materials
  docs/                  # Operational documentation
  scripts/               # Build/utility scripts
```
