# Retro: Sprint 2026-03-30 (Orchestrator v1.18.0)

**Date**: 2026-03-30
**PRs**: #73, #74, #75, #76, #78, #79, #80, #81, #82, #83 (+ GeoForge3D #112, #114, #119, #120, #121)
**Trigger**: Large sprint with multiple direction changes, operational issues during E2E testing

## Timeline

- 5 agents spawned in parallel (GEO-200, GEO-302, GEO-294, GEO-292, GEO-203)
- GEO-302 (lint fix) shipped in ~20 min
- GEO-292 PR #77 closed — wrong direction (progress reporting vs Lead orchestration)
- FLY-2 first attempt wrong (CLI skill vs GitHub Actions) — completely redone
- GEO-294 direction changed 4 times (Supabase variants → Vercel → publish pipe)
- Multiple operational issues found during E2E: allowBots, permission mode, TTY guard, terminate tmux
- 3 hotfix PRs created and merged same day (#81, #82, #83)

## Root Causes

### RC-1: Agent misunderstood requirements (2 occurrences)
- **Category**: Process Gap
- **Chain**: Vague spawn prompt → agent interprets differently → wrong implementation → close PR → redo
- **Evidence**: GEO-292 PR #77, FLY-2 initial CLI skill

### RC-2: Version number management
- **Category**: Tooling Issue
- **Chain**: Orchestrator reads current version → uses it for new branches → wrong version
- **Fix**: Added `compute_next_version()` to config.sh, updated orchestrator.md

### RC-3: External service assumptions (GEO-294)
- **Category**: Missing Knowledge
- **Chain**: Assumed Supabase Storage serves HTML with correct Content-Type → it doesn't → 4 direction changes
- **Fix**: Added "Spike before commit" rule to CLAUDE.md

### RC-4: Integration issues only found in E2E
- **Category**: Missing Validation
- **Chain**: Unit tests pass → deploy → Lead can't receive bootstrap / can't run Bash / tmux not killed
- **Fix**: Lead restart E2E checklist in memory

## Fixes Applied

| # | Description | Target | Status |
|---|-------------|--------|--------|
| 1 | Orchestrator must give specific reference files in spawn prompt | `orchestrator.md` | Applied |
| 2 | Version management: compute_next_version | `config.sh` + `orchestrator.md` | Applied (earlier) |
| 3 | Spike before commit for external services | `CLAUDE.md` | Applied |
| 4 | Lead restart E2E checklist | Memory | Applied |
| 5 | allowBots must include self bot ID | Memory | Applied (earlier) |
| 6 | Agent.md scalability exploration | FLY-26 | Deferred |

## Lessons Learned

1. **给 agent 的 prompt 要极其明确** — 不能说"做 X"，要说"参考 Y 文件，用 Z 方式做 X，不要做 W"
2. **涉及外部服务先 spike** — Supabase Storage 的 Content-Type 问题如果先花 5 分钟验证，能省 2 小时方向变更
3. **Integration 问题靠 E2E 发现** — unit test 覆盖不了 allowBots、permission mode、TTY 等运维层面问题

## Prevention Score

- Fix 1 (spawn prompt): **Medium** — 文档约束，需要人遵循
- Fix 3 (spike): **Medium** — 文档约束
- Fix 4 (checklist): **Medium** — 文档约束
- Fix 5 (allowBots): **Medium** — memory 记录
- Fix 6 (FLY-26): **Low** — 尚未实施，等 Deep Research 结果
