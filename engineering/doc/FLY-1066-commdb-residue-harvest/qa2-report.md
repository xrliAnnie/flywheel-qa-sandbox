# FLY-1066 残留治理(双层)— 独立 QA 报告(第二轮 / 全 scope)

Issue: FLY-1066
日期: 2026-07-16
基于: plan.md(双层 A1/A2/A3/A4 + B1/B2)、qa-report.md(第一轮 ②-only scope)

**验证 head**: `6fb1523da2ac987702c14c5778f025e3b12849b1`(= PR #616 headRefOid,逐字一致)
**PR**: #616 · base `main` · mergeable=MERGEABLE
**Scope 基线**: `origin/main` = `26a8af1ed`(本地 main 落后 1 commit,已 fetch 校正)
**FLY-1066 真实改动**: 40 文件 / +4211 −127(不含 doc)

## 0. 结论

**QA 判定 = PASS**(代码层面已独立验证,零回归)。

**但 ship 前置未满足**:Codex code review 对本 head **尚未跑**(见 §6)。这不是代码缺陷,
是流程门 —— 我不 waive,也不代 implement 开 approve gate。

## 1. 测试执行(全部独立复跑,不采信实现者自报)

| 层 | 套件 | 结果 |
|---|---|---|
| A1 CommDB | flywheel-comm: db / db.fly1066-contention / cleanup | **114/114 绿** |
| A2 同步队列 + 五写入面 | teamlead: terminal-commdb-sync(+wiring) / commdb-fsm-reconcile / commdb-session-prune / statestore-ghost-reconcile / orphan-escalation-reconcile / complete-marker-reconciler / DirectEventSink / StateStore.detection-escalations | **191/191 绿** |
| B1/B2 兜底层 | bridge: residue-harvest / layer-interaction / stale-blocker-guard / pre-registration-cleanup / lifecycle-closeout / ghost-realprobe | **91/91 绿** |
| 读侧 | terminal-mcp 全量 | **37/37 绿** |
| 全仓回归 | teamlead 全量(clean env) | **7954 passed / 13 skipped** |
| Lint | biome check packages/ | **0 error**(14 条既有 warning) |

真两进程 migration contention 测试实测耗时 11.6s —— 是真锁竞争,非 mock。

## 2. 突变验证(核心 —— 负向断言不许空过)

本票大量断言是**负向/反向哨兵**(`flag=0 零 enqueue`、`probe alive → keep`、`fail-closed`)。
按 [[feedback_vacuous_green_fixture_disables_the_thing_asserted]]:**负向断言必须突变验证**,
否则机制根本没开也是绿的。逐条打断守卫,确认测试变红:

| 突变(打断的守卫) | 期望 | 实测 |
|---|---|---|
| M1a 去掉 `warmProjects` 的 `!deps.enabled` 早退 | RED | ✅ CAUGHT(1 failed) |
| M1b 同时去掉 enqueue + warm 两道 kill-switch | RED | ✅ CAUGHT(1 failed) |
| M2 去掉 `isTerminalStatus` 过滤(任何状态都入队) | RED | ✅ CAUGHT(1 failed) |
| M3 `authoritative !== targetStatus` → `false`(写陈旧状态) | RED | ✅ CAUGHT(1 failed) |
| M4 harvest flag 失效(扫描集恒定扩展) | RED | ✅ CAUGHT(1 failed) |
| M5 `state !== "dead"` → `false`(不看探针就删) | RED | ✅ CAUGHT(1 failed) |

**6/6 全部被抓 —— 无空过绿测。**

> **harness 自纠(必须记录)**:第一版 M1 只摘掉 enqueue 里的 `!deps.enabled`,测试仍绿,
> 我一度记为 VACUOUS。复查发现 kill-switch 是**两道冗余守卫**:`warmProjects` 也 `!deps.enabled` 早退 →
> `readyProjects` 为空 → enqueue 仍被 `!readyProjects.has()` 挡下。即**测试没坏,是我的突变不够狠**。
> 补 M1a/M1b 打断真正承重的那道后立刻变红。→ 定论:**不是缺陷**。
> 教训:突变必须打到承重守卫;冗余防御会让"半截突变"假报 vacuous。
> harness 内置 `git diff` 闸门(突变未落盘 → 判 HARNESS-BUG 而非 VACUOUS),防"尺子坏了还不知道"。

## 3. 真机端到端产品测试(真 SQLite / 真 CommDB / 零 mock)

`scratchpad/e2e-fly1066.mjs` —— 直接加载 **production 实际加载的 `dist/db.js`**,**16/16 通过**:

**A. 阳性对照 —— 先证明 bug 真实存在**(按 [[feedback_tool_success_line_is_not_evidence]]:
任何"修好了"必须同尺打中一个已知阳性):
- 旧 schema CommDB **物理拒绝** `status='failed'` → `CHECK constraint failed` ✅
- ∴ 行**永久卡在 `running`** = FLY-1066 症状的**根因铁证**(不是推测,是复现)

**B. 迁移**:旧库开新码 → 行逐字段保全(tmux_window/issue_id/lead_id/vendor/status)+ `'failed'` 可写 + 重开幂等 ✅

**C. 产品面 —— Lead 到底看见什么**(这才是用户可用性):
- 修前形态:崩溃 runner 永远挂在 running
- 修后:`markSessionTerminalStatus` → **离开 active/running 列表** + **在 Lead terminal 列表显示 `failed`** + `countTerminalSessions` 计入 + **tmux_window 保留**(retry teardown 不断) ✅

**D. `ended_at` first-terminal-write**:重复 mark 不漂移,status 跟最新 ✅
**E. CAS**:adapter 尾写**不覆盖**权威 `failed`;但仍能正常收敛 running 行(阳性对照)✅
**F. 晚注册**:mark 后 runner 自注册**不复活**成 running ✅

## 4. ②兜底层 —— 真生产数据 preflight(READ-ONLY)

先审计脚本确认零写入(只 `cp` 快照后读副本;`tmux list-panes` 为读探针),再对 7 份**真生产库**跑同谓词:

```
================ TOTALS: HARVEST=20  KEEP=19 ================
```
证据存档:`qa2-preflight-output.txt`

**零误杀阳性对照(全部在真实行上验到)**:
- `6b3afba8 fsm=blocked probe=alive → KEEP` ← **preserve 哨兵在真数据上真的开火**(blocked 但窗口活 = 不动)
- `design_done` / `awaiting_review` 全部 KEEP —— 结构性 park 不可触(§2 硬约束)
- **本 QA 会话自己 `61ec7494`(running)→ KEEP**;**FLY-1066 implement 会话 `2dda78be`(awaiting_review)→ KEEP** —— 收割器不吃自己的流水线
- `sub` → `NOT-CONFIGURED:not-harvested-by-main-bridge` —— 三重门的"已注册项目"闸生效
- HARVEST 20 条**无一例外**都是 `fsm=failed|blocked` **且** probe=dead

## 5. 回归三查(37 个本机失败 —— 全部证伪为环境,非本 PR)

**CI 在本 head `6fb1523da` 上 PASS**(run 29526231702,head_sha 逐字核对)。本机 37 红逐条定因:

| 失败 | 数量 | 真因 | 证据 |
|---|---|---|---|
| codex-lead-runtime | 22 | **`TMPDIR` 落在 `~/.flywheel` 下** → FLY-245 安全守卫正确拒绝(守卫在**正常工作**) | 换干净 TMPDIR → **22 全绿** |
| run-dispatcher | 9 | **`FLYWHEEL_RUNNER_BACKEND=codex`** 从我的 runner 会话泄漏 → 强制 codex 后端 | `env -u` 后 → **49/49 全绿** |
| preflight / thread-archive / worktree-quarantine / real-tmux | 5 | load 超时(实测 5000-6400ms 撞 5s 门;load 21.73 / 18 核) | 串行重跑 → **4/5 绿** |
| fly574-bash-suites | 1 | 探真 launchctl;**FLY-1066 touch 零个 `scripts/` 文件**,该测试与其目标脚本与 main **逐字节相同** | 定义上不可能由本 PR 引起;CI(Linux)绿 |

**结论:FLY-1066 零回归。**(呼应 [[reference_ship_eligibility_test_local_env_flake]] / [[reference_qa_codex_lead_runtime_tmpdir_overlap]]:本机红别错怪 PR;
并呼应 [[reference_macos_prod_linux_ci_platform_fact_blindspot]]:生产=Mac / CI=Linux 的平台盲区。)

## 6. ⚠️ Ship 前置未满足(交 Tadashi 裁,不由我 waive)

- **Codex code review 对本 head 未跑**。依据(非推测):
  1. implement 自己的 `progress.md` = `phase: implement 6/7`,`nextStep: "…open a fresh cross-family code review"`;
  2. doc 文件夹只有 `design-review-*.md`(design 4 轮 + dual 2 轮),**无任何 code-review 产物**;
  3. PR #616 comments 只有 linear-linkback,**无 Codex 评审记录**。
- FLY-827 的 merge 门认 durable `codex_review_record`([[reference_codex_review_record_how_earned.md]]:**跑了 Codex ≠ 有记录**)。
- ∴ **implement 阶段尚未完成**。我不开 approve gate —— 不拿未过 code review 的码去踢 founder 批准
  ([[feedback_dont_waive_codex_review_when_available]] / [[feedback_never_ask_ship_if_not_tested]])。

## 7. 部署注记(不阻塞本轮 QA)

- ①层为**根因治本**:新 failed/blocked **不再产生**僵尸(即时如实化)。
- ②层为 **fsck 兜底**:存量 20 条候选需**下次 Bridge 重启**才收(plan §7 = deploy 即验收)。
- Bridge 重启 = 破坏性 + founder-gated;本轮**未执行**,亦**未碰任何生产库**(preflight 只读副本)。
- 重启后应由**独立 QA 复查生产库**,不采信实现者自报([[feedback_independent_qa_before_destructive_deploy]])。

## 8. 复现命令

```bash
# 突变验证
bash <scratchpad>/mutate.sh ; bash <scratchpad>/mutate2.sh
# 真机 E2E(真 SQLite + 阳性对照)
node <scratchpad>/e2e-fly1066.mjs           # → 16 passed
# 只读 preflight(真生产快照)
bash <scratchpad>/preflight.sh              # → HARVEST=20 KEEP=19
# 干净环境跑全仓(否则会被 TMPDIR / FLYWHEEL_RUNNER_BACKEND 污染)
cd packages/teamlead && env -u FLYWHEEL_RUNNER_BACKEND TMPDIR=<clean> npx vitest run
```
