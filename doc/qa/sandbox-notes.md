# Flywheel QA Sandbox Notes

The `flywheel-qa-sandbox` repository is an isolated GitHub fork used by Flywheel's QA test-slot framework to exercise real Runner behavior end to end. Each slot clones the repository into a separate temporary workspace, starts its own Bridge and Lead processes, and launches a real Runner from a Linear issue instead of replacing the workflow with synthetic fixtures.

That isolation makes the repository a safe target for validating Runner branch and worktree creation, documentation or code changes, commits, pushes, pull requests, gates, and teardown without touching production repositories or resources. A test can also select a sandbox branch as the Runner start point, allowing framework changes to travel through the same Git and GitHub operations used by a live run.

The sandbox is disposable integration-test infrastructure rather than a second production source of truth. Test runs should stay inside their slot clone and use the framework's deploy, issue-injection, and teardown scripts so concurrent slots do not collide and residual worktrees or branches are cleaned up.

## Top-level directories

| Directory | Description |
| --- | --- |
| `.claude/` | Claude project commands, skills, QA configuration, and orchestration helpers. |
| `.flywheel/` | Project-local Flywheel configuration and executor role definitions. |
| `.github/` | GitHub Actions workflows and repository automation. |
| `.lead/` | Lead identities and shared Lead behavior rules. |
| `.serena/` | Serena project configuration and local metadata exclusions. |
| `agents/` | Prompt definitions for the generic and QA executor roles. |
| `doc/` | Primary architecture, engineering, QA, planning, and reference documentation. |
| `docs/` | Contributor guidance and operational runbooks. |
| `engineering/` | Issue-scoped engineering documents, evidence, and experimental spikes. |
| `fleet/` | Example manifests and environment configuration for managed Flywheel fleets. |
| `packages/` | pnpm workspace packages for the Runner, Bridge, transports, QA framework, and supporting services. |
| `patches/` | Version-controlled patches applied to dependencies. |
| `product/` | Issue-scoped product research, specifications, and prototypes. |
| `qa-fly294/` | Checked-in fixtures and results from the FLY-294 QA effort. |
| `qa-fly310/` | Checked-in scripts, evidence, and reports from the FLY-310 QA effort. |
| `scripts/` | Repository development, deployment, maintenance, and QA automation. |
| `supabase/` | Supabase CLI metadata and database migrations. |

## QA framework README summary

- `flywheel-qa-framework` is a reusable, plan-aware QA pipeline extracted from GeoForge3D's QA Agent v2.
- Its two-layer architecture pairs generic agents, skills, orchestration, and TypeScript config loading with project-specific `.claude/qa-config.yaml` and test-suite files.
- The five-step protocol covers onboarding, analysis and test planning, research, iterative test writing and execution, and final regression reporting.
- Projects adopt it by copying the annotated configuration template, defining their domains and APIs, and adding a test-suite configuration.
- The test-slot framework runs real Runners against `xrliAnnie/flywheel-qa-sandbox`; it does not provide a synthetic fixture mode.
- `test-deploy.sh`, `inject-linear-issue.sh`, and `test-teardown.sh` respectively create an isolated slot, start a Runner through the slot Bridge, and clean slot processes, worktrees, branches, and local state.
- Real-Runner tests require a Linear API key, authenticated GitHub CLI access, the sandbox fork, and the branch under test pushed to that fork.
- `FLYWHEEL_RUNNER_START_POINT` lets a test Bridge start worktrees from a selected sandbox branch while production keeps its default `origin/main` behavior.
- The FLY-60 suite exercises hard gates, while slot, shared-channel mirror, roundtable mirror, and alert mirror modes cover distinct isolated E2E topologies and explicitly restrict unsupported Runner paths.
- The README points to real-Runner and sandbox lifecycle guides and defines contracts for obtaining plan sources and implementing QA test skills.

## `doc/` listing

Command: `ls -R doc/ | head -50`

```text
FLY-202-qa-sandbox-fixture
VERSION
architecture
engineer
plan
qa
reference
retro

doc//FLY-202-qa-sandbox-fixture:
FLY-202-d1-e2e-chain.mmd
FLY-202-d1-e2e-chain.svg
FLY-202-d2-five-steps.mmd
FLY-202-d2-five-steps.svg
FLY-202-d3-doc-model.mmd
FLY-202-d3-doc-model.svg
FLY-202-d4-branch-hygiene.mmd
FLY-202-d4-branch-hygiene.svg
FLY-202-design.html
design.md
plan.md
progress.md
workflow-output.json

doc//architecture:
archive
capability-matrix.md
flywheel-agent-architecture-diagram.html
flywheel-agent-architecture-diagram.mmd
flywheel-agent-architecture-diagram.svg
infra-alerts-spec.md
product-experience-spec.md
v0.2-architecture.md
v2.0-product-vision.md

doc//architecture/archive:
v0.1.0-flywheel-orchestrator.md

doc//engineer:
deep-research
exploration
implementation
onboarding
plan
qa
research

doc//engineer/deep-research:
001-decision-layer-gemini.md
002-decision-layer-chatgpt.md
```
