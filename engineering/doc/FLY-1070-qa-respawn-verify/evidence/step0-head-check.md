# FLY-1070 Step 0 环境准备与 head 校验 — 证据记录
Issue: FLY-1070 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md

记录时间: 2026-07-09 15:26 PT (QA session runner-3f8f8424, exec 3f8f8424-c487-43d9-a63a-fb398a886114)

## Head 校验

```
$ git fetch origin flywheel-FLY-1050
$ git rev-parse origin/flywheel-FLY-1050
5da5fd180bfd88abefbcb5035008ba998ac63241        # == 5da5fd18 ✅

$ gh pr view 528 --json state,headRefOid,statusCheckRollup
state:      OPEN ✅
headRefOid: 5da5fd180bfd88abefbcb5035008ba998ac63241 ✅
checks:     Build & Test — COMPLETED / SUCCESS ✅ (at head)
```

## QA worktree(自建,绝不碰 parked implement 工作区)

```
$ git worktree add worktrees/qa-fly-1070 5da5fd18 --detach
HEAD is now at 5da5fd18 chore(config): register FLYWHEEL_THREE_STAGE_QA_RESPAWN in the flag registry (FLY-1050)
$ git -C worktrees/qa-fly-1070 rev-parse HEAD
5da5fd180bfd88abefbcb5035008ba998ac63241 ✅
```

- 未触碰 `/Users/xiaorongli/Dev/flywheel-FLY-1050`(parked implement 工作区,本地有未 push commit)。
- QA 一切构建/测试均在 `worktrees/qa-fly-1070`(detached @ 5da5fd18)内进行。

## 负载预检(OOM 恢复期纪律)

```
$ uptime
15:26  up 10 days, load averages: 42.62 40.29 36.30   (18 cores)
$ vm_stat: Pages free ≈ 166k × 16KB ≈ 2.6 GB free
```

判读:共享生产机常态高载(多 agent);内存有余量。执行纪律:所有 vitest 逐文件**串行**、
单 worktree、不起真 runner、不重启 Bridge、不占 529 Room、生产 DB 零接触(F10 形态直接
引用 research.md §4 已完成的只读取证,本 session 不再开生产库)。

## 构建

- `pnpm install` + `pnpm --filter flywheel-teamlead... build`(teamlead + 依赖包重建 dist;
  harness 一律 import dist 产物——issue 面 1 明文要求)。输出见 step0-build.log。
