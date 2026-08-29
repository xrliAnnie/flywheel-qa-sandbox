# FLY-1165 Done-thread 积压扫清 + 归档级联根因修 — QA 报告

Issue: FLY-1165 (https://linear.app/geoforge3d/issue/FLY-1165)
日期: 2026-07-11
基于: plan.md（Codex design APPROVED, R3）+ 已提交的 implement 代码（本分支 HEAD 12d55e48）+ deliverable1-report.md
阶段: 三段式 QA（独立验证，不重新实现）

**Verdict: ✅ PASS**

交付 1（生产数据操作）已在生产落地并逐条核实无误；交付 2（源码兜底）单测全绿、
模块驱动真数据 dry-run 红线 56/56 通过、无回归。全票安全护栏（三段 veto / fail-closed /
archive-once / 不锁线程）经真机数据与单测双重锁死。

---

## 1. 验证范围 & 方法

- 分支: `flywheel-FLY-1165` @ `12d55e48`；PR #553（CI **Build & Test: SUCCESS**）。
- PR 真实 diff（对 `origin/main`）= **21 文件全部 FLY-1165**（本地 `main` 落后 → `main...HEAD`
  的 378 文件是本地 main 陈旧的假象，非 PR 污染，已核实）。
- 独立重跑全部单测 + 模块驱动 dist 真数据 dry-run + 生产 DB/Discord/Linear 三方核实交付 1。

## 2. 交付 1 复核（安全扫清，生产已执行）

report 声称：archived 28 / skipped_active 6 / skipped_live_session 1 / husk_finalized 7。逐条独立核实：

| 核实项 | 方法 | 结果 |
|--------|------|------|
| 剩余未归档 FLY-% 线程 == skip 集合 | fresh `sqlite3 -readonly` 查 `chat_threads`（channel #flywheel-engineer） | **恰 7 个**：FLY-718/962/1062/1073/1159/1165（active）+ FLY-1160（live）— 逐字等于 report 的 6 active + 1 live ✅ |
| 28 归档线程 `archived_at` 落库 | DB 逐条查 | **28/28 archived，0 仍未归档** ✅ |
| **红线：28 归档 issue 当前 Linear 状态** | **fresh** Linear GraphQL `issue(id:)` 逐个查（非缓存） | **28/28 全部 completed/canceled**，零 active 被误归档 ✅ |
| 7 skip issue 确为 active | fresh Linear | 7/7 = backlog/started（含本票 FLY-1165=started）→ 正确保留 ✅ |
| Discord 侧真归档 | bot `GET /channels/{id}` 抽查 6 个 | 6/6 `archived=true` **且 `locked=false`**（founder 可重开，避开 FLY-117 锁线程坑）✅ |
| skip 线程 Discord 侧未归档 | 同上，FLY-1160 + FLY-1165 | 2/2 `archived=false`（负对照）✅ |
| 7 husk finalize | DB 查 session status | 7/7 → `completed`（stale awaiting_review husk 清理生效，含 980 类）✅ |

**结论：交付 1 生产结果与 report 完全一致，红线（不归档 active）零违反。**
#flywheel-engineer 线程列表现只剩 active/live issue 的 7 个线程 → 待 Annie 目视终验。

## 3. 交付 2 行为级验证（源码兜底）

### 3.1 单测（独立重跑，全绿）
| 套件 | 结果 |
|------|------|
| `StateStore.fly1165-chat-threads.test.ts` | 3/3 ✅ |
| `done-thread-reconcile.test.ts` | 35/35 ✅（含 23 条红线 + 调度器 + stop 排水）|
| `done-thread-archiver.test.ts` | 17/17 ✅（sink archive-once + 并发串行 + never-throws + 抗前驱 rejection）|
| `post-ship-finalization.fly887.test.ts` | 8/8 ✅（post-ship 收编进 sink，顺序不变）|
| `scripts/__tests__/fly1165-sweep-decision.test.mjs`（node --test）| 18/18 ✅ |
| `scripts/__tests__/test-deploy-qa-room.test.sh` | 9/9 ✅（QA-slot 注入 `FLYWHEEL_DONE_THREAD_RECONCILE=0` 隔离）|
| `flywheel-config`（registry 含 done_thread_reconcile flag + 3 knob）| 365/365 ✅ |

### 3.2 模块驱动 dist 真数据 dry-run（最强安全证据）
`dist` 的 `reconcileDoneThreads` 跑**生产 DB 拷贝**（119 候选，全 6 项目：geoforge3d /
joycon-typeless / personal-assistant / growth / flywheel / tidal-echo），真 Linear + 真 tmux 存活探测：

- **Run A（dryRun=true，写 seam 全设为 throw-if-called）**：`scanned=119, dryRunWouldArchive=56,
  archived=0, huskFinalized=0, failed=0` → **零写 seam 触发，dry-run 契约成立**（sweep 不动任何东西）。
- **Run B（recorder seam，拷贝库，无真写）**：`scanned=119, archived(would)=56, huskFinalized=18,
  huskFinalizeFailed=0, skippedActive=11, skippedNotDone=52, failed=0`（119 = 56+11+52 ✅）。
- **红线：56 个 would-archive issue 逐个 fresh Linear 核实 → 56/56 全部 completed/canceled**
  （含 GEO-* / UUID 键 / LEARN-*，即交付 1 只清 #flywheel-engineer FLY-% 之外的全 fleet 积压）。
  **零 active issue 会被兜底 sweep 误归档。**

> 观察（非缺陷）：boot sweep 是 fleet-wide（非仅 #flywheel-engineer），下次 batched restart 会
> 按 `maxArchivesPerRun=25/pass`、`interval=360min` 分批清掉这 56 个真 Done 积压 —— 正是 FLY-369
> 四类泄漏的结构性兜底，且已证安全。属计划内行为，deploy 后 post-restart verify 可观察。

### 3.3 红线复验（对照 FLY-117 / FLY-742 家族坑）
- 三段 veto（初筛 / Linear 后 / finalize 后紧贴 archive）+ 全状态 liveness（terminal-status 活进程也 veto）
  + fail-closed（error/indeterminate/lookup-throw/tmux 异常 = 活）→ 23 条单测 + 真机 dry-run 双锁。
- finalize 失败 → 整条 thread 本轮 skip（fail-closed），不 archive over husk。
- sink 级 archive-once + per-thread 串行化 → 重开（含 post-ship 路径）不被再 PATCH；`already_archived`
  记幂等 no-op、绝不落 `chat_thread_archive_failed`。
- flag `FLYWHEEL_DONE_THREAD_RECONCILE=0` sentinel + `stop()` 协作排水（先于 store.close）经调度器测试锁死。

## 4. 回归验证（全 teamlead 套件）

`pnpm --filter flywheel-teamlead test`（6196 tests）在本 runner 机器上有 24–31 个 flaky 失败，
**全部与 FLY-1165 无关**，根因两条：

1. **`codex-lead-runtime.test.ts`（22 test）= 已知环境性假失败**：本 runner 的 `TMPDIR` =
   `~/.flywheel/runner-state/<execId>/browser-tmp`（落在 `~/.flywheel` 下），触发 codex-lead
   workspace-overlap 守卫（`codex-lead-runtime.ts:772`）。**换干净 TMPDIR 后 124/124 全绿**（已复现证明）。
   与 FLY-1165 零关系（该文件不 import 任何归档/reconcile 模块）。
2. **其余波动（31↔24 不稳定）+ `vitest-worker: Timeout calling "onTaskUpdate"`** = 本机高负载
   （load ~9，61 users，collect 耗时 425s）导致的 worker 通信超时 flakiness，非确定性失败。

**换干净 TMPDIR 重跑全套的铁证**：`Test Files 1 failed | 439 passed`、`Tests 2 failed | 6194 passed` ——
codex-lead-runtime 的 22 个假失败**全部消失**，只剩 `createLeadRuntime-preflight.test.ts` 的 2 个
残余失败（该文件隔离单跑通过 → 纯高负载 worker flakiness，仍伴 `Timeout calling onTaskUpdate`）。
**FLY-1165 全部文件绿**：done-thread-reconcile 35 ✓ / done-thread-archiver 17 ✓ / StateStore.fly1165 3 ✓
/ post-ship-finalization.fly887 8 ✓。

**权威信号**：GitHub CI（干净环境、干净 TMPDIR）跑全套 = **Build & Test SUCCESS**。
FLY-1165 自身 4 个测试文件（63 test）隔离下全绿且从不出现在任何失败列表中。
→ **FLY-1165 零回归。**

## 5. 本票自身的 dogfood 证据

FLY-1165 issue 现为 `started`（QA 进行中），故被交付 1 与 reconcile dry-run 双双正确 **skip**
（active 保留）。待本票 Done 后，reconcile boot sweep 会自动归档它自己的线程 —— 天然闭环验证。

## 6. QA 结论

- 交付 1：✅ 生产已安全落地，28 归档全部真 Done、7 active 正确保留、7 husk 清理、线程不锁。
  剩 Annie 目视确认 #flywheel-engineer 只剩 active 线程 = 终验。
- 交付 2：✅ 单测 + 真数据 dry-run（红线 56/56）+ dry-run 契约 + 无回归 全部通过。
- 无阻塞缺陷。**PASS**，进入 founder ship gate。
