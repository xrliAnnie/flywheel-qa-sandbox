# FLY-1466 剥 #696 三个新 feature flag 再 ship — 调研

Issue: FLY-1466 (https://linear.app/geoforge3d/issue/FLY-1466/p1剥-flag-fly-1448-696-剥-3-个新-feature-flag-再-ship-在既有分支上做不新建分支)
日期: 2026-07-24
基于: exploration.md

以下全部事实取自 worktree `~/Dev/flywheel-FLY-1448` @ `b863b4d8`(= PR #696 head)与 `origin/main` @ `dc754746` 实测。

## 1. 逐读点剥除形态

### 1.1 `engine_declared_park`(FLYWHEEL_ENGINE_DECLARED_PARK)→ 无条件启用

| 位置 | 现状 | 剥后 |
|------|------|------|
| `plugin.ts:7888`(`isDurablyParked`) | `if (process.env.FLYWHEEL_ENGINE_DECLARED_PARK === "0") return false;` 在 CommDB park 查询前短路 | 整行删除,直接查 `getWorkflowEnginePark(executionId)?.state === "open"` |
| `plugin.ts:8013`(`isEngineParked` dep) | 同形 3 行短路块 | 整块删除 |
| `plugin.ts:8259`(`projectWorkflowEngineParkOutbox` 调用) | `enabled: () => process.env.FLYWHEEL_ENGINE_DECLARED_PARK !== "0",` | 该参数行删除 |
| `StateStore.ts:11062`(`appendWorkflowEngineParkEventTx`) | `if (... === "0") return undefined;` 短路(不写 outbox 行) | 整行删除 |
| `workflow-engine-park-projector.ts:9,16` | `enabled?: () => boolean` 依赖项 + `if ((deps.enabled ?? (() => true))() === false) return 0;` 守卫 | **随手删**:该选项唯一存在理由就是这个 flag(全仓唯一传入点 = plugin.ts:8259;projector 测试从未用它)。删接口字段 + 守卫行 |

死代码核对:`enabled` 删除后 `WorkflowEngineParkProjectorDeps` 其余字段均有真实使用;projector 测试(`workflow-engine-park-projector.test.ts`,106 行)不引用 `enabled`,零改动。

### 1.2 `founder_decision_deadline_ms`(FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS)→ 写死默认值

`founder-reply-deliverer.ts`:
- `:29` `const DEFAULT_FOUNDER_DECISION_DEADLINE_MS = 3 * 60_000;` —— **保留**(= registry default `"180000"`,一致)。
- `:560-567` 删除整个 env 解析块:

```ts
// 删除:
const configuredDeadlineMs = Number.parseInt(
    process.env.FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS ?? "", 10);
const deadlineMs =
    Number.isSafeInteger(configuredDeadlineMs) && configuredDeadlineMs > 0
        ? configuredDeadlineMs
        : DEFAULT_FOUNDER_DECISION_DEADLINE_MS;
// 替换为:
const deadlineMs = DEFAULT_FOUNDER_DECISION_DEADLINE_MS;
```

(或直接在唯一使用点 `deadlineAtMs: nowDate.getTime() + deadlineMs` 内联常量;保留局部变量形态改动最小。)

### 1.3 `terminal_receipt_settlement`(FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT)→ 无条件跑

| 位置 | 现状 | 剥后 |
|------|------|------|
| `StateStore.ts:4089`(boot 时 backfill 扫描) | `if (... !== "0") { for (...) ensureTerminalSettlementIntentTx(...) }` | 去掉 if 包裹,保留循环体 |
| `StateStore.ts:4148`(`applyTerminalTimestamp` 内终态入账) | 同形 `!== "0"` 包裹 | 去掉 if 包裹 |
| `StateStore.ts:4320`(`ensureTerminalSettlementIntent`) | `=== "0"` → `return undefined` | 删除 |
| `StateStore.ts:4345`(`ensureIssueDoneSettlementIntents`) | `=== "0"` → `return []` | 删除 |
| `StateStore.ts:4390`(`ensurePrMergedSettlementIntents`) | `=== "0"` → `return []` | 删除 |
| `terminal-receipt-settlement.ts:51`(`pass()`) | `=== "0"` → `return` | 删除 |
| `terminal-receipt-settlement.ts:85`(`settleIssueDone`) | 同 | 删除 |
| `terminal-receipt-settlement.ts:106`(`settlePrMerged`) | 同 | 删除 |

### 1.4 registry + truth(tombstone)

- `registry.ts:222-285`:删除 3 个 entry(`founder_decision_deadline_ms` / `engine_declared_park` / `terminal_receipt_settlement`)及其上方的 `─── FLY-1448 ... ───` 分节注释(若 3 条全删则注释也删)。
- `truth.ts:292` `RETIRED_FLAGS` 追加(FLY-1243/1393 先例同形):

```ts
{ envVar: "FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS", retiredBy: "FLY-1466" },
{ envVar: "FLYWHEEL_ENGINE_DECLARED_PARK", retiredBy: "FLY-1466" },
{ envVar: "FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT", retiredBy: "FLY-1466" },
```

drift 三向核:①正向 — 读点全删,src 无残留 gate 读;②反向 — entry 全删,无 readSite 断言;③revived — tombstone 后 src 不得再出现这 3 个 envVar(读点全删即满足)。`FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS` 是 value 变量,本不在 boolean-gate 正向扫描内,但 tombstone 让 `validateFlagTruthEnvironment` 对 env 文件残留行报「已退役,删这行」,与另两个一致。已核生产 `~/.flywheel/.env`、`~/.flywheel/test-slots.json` 均未设置这 3 个变量 → tombstone 不会在生产 boot 触发报错。

## 2. 测试面

### 2.1 删 OFF-path(仅 `terminal_receipt_settlement` 有)

- `packages/teamlead/src/__tests__/StateStore.terminal-settlement.test.ts`
  - 删 beforeEach 的 `= "1"`、afterEach 的 restore、`originalFlag` 变量(env 脚手架整体不再需要)。
  - 「OFF writes no intent and ON catch-up creates exactly one」→ **改写**为纯 catch-up 幂等断言(OFF 段删除;保留价值在 replay 幂等):`persistTransition("completed")` 后连调两次 `ensureTerminalSettlementIntent`,断言 intent_id 相同、总数 1。改名如「catch-up ensure is idempotent per terminal lifecycle」。
- `packages/teamlead/src/bridge/__tests__/terminal-receipt-settlement.test.ts`
  - 删「kill switch freezes existing intents and side effects」整个 it(:146-164 附近)。
  - 删 env 脚手架(`originalFlag` / beforeEach `= "1"` / afterEach restore)。

### 2.2 无需改动

- `engine_declared_park` / `founder_decision_deadline_ms`:全仓测试零引用(已 grep 核实,含 `workflow-engine-park-projector.test.ts`、`founder-decision-convergence.test.ts`、`founder-reply-receipts.test.ts`)。
- shell 测试(`scripts/__tests__/`)零引用。
- 其余 1448 新增测试断言的都是 default_on(=ON)行为,剥后即无条件行为,不动。

## 3. 合流(merge origin/main)冲突面

`git merge-tree --write-tree origin/main HEAD` 实测:**3 个冲突文件**,其余(含 `registry.ts`、`flywheel-comm/db.ts`、`gate-poller.ts`、`CLAUDE.md`)auto-merge 干净。main 侧 6 commit 中唯一撞文件的是 `dc754746`(FLY-1374 #697)。

| 文件 | main 侧(FLY-1374) | 我们侧(FLY-1448) |
|------|--------------------|-------------------|
| `runner-receipt-patrol.ts` | +31/-x:`wakeFailureEpisodeFingerprint()`(episode 稳定指纹);`processOne` 终态目标改为 `disposeRunnerPhaseWakeForTerminal()` 静默处置、**不告警**(测试断言 `notifyWakeFailure` 不被调用,结果 `disposed:terminal_target`);alert `firstDetectedAtMs` 改读 episode start | +107:终态目标走 `completeTerminal()` = `completeRunnerPhaseWakeTerminal`(durable terminal episode)+ 告警 + `notifyWakeFailure(terminal_before_started, episodeFingerprint, identityKind)`;live 路径 founder-origin 走 `founder_wake_undeliverable` 升级(普通 traffic 才静默 dispose);park 探针接进 wake admission |
| `plugin.ts` | ±235:event-driven session truth 重构(dual reconcilers / holder rehydration);告警指纹用 episode-start fingerprint | +243:settlement projector / park outbox / decision convergence 接线;founder 路径未显式传 fingerprint 时用 message hash(per-founder-message 告警作用域) |
| `runner-receipt-patrol.test.ts` | +66:episode fingerprint / terminal disposal 用例 | +100:terminal completeTerminal / founder 升级 / park 探针用例 |

**⚠️ 两侧在「wake 目标已终态」上是正面冲突,不是互补**(Codex design review R1 实证,复核属实):同一输入(terminal target 的 wake),main 要求 dispose 静默、1448 要求 completeTerminal + 告警,两侧测试断言互斥,不可能「都保留并同时绿」。

解冲突采用**逐场景矩阵**(默认裁决,已呈 Tadashi 确认;各取两个 PR 的本意 —— 1374 = 普通 wake 卫生,1448 = founder 决定不许静默丢):

| 场景 | 采用 | 行为 |
|------|------|------|
| 普通 wake,目标已终态 | FLY-1374 | `disposeRunnerPhaseWakeForTerminal` 静默处置,不告警 |
| **founder-origin** wake,目标已终态 | FLY-1448 | `completeTerminal`:durable terminal episode + alert + notify(message-scoped) |
| 普通 wake failure(live) | FLY-1374 | episode-start fingerprint 告警 |
| **founder-origin** wake failure | FLY-1448 | `founder_wake_undeliverable` 升级 / `founder_message` identity(message-scoped fingerprint) |

诚实边界:此矩阵**相对 main 零行为变化**;相对 1448 分支原实现,「普通 wake × 终态目标」从 completeTerminal+告警 改为 1374 的静默 dispose —— 这是把 main 已 ship 的契约延展到普通场景,属于经裁决的行为选择,不能再宣称「合流零语义变化」。founder receipt/alert 契约(1448 的核心)完整保留。

测试锚:1374 的普通终态用例原样保留;1448 的终态用例**改造用 founder-origin wake 触发**;两侧其余断言不变,合流后同时绿。矩阵落地后须盘点 `terminalLifecycleIdFor` / `completeTerminal` / terminal-episode DB API 的存活调用方(founder 路径仍用 → 保留;若有变死的列出来问 Lead,不擅删)。

顺序结论(与 exploration §4.1 一致):**先合流、后剥 flag**,理由:
1. 合流步保持 flag 代码原样(OFF-path 测试此步不动;1448 终态用例按上表矩阵改造为 founder-origin 触发)→ 合流正确性单独验证,变量隔离;
2. 剥 flag 步在合流后的代码上做,diff 干净、单一语义(去可配置性),codex review 好审;
3. 若先剥再合流,plugin.ts 冲突照样存在(冲突源是 1374 重构区域,与 flag 行无关),反而把两种变更搅进同一次冲突解决。

merge 用普通 merge commit(不 rebase):不改历史 → 不需要 force-push,`git push` 普通推进即可,避免既有分支上的历史改写风险。仓库对 squash-merge 场景曾用 rebase --onto(FLY-247),但那是为去重复 commit;本分支不含 main 已 squash 的 commit,普通 merge 无此问题。

## 4. 行为影响评估(剥后 vs 现状)

- 三个 flag 均 default_on 且生产未设置 → **剥后生产行为逐字节等价于现状路径**。唯一损失是 `=0` 紧急逃生口。
- 逃生口损失的兜底:该批行为(批准断路修)已过 QA scoped-PASS + codex review;剥后事故回退手段 = revert PR(整体回退),与 Annie 铁律(宁可 revert 也不留 flag)一致。
- `terminal_receipt_settlement` 无条件化后,boot backfill(StateStore.ts:4089)会对存量 DB 里已终态 session 补 intent —— 这本来就是 flag ON 的既定行为,QA 验过;无新增风险面。
- `engine_declared_park` 无条件化后,park 查询对无 park 记录的 execution 返回 `undefined` → `false`,等价于现状 ON 且无 park 的路径。

## 5. 验证命令面

| gate | 命令 | 备注 |
|------|------|------|
| lint 全仓 | `pnpm lint` | biome |
| build 全仓 | `pnpm -r build` | topo 序 |
| 包套件 | `pnpm test:packages:run` | teamlead 全套件有已知 pre-existing machine-state flake(~12 文件);红了先用 main HEAD 对照证伪,别当回归(memory: `teamlead_full_suite_preexisting_machine_state_flakes`) |
| 重点套件 | config(drift/registry/truth/resolve)+ teamlead(StateStore.terminal-settlement / terminal-receipt-settlement / workflow-engine-park-projector / runner-receipt-patrol / founder-reply-receipts / founder-decision-convergence)+ **flywheel-comm**(terminal-wake-episode / terminal-receipt-settlement) | 冲突文件、剥点与 1374 terminal episode 契约全覆盖。**包名注意**:pnpm filter 必须用真实包名 `flywheel-teamlead` / `flywheel-config` / `flywheel-comm`(`--filter teamlead` 匹配不到且 exit 0 = 假绿) |
| mergeable | `gh pr view 696 --json mergeable` | 合流 push 后应变 `MERGEABLE` |

## 6. 下游(不归 implement 步,列出供 Lead/节点编排)

1. codex code review @ 新 head(xhigh,经 codex-rescue,真跑不 skip)。
2. 独立 QA 复验新 head:1448 是 Discord/批准链 → **必须 529 房真 Discord N-to-N**,不是 code-only;QA 范围含合流后 1374×1448 交互面。
3. 新 head 开 approve gate → Annie 重批 ship(founder-only)。
