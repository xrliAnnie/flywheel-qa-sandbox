# FLY-1466 剥 #696 三个新 feature flag 再 ship — 探索

Issue: FLY-1466 (https://linear.app/geoforge3d/issue/FLY-1466/p1剥-flag-fly-1448-696-剥-3-个新-feature-flag-再-ship-在既有分支上做不新建分支)
日期: 2026-07-24
基于: 无

## 1. 背景与来源

FLY-1448(批准断路修,PR #696,head `b863b4d8`)本身修得对,QA 已 scoped-PASS,但实现引入了 **3 个新 feature flag**,违反 Annie 铁律(不加新 flag)。Annie 直令「关掉重派」并选 B:**剥掉 flag 再 ship**。

原 1448 的 runner 已关;1448 的 generalized workflow claim 卡死(STALE_START_RESPONSE,FLY-1150/1462 同类引擎 bug),无法原地重派 —— 所以开本单 FLY-1466 执行剥 flag,产出新 head 供 #696 ship。

## 2. 硬约束

- **在既有分支 `flywheel-FLY-1448` 上做**(worktree `~/Dev/flywheel-FLY-1448`,PR #696)。**不新建分支、不新建 PR**。已核:PR #696 headRefName = `flywheel-FLY-1448`,本地分支同名且与 origin 同步 —— 无「worktree 分支名 ≠ PR 分支名」footgun。
- 绝不自 merge、绝不自 ship —— ship 永远是 founder gate(Annie 重批)。
- 不动其他 flag(FLY-1436 两条 RESERVED 红线、FLY-1456 幸存者集合零改动)。

## 3. 要剥的 3 个 flag(现状审计,head `b863b4d8`)

三个都是 FLY-1448 在 #696 里新加的,`packages/config/src/feature-flags/registry.ts:222-285`,均 `default_on`、`toggleable: "readonly"`,生产 env(`~/.flywheel/.env`、`test-slots.json`)**均未设置** —— 剥掉 = 把「默认已生效的行为」变成「唯一行为」,生产行为零变化。

| flag | envVar | 类型 | 读点 |
|------|--------|------|------|
| `engine_declared_park` | `FLYWHEEL_ENGINE_DECLARED_PARK` | bool kill_switch, default_on | `plugin.ts:7888,8013,8259`;`StateStore.ts:11062` |
| `founder_decision_deadline_ms` | `FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS` | value, default "180000" | `founder-reply-deliverer.ts:561-567` |
| `terminal_receipt_settlement` | `FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT` | bool kill_switch, default_on | `StateStore.ts:4089,4148,4320,4345,4390`;`terminal-receipt-settlement.ts:51,85,106` |

剥法(issue 指定):
- `engine_declared_park` → 无条件启用,删 `=0` 逃生口。
- `founder_decision_deadline_ms` → 用原默认值写死(`DEFAULT_FOUNDER_DECISION_DEADLINE_MS = 3 * 60_000` = registry default `"180000"`,两者一致,无歧义)。
- `terminal_receipt_settlement` → 无条件跑,删 `=0` 短路。

## 4. 审计新发现(比 issue 文本多出来的事实)

### 4.1 #696 已与 main CONFLICTING(必须合流才能 ship)

issue 写作时 head `b863b4d8` 尚可;**今早 main 连 merge 6 个 commit 后 PR 变 `CONFLICTING/DIRTY`**。`git merge-tree` 实测冲突面:

- `packages/teamlead/src/bridge/plugin.ts` — main 侧 FLY-1374(#697 event-driven session truth)重构 ±235 行;我们分支同文件 +243 行。
- `packages/teamlead/src/bridge/runner-receipt-patrol.ts` — main 侧 +31,我们 +107。
- `packages/teamlead/src/__tests__/runner-receipt-patrol.test.ts` — main 侧 +66,我们 +100。

**registry.ts auto-merge 无冲突**(FLY-1456 #695 删的 13 个 flag 不撞我们新增的 3 个)。CLAUDE.md、`flywheel-comm/db.ts`、`gate-poller.ts` 等也 auto-merge。

结论:剥 flag 之外,**必须 merge origin/main 进分支并解 3 文件冲突**,否则产出的新 head 依然 ship 不了。已向 Tadashi 发非阻塞 ask 确认此 scope 扩展(design 按纳入推进)。

### 4.2 drift guard 是双向的,删 flag 有固定先例

`packages/config/src/__tests__/feature-flags-drift.test.ts`(FLY-709 F5):
- 正向:生产 src 里任何 `FLYWHEEL_*` boolean-gate 读点必须注册(或 allowlist / RETIRED)。
- 反向:注册 flag 的 readSite 文件必须真的读该 envVar。
- revived check:`RETIRED_FLAGS` 里的 envVar 不得在 src 复活。

删 flag 的仓库惯例(FLY-1243/1393/1456 先例):**删 registry entry + 删全部读点 + `truth.ts` `RETIRED_FLAGS` 加 tombstone**(`retiredBy: "FLY-1466"`)。tombstone 同时让 `validateFlagTruthEnvironment` 对残留 env 行报「已退役,删这行」。

### 4.3 测试面

- OFF-path 测试仅 2 处,都是 `terminal_receipt_settlement`:
  - `StateStore.terminal-settlement.test.ts` —「OFF writes no intent and ON catch-up creates exactly one」+ beforeEach/afterEach env 脚手架。
  - `bridge/__tests__/terminal-receipt-settlement.test.ts` —「kill switch freezes existing intents and side effects」+ env 脚手架。
- `engine_declared_park` / `founder_decision_deadline_ms` **没有任何测试**引用 envVar(park projector 测试也没用 `enabled` 选项)。
- `projectWorkflowEngineParkOutbox` 的 `enabled?: () => boolean` 依赖项只为这个 flag 存在(唯一调用点 `plugin.ts:8259`)→ 剥后成死选项,应一并删除(dead code hygiene)。

## 5. 目标形态

1. 3 个 flag 从 registry 与源码消失,行为无条件 = 现 default_on 行为;`RETIRED_FLAGS` +3 tombstone。
2. #696 与 main 合流,PR 回到 mergeable。
3. teamlead + config 全套件绿、`pnpm lint` 全仓、`pnpm -r build` 绿。
4. push 出新 head → codex code review(xhigh,真跑不 skip)→ 独立 QA(529 房真 Discord N-to-N)→ 新 head 开 approve gate → Annie 重批 ship。(后三步归下游节点/Lead,不归本 design 节点。)

## 6. 边界(本单不做)

- 不动 FLY-1448 断路修的**行为语义**(QA 已验过的行为保持;只去掉可配置性)。
- 不清 worktree 里的 untracked QA 残留(`qa-529room-verify.mjs`、`qa-report.md` 不入 PR、不删)。
- 不修 1448 claim 卡死的引擎 bug(FLY-1462 同类另计)。
- 不碰其他任何 flag。
