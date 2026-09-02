# FLY-2240 原子切号与通用轮换 — 实施计划
Issue: FLY-2240 (https://linear.app/geoforge3d/issue/FLY-2240/切号器-统一-atomic-切号-flow手动自动同路必发通知-轮换改-generic可用号中选-reset-最早)
日期: 2026-09-01
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute this plan task-by-task in the bounded DAG implement phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 manual `use/next`、quota daemon 与既有 repair trigger 只调用一个 account-heal 切号执行单元；每个 `switchAccount` 的 `outcome:"switched"` commit 都必须有 durable notification intent，并从本轮 live-verified 可用账号中选择 weekly reset 最早者。现有 `noop_reconciled`、`capture/reconcile/active-sync` 是 crash/marker/store 一致性修复，不宣告新的 successful switch，也不在本单的 success-notification 不变式内；对应边界必须有回归测试，不能把它误报成新切号。

**Architecture:** `account-candidate-selector.ts` 负责所有 trigger 共用的 fresh/live 候选验证与 generic rank；`switch-executor.ts` 保留现有 Keychain/CAS/lock/journal 机械切换，并把 success notification intent 与 generation 写入同一 `AccountStore` commit。发送在锁外完成，失败 intent 由现有 quota monitor tick 重放。公开 bash `use/next` 必须先经过 `acquire_lock` 的 delegated-holder 认证；只有认证成功且带 atomic-apply marker 的 Node child 能进入 bash Keychain 原语，其他调用在释放刚取得的 lock 后 trampoline 到统一 CLI，因此伪造 ambient env 不能绕过通知。

**Tech Stack:** TypeScript 5、Vitest、Node.js、macOS bash 3.2、JSON temp+fsync+rename、既有 `lead-alert.sh` strict delivery。

---

## 1. 锁定的文件职责

| 文件 | 职责 |
|---|---|
| `packages/teamlead/src/account-heal/account-candidate-selector.ts` | 新建。小依赖接口、active witness 复核、freshness + usage live 验证、pool∩store 候选集、earliest reset 排序与带稳定 `excludedBy` 的 panorama。显式 manual `use` 可绕过 cooldown；auto/repair/`next` 仍排除 cooldown。不得发送通知或写 Keychain。 |
| `packages/teamlead/src/__tests__/account-candidate-selector.test.ts` | 新建。排序、stale/exhausted/unknown、config-order 独立、TOCTOU、全部灭的纯/注入测试。 |
| `packages/teamlead/src/account-heal/account-store.ts` | 扩展并严格解析有界 `pendingSwitchNotifications`；提供 enqueue/peek/ack 纯函数；所有既有 spread 写路径必须保留 outbox。 |
| `packages/teamlead/src/__tests__/account-store.test.ts` | outbox schema、上限、幂等、ack 与损坏输入 fail-closed。 |
| `packages/teamlead/src/account-heal/account-switch-notification.ts` | 新建。唯一 success 文案 formatter、delivery result 判定、锁外 send + 锁内 ack/drain。 |
| `packages/teamlead/src/__tests__/account-switch-notification.test.ts` | sent/duplicate/queued ack，失败保留，partial skipped 文案不泄 secret。 |
| `packages/teamlead/src/account-heal/switch-executor.ts` | `manual/quota/model/repair` trigger union；outbox preflight；commit 同写 generation+intent；执行后 drain。所有业务 caller 仍只调用这个 exported executor。 |
| `packages/teamlead/src/__tests__/switch-executor.test.ts` | RED→GREEN 原子 commit、no-op/failed 不写、满 outbox 零 apply、send/ack crash seam、manual 不误标 outgoing quota。 |
| `packages/teamlead/src/account-heal/quota-monitor.ts` | 导入共用 selector；不再按 config order/tier 排序；保留 API 既有 `sevenD.resetsAt=null`=idle/unopened 的 null-first 语义；success 不再 caller-side `deps.alert`；trigger-specific revive/confirmation 保留。周期 sweep 继续复用本文件 `readCandidateCredential`。 |
| `packages/teamlead/src/account-heal/quota-monitor-runtime.ts` | 给 selector 和 executor 接真实 paths/deps；每 tick 前后 drain account-store switch outbox。 |
| `packages/teamlead/src/account-heal/quota-incident.ts` | model incident 不再追加第二条 `model_cap_switched` outbox，只保留 pane/revive/confirmation 状态。 |
| `packages/teamlead/src/__tests__/quota-monitor.test.ts`、`quota-monitor-runtime.test.ts`、`quota-incident.test.ts` | 自动路径同 executor、generic rank、部分/全部坏账号、restart/replay、model 无双发。 |
| `packages/teamlead/src/account-heal/account-switch-cli.ts` | 新建。解析 `use <name>` / `next`，snapshot + 共用 live selector + 同 executor；只有 executor 返回 `active_marker_drift` 时才以非 delegated `reconcile` 收敛并重试一次；显式解析 manual freshness/quota bypass；从 `.env` 安全解析完整 alert-identity allowlist；输入严格校验，exit code/终端文案。 |
| `packages/teamlead/bin/flywheel-claude-switch` | 新建 thin launcher 到 compiled CLI；dist 缺失 fail closed。 |
| `packages/teamlead/package.json` | 注册 bin/files（files 已含 `bin`）。 |
| `scripts/test-deploy.sh`、对应 shell test | teamlead build 后、任何 restart/publish 前断言新 CLI dist 存在且 launcher smoke-load 成功；防止 pull→build 失败仍继续部署。 |
| `packages/claude-runner/bin/flywheel-claude-profile` | `use/next` 在拿 lock 并算出 `DELEGATED_LOCK_ACCEPTED` 后分流：真实 delegated holder + atomic marker 才能进既有 bash primitive；其余释放 lock 后 trampoline 到新 CLI。capture/reconcile 等不变。 |
| `packages/claude-runner/test/claude-profile.test.ts`、`packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts` | manual `use` 必见 sender、`next` generic winner、伪造 internal env 不绕锁、既有 119 条 Keychain 红线。 |
| `packages/teamlead/src/account-heal/account-switch-repair.ts`、相关 tests | `executeSwitch` 先用共用 live selector 得到 ranked/panorama，再调用 executor；删除 caller-side `notifySuccess`，改用 executor 已提交/投递通知；pending/CAS 语义不变。 |
| `packages/teamlead/src/bridge/infra-notify.ts`、相关 tests | 删除只服务旧 `RepairDisposition.notifySuccess` 的 `SwitchSuccessNotify/formatSwitchSuccessDigest`；Codex rotation digest 保留。 |
| `engineering/doc/milestones/FLY-2240.md` | PR 的 literal last commit；记录交付/验证/风险，不改 `CLAUDE.md`。 |

## 2. Task 1 — generic live candidate selector

**Files:** 新建 `account-candidate-selector.ts`、`account-candidate-selector.test.ts`；修改 `quota-monitor.ts`。

- [ ] **Step 1: RED — 写 reset-only 排序和全集候选测试**

测试构造 active=`personal1`，store/pool 另有 school/personal/business；外部 legacy order 故意只列 school/business。live usage 分别给 school reset 18:00、personal reset 16:00、business reset 17:00，断言：

```ts
expect(result.ranked).toEqual(["personal", "business", "school"]);
expect(verifyCandidate).toHaveBeenCalledTimes(3);
```

再构造 school 5h=95/reset 15:00、business 5h=10/reset 18:00、`trigger5hPct=90`，断言 business 第一：Lead 对 founder “可用”的解释是 daemon 切入后不会立即再次触发切出的账号。只有低水位集合为空时才降级选 school，并返回 `headroomDegraded:true`，通知/日志明确 “weekly 有粮但 5h 已过 trigger”。每个集合内部仍只按 weekly reset 排序，绝不使用 config order。显式 manual `use school` 尊重人指定的非 exhausted target，不应用 headroom gate；manual `next`/auto/repair 应用。构造 weekly reset `null`（usage API 的 idle/unopened 正常形状），断言排在同一集合所有有时间戳的 reset 前；invalid/malformed reset 则属于 unverifiable，不能参与排序。

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-candidate-selector.test.ts src/__tests__/quota-monitor.test.ts`

Expected: FAIL；当前无 module，且旧 monitor 仍会得到 config-order/tier 结果。

- [ ] **Step 3: GREEN — 抽取小接口与 selector**

实现以下公开形状：

```ts
export interface CandidateSelectionDeps {
  now: () => number;
  withAccountsLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readSnapshot: () => Promise<AccountSnapshot>;
  verifyCandidate: (name: string, active: string | null) => Promise<FreshnessVerdict>;
  readPoolCredential: (name: string) => Promise<MonitorCredential | null>;
  fetchUsage: (token: string) => Promise<AccountUsageResult>;
  recordObservation: (name: string, observation: AccountQuotaObservation, generation: number) => Promise<RecordObservationResult>;
}

export async function verifyAndRankCandidates(
  deps: CandidateSelectionDeps,
  snapshot: AccountSnapshot,
  options?: {
    models?: readonly string[];
    onlyNames?: readonly string[];
    cooldownPolicy?: "exclude" | "ignore_explicit_target";
    manualBypass?: { freshness: boolean; quota: boolean };
    headroomPolicy?:
      | { kind: "prefer_below_trigger"; trigger5hPct: number }
      | { kind: "explicit_target" };
  },
): Promise<CandidateSelectionResult>;
```

候选来自 store.accounts（名字稳定排序）∩ pool；`onlyNames` 只供显式 manual use。正常合格判定只接受本轮 freshness + usage 成功且双 window `<100`。`prefer_below_trigger` 先取 `fiveH.pct<trigger5hPct` 的可用集合；仅集合为空才取仍 `<100` 的 high-5h 集合并标 degraded。排序 key=`idleUnopened ? -Infinity : valid reset ms`, tie=name，其中 `idleUnopened` 只表示本轮 usage 成功且 API 明确返回 `sevenD.resetsAt===null`；invalid reset/usage 整体 fail closed。保留 newer `lastObservedAt > verifiedAt` 的现有防竞态 guard。`manualBypass` 只由公开 CLI 读取：本轮 usage 没成功但 quota bypass 纳入的候选标 `resetUnknown` 并用 `+Infinity`，绝不能误当 idle；freshness/quota 失败候选 panorama 标明 bypass。测试分别锁定 `idleUnopened` 最前、`resetUnknown` 晚于任何正常候选。automatic/repair factory 永不传 manual bypass。

- [ ] **Step 4: RED/GREEN — stale/exhausted/unknown/full-dead**

逐个只加一个断言并跑：stale 不 fetch usage；quota exhausted 不进 ranked；usage network/malformed 不进 ranked；全部不可用返回 `ranked=[]` 且 panorama 含每个原因；access token 不得出现在 panorama JSON。另断言 cooldown entry 为 `excludedBy:"cooldown"`，stale=`"unverifiable"`，exhausted=`"quota"`，auth flag=`"auth"`。auto/repair/`next` 不根据 cooldown 做回退（归 FLY-2229）；显式 manual `use <name>` 用 `ignore_explicit_target` 绕过 cooldown 但仍做 fresh/quota guard，结果和通知 context 标 `cooldownBypassed:true`，保留 founder 当前人工破局能力。

- [ ] **Step 5: 修改 quota monitor 调用**

删除本文件 config-order/5h-utilization comparator 的旧 rank 实现并 import selector；保留的 headroom 只做 `<trigger5hPct` 集合优先/集合空才 degraded fallback，集合内部完全按 weekly reset。`readCandidateCredential` 留给独立的 `sweepCandidates` 观测刷新路径，不随 rank 删除。`degradedSwitch` 字段继续读取兼容旧 config，但不得再把 unverifiable panorama 变成 preferredOrder。config `order=[]` 的 monitor-only gate 保留；启用后 order 不限制候选。

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-candidate-selector.test.ts src/__tests__/quota-monitor.test.ts src/__tests__/account-store.test.ts`

Expected: all pass。

Commit: `feat(FLY-2240): rank live accounts by earliest reset`

## 3. Task 2 — durable switch notification outbox

**Files:** `account-store.ts`/test；新建 `account-switch-notification.ts`/test。

- [ ] **Step 1: RED — store schema 与有界队列**

新增测试：合法 empty/one intent round-trip；同 eventId enqueue 幂等；第 65 个不同 intent 抛 typed `SwitchNotificationOutboxFullError`；unknown key/超长 title/body/signature/非法 generation 使 `readStoreStrict` 返回 null；ack 仅删精确 eventId。

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-store.test.ts`

Expected: FAIL because outbox API/types are absent。

- [ ] **Step 3: GREEN — 实现 schema/纯函数**

实现：

```ts
export const MAX_SWITCH_NOTIFICATION_OUTBOX = 64;
export type SwitchNotificationIntent = { eventId; generation; createdAt; alert };
export function enqueueSwitchNotification(store, intent): AccountStore;
export function peekSwitchNotification(store): SwitchNotificationIntent | null;
export function ackSwitchNotification(store, eventId): AccountStore;
```

`readStore` 对旧文件归一化为 `[]`；strict reader 对显式坏 outbox fail closed；`emptyStore` 带空队列。写入仍使用已有 temp+fsync+rename。

- [ ] **Step 4: RED — formatter + drain delivery matrix**

测试同 formatter 对 manual/quota/model 输出相同 `from → to` 主句，只在括号里显示 trigger；partial panorama 加单行 `skipped=business:freshness_stale,shopping:quota_exhausted`；不含传入 credential/token。delivery=`sent|duplicate|queued_transient` 后 ack，其他结果保留。

- [ ] **Step 5: GREEN — 锁外 send、锁内 ack**

`drainSwitchNotification` 先短锁 peek，释放锁后 send，再短锁复读并按 eventId ack；generation 前进不影响旧 intent ack，只有 eventId 精确匹配才删。

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-store.test.ts src/__tests__/account-switch-notification.test.ts`

Expected: all pass。

Commit: `feat(FLY-2240): persist account switch notifications`

## 4. Task 3 — mechanical switch 的原子 commit

**Files:** `switch-executor.ts`/test；`claude-profile-cli.ts`/test。

- [ ] **Step 1: RED — success 同 commit 写 intent**

在 happy path 断言读取 store 得到：

```ts
expect(after).toMatchObject({ activeAccount: "business", generation: 2 });
expect(after.pendingSwitchNotifications).toEqual([
  expect.objectContaining({ eventId: "account-switch-g2", generation: 2 })
]);
```

断言 `failed/no_account/noop/noop_reconciled` 不新增；manual scope 成功不写 outgoing `quotaExhaustedUntil/switchCooldownUntil`；model scope 仍写 bench。这个测试把通知不变式明确限定为新的 `outcome:"switched"` commit，避免把 journal/marker consistency repair 误称为新 switch。

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/switch-executor.test.ts`

Expected: FAIL；当前 commit 无 outbox/manual scope。

- [ ] **Step 3: GREEN — trigger union 与 atomic preflight**

扩展 `SwitchInput`：

```ts
type SwitchTrigger =
  | { kind: "manual"; mode: "use" | "next" }
  | { kind: "quota" | "repair"; scope: "5h" | "weekly" | "both"; resetAt: string }
  | { kind: "model"; models: CanonicalModels };

type ManualEligibilityOverride = {
  ignoreCooldown: boolean;
  allowFreshnessUnverified: boolean;
  allowQuotaUnverified: boolean;
};

type ManualEligibilityOverrides = ReadonlyMap<string, ManualEligibilityOverride>;
```

保持 compatibility helper 把旧 scope input 显式映射到 trigger，完成 caller 迁移后删除 helper。`SwitchInput.manualOverrides` 只在 `trigger.kind==="manual"` 时合法，map keys 必须是 preferred list 的子集，否则 fail closed。explicit `use` map 只有目标且 `ignoreCooldown=true`；`next` 根据 selector panorama 为 ranked 中每个需要 bypass 的候选建立 entry，`ignoreCooldown=false`，apply loop 每到一个候选就只读取该名字的 override 并签发对应 internal marker。

`selectNextAccount` 接收 typed overrides：freshness override 只可忽略该 target 的 `authExpired|refreshTokenInvalid|profileVerifyFailed`，`identityMismatch` 永不绕过；quota override可忽略该 target 的 `quotaExhaustedUntil`、newer-observation guard；explicit use 可忽略 cooldown。任何 override 都不忽略 model bench/名字/CAS。这样 live selector 的 human decision 不会在 executor 内被旧 store projection 二次否决，也完整保留 `next` 在多个 bypass candidate 间继续尝试的能力。

每次调用先在主 switch lock 外尝试 drain backlog；进入 apply loop 前计算 next generation eventId 并检查 outbox 容量。`commitSwitch` 只在 quota/repair 标 outgoing exhausted；所有 `switched` success append centralized formatted intent。若 64 个 intent 仍全未确认则 fail closed 为 `notification_outbox_full`、零 Keychain mutation：这是 founder 的“切号成功必有通知 intent”不变式与既有“告警不能阻断 emergency recovery”原则冲突处的显式选择，不能静默丢旧 intent；manual CLI 必须把恢复动作（修 notify config/启动 daemon drain）打印出来，milestone/PR 记录 64 条后自锁的已知风险。

- [ ] **Step 4: RED/GREEN — delivery 与 crash seam**

`SwitchDeps` 增 `deliverNotification`；executor 释放主 switch lock 后 drain。测试 send error 返回的 `SwitchResult` 仍为 switched 但带 `notification:"pending"`，store intent 保留；send success ack；模拟 ack 写失败时 intent 仍在，下一次 drain duplicate 后删除。

- [ ] **Step 5: factory wiring**

`makeClaudeProfileSwitchDeps` 接收 required production `deliverNotification`，测试显式注入。`SwitchDeps.applyProfile` context 增加 executor 已验证过的 `manualOverride`；factory 总是删除 public `FLYWHEEL_CLAUDE_FRESHNESS_BYPASS/FLYWHEEL_CLAUDE_QUOTA_BYPASS`，只在 `trigger.kind==="manual"` 的 typed context 中签发内部 `FLYWHEEL_ATOMIC_FRESHNESS_BYPASS=1` / `FLYWHEEL_ATOMIC_QUOTA_BYPASS=1`，并同时设置 `FLYWHEEL_ATOMIC_SWITCH_APPLY=1`。bash 只有 `DELEGATED_LOCK_ACCEPTED=1 && FLYWHEEL_ATOMIC_SWITCH_APPLY=1` 才接受内部 marker；ambient/public marker 全部 scrub。normal automatic path 仍可用既有 authenticated `quotaPreverified`，但永不获得 bypass marker。

若 authorized freshness-bypass apply 仍返回 `TargetStaleError`，executor 返回 `manual_bypass_apply_rejected` 且不得 `markAuthExpired`；正常非 bypass stale 仍保持现有标记语义。测试覆盖 store 已有 authExpired/quotaExhausted/newer observation 时 manual override 仍可到 apply、raw internal marker 不能授权、manual stale apply failure 不污染 store。

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/switch-executor.test.ts src/__tests__/claude-profile-cli.test.ts src/__tests__/claude-profile-cli.integration.test.ts`

Expected: all pass。

Commit: `feat(FLY-2240): commit switch and notification atomically`

## 5. Task 4 — daemon 自动切走同一执行单元

**Files:** `quota-monitor.ts`/test、`quota-monitor-runtime.ts`/test、`quota-incident.ts`/test。

- [ ] **Step 1: RED — 自动 caller 不再 success-alert**

将 harness 的 switchImpl 模拟为已记录/发送通知的 executor。断言 `pollOnce` 成功后不再额外调用 `deps.alert(account_switched|model_cap_switched)`，但 revive、confirmation、identity reports 全保留。现有测试应因期待 caller-side alert 而失败。

- [ ] **Step 2: GREEN — 删除双发、传按账号索引的结构化 context**

caller 在进入 executor 前完成所有 usage/identity/timezone I/O，并传：

```ts
type SwitchNotificationContext = {
  founderTimezone?: string;
  usageByName: ReadonlyMap<string, AccountUsageResult>;
  identityByName: ReadonlyMap<string, { email?: string }>;
  panorama: readonly CandidatePanoramaEntry[];
  manual?: { cooldownBypassed: boolean; freshnessBypassed: boolean; quotaBypassed: boolean };
};
```

executor 的候选 apply loop 最终选出 `to` 后，只从 map 按 `from/to` 取 context 再格式化 intent，锁内不得读取 pool 或发网络。repair/context 缺失时 formatter 仍输出完整 `from → to (trigger)`，usage/identity 行整体省略而非打印 `undefined`；panorama 缺失则无 skipped 行。删除 `pollOnce` 末尾 `deps.alert(account_switched/account_switch_degraded)`。model `finalizeModelSwitchIncident` 不再 append switch alert，只维护 confirmation/revive/pane suppression。

- [ ] **Step 3: RED/GREEN — daemon restart/replay**

runtime test 先写一个已 committed 的 store intent，初次 sender 返回 process_error，断言 intent 保留；新 runtime tick sender 返回 sent，断言发送一次且 ack。再断言正常 auto switch 的发送来自 executor deps，而不是 monitor caller。

- [ ] **Step 4: 全灭与部分坏账号**

部分 stale/exhausted 时 switch success notice 含 skipped 行；全部 stale/exhausted/network 时不调用 switch，调用一次既有 `quota_no_target`，body 带 panorama。无新 kind/daemon/timer。

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/quota-monitor.test.ts src/__tests__/quota-monitor-runtime.test.ts src/__tests__/quota-incident.test.ts src/__tests__/quota-monitor-alert.test.ts`

Expected: all pass。

Commit: `refactor(FLY-2240): route automatic switches through atomic executor`

## 6. Task 5 — manual `use/next` trampoline

**Files:** 新建 switch CLI/launcher/test；修改 bash/profile tests、package manifest。

- [ ] **Step 1: RED — public manual use 必须触发同 sender，伪 delegated env 也不能旁路**

在 hermetic temp pool/store/fake Keychain 下执行真实 `flywheel-claude-profile use school`，注入 fake switch launcher 写 ledger。断言 ledger 精确一条 `use school`；当前脚本会直接切 Keychain 且 ledger 为空，因此 RED。再设伪造 `FLYWHEEL_CLAUDE_LOCK_DELEGATED=1`，断言它只能正常取得自己的 lock 后转进同一 launcher，绝不能落入 bash mutation；真实 parent holder + lease proof 但缺 `FLYWHEEL_ATOMIC_SWITCH_APPLY=1` 则 fail closed。

**既有 bash 红线迁移契约（禁止全局 launcher 桩）：** 先用 AST/文本 census 把当前 86 个 `use/next` 调用列进测试注释。所有断言 bash primitive 本身的 suites——identity proof、display identity、transition journal/rollback/lease、freshness/capture-back、quota guard、identity policy、active-marker reconciliation 的底层分支——改用新 `runAuthenticatedPrimitive*` helpers：test process 建 scratch holder marker（pid=`process.pid`，child `$PPID` 匹配），传 `FLYWHEEL_CLAUDE_LOCK_DELEGATED=process.pid`、lease proof、`FLYWHEEL_ATOMIC_SWITCH_APPLY=1`，再调用真实 bash；helper 不设置 bypass/preverified，测试逐例显式提供。加 meta-test：primitive helper 的一次 `use` 必须真实改变 fake-security state、写完整 entry/exit audit，且 public switch-launcher sentinel 为零调用。

只有以下 named acceptance 走非 delegated public trampoline：`public use sends atomic notification`、`public next picks generic winner`、`forged delegation cannot bypass trampoline`、`public explicit use bypasses cooldown`、`public freshness/quota bypass`、`public stale marker reconciles once`、`public all-dead alerts`、`public sender loads sparse-shell identity`、`missing dist fails closed`。它们使用已构建 teamlead dist、scratch pool/store/fake security、`FLYWHEEL_QUOTA_API_BASE` 本地 usage server、scratch identity endpoint 和 hermetic alert sink；不得以 `FLYWHEEL_CLAUDE_SWITCH_BIN` ledger fake 代替真实 CLI（仅最初 RED routing test 可注入 sentinel）。共用 `run/runBoth/runExpectFail` helpers 禁止全局设置 switch launcher，并加 source-level meta assertion锁住这条禁令。

- [ ] **Step 2: GREEN — 在 authority 判定后 trampoline**

不以 ambient `FLYWHEEL_CLAUDE_LOCK_DELEGATED` 是否为空作为 public/internal 判据。`use_profile`/`next_profile` 先 `acquire_lock`，让现有 marker pid + `$PPID` + live-holder 检查算出 `DELEGATED_LOCK_ACCEPTED`，然后在任何 Keychain/pool mutation 前分流：

- `DELEGATED_LOCK_ACCEPTED=1 && FLYWHEEL_ATOMIC_SWITCH_APPLY=1`：此时才 `begin_audit` 并继续既有 primitive；若 Node 传入 trusted `FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD=next`，entry 如实记录 `cmd=next/profile=<selected target>` 并在 details 加 `selectedBy:"atomic-cli"`；否则 audit 为普通 `use target`；
- `DELEGATED_LOCK_ACCEPTED=1` 但 marker 缺失/不精确为 `1`：fail closed；
- `DELEGATED_LOCK_ACCEPTED=0`：此层尚未 `begin_audit`；显式释放刚取得的 lock，清掉伪造 delegation/lease/所有 internal marker，exec `FLYWHEEL_CLAUDE_SWITCH_BIN` 或相对 `../../teamlead/bin/flywheel-claude-switch`。`exec` 失败立即 nonzero，绝不 fall through mutation。

把 dispatch 处现有 `begin_audit use|next` 移到上述 authenticated primitive 分支，避免 public exec 留 orphan entry；实际 delegated mutation 仍恰好一对 entry/exit，audit target fail-closed 不变，`next` 的旧 `entry.profile=null` 断言有意更新为 target + `selectedBy`，使取证反映 Node 已完成的选择。这样 forged env 仍保留现有“正常 acquire”安全性质，但 acquire 后一定走统一 CLI。Node executor 调 primitive 时同时设置 delegated metadata 和 `FLYWHEEL_ATOMIC_SWITCH_APPLY=1`；两者缺一不可。

- [ ] **Step 3: RED — CLI input 与 generic next**

`runAccountSwitchCli(["use","../bad"])` 返回 usage error且零 snapshot；正常 `use school` 只 live-verify school；`use` 遇 active cooldown 仍成功且 context 标 `cooldownBypassed`。`next` 扫 pool∩store 全部候选并选择 reset 最早、仍排除 cooldown。all-dead 调 sender `quota_no_target` 且 exit nonzero；sender fail 后 switch success exit 0 但 stderr 明示 notification pending（intent durable）。

stale/absent marker 不在每次 CLI 前新增网络 precondition：首次 executor 若返回 typed `active_marker_drift`，CLI 才清除 delegated/lease/atomic/bypass internal env，运行一次 public `reconcile`，成功后从新 snapshot/新 live verification 开始完整重试且最多一次。`reconcile` 的 `no_credential` rc=10、identity probe failure、malformed output 都是 hard failure，零重试 mutation；reconcile→retry 间再次 drift 则终止并打印 `FLYWHEEL_MANUAL_RECONCILE_RACE`，不循环。正常路径 audit 仍恰好两行；exceptional drift recovery 的每个 bash mutation/reconcile invocation 各自保持 entry/exit 成对。

为两个现有人工破窗加 RED：`FLYWHEEL_CLAUDE_FRESHNESS_BYPASS=1` 可让 manual `use` 或 `next` 的候选在 freshness unavailable/stale/store-auth-expired 时继续；`FLYWHEEL_CLAUDE_QUOTA_BYPASS=1` 可让 quota exhausted/unavailable/newer-negative-observation candidate 继续，但永不绕过 `identityMismatch`。将既有（不是新建 external kind）`quota_guard_bypassed` 加入 `QuotaMonitorAlertKind`/routing 只为复用 sender，保持 bridge kind contract 不变。

public flags 必须精确为 `1`。CLI 是 quota bypass loud warning 的唯一 owner，每次 human invocation（包括 target 已 active 的 noop）恰好打印一次既有 `BYPASSING live 5h/7d quota guard` 文案并 best-effort 发一次 `quota_guard_bypassed` audit；bash 不重复 warning/audit。CLI 将各候选授权写入 typed `ManualEligibilityOverrides` map，executor 按 apply candidate 签发只被 authenticated delegated+atomic bash 接受的 internal marker。泄漏到 automatic 的 public/internal flags、raw forged marker 都不能授权。现有 `claude-profile.test.ts` 的 bypass tests 必须走真实 trampoline，覆盖 `next` 先失败一个 bypass candidate 再切第二个，以及 stale bypass 不触发 `markAuthExpired`。

- [ ] **Step 4: GREEN — CLI runtime wiring**

复用 `defaultQuotaMonitorPaths`、accounts lock、machine authority、pool/keychain credential readers、`verifyPoolCredential`、`fetchAccountUsage`、recordObservation 和 `sendQuotaMonitorAlert`。CLI 不解析/输出 token。explicit use 构造 `onlyNames:[target]` + `cooldownPolicy:"ignore_explicit_target"`；next 不传 onlyNames且用 `exclude`。ranked 空时只发 no-target，不调用 executor。drift 时的单次 reconcile/retry 是今天 public bash stale/absent marker 自修复能力的等价迁移，不改变正常路径。

manual runtime 不依赖 quota daemon wrapper：新增不执行 shell 的 `.env` assignment parser（plain/single-quoted/double-quoted，拒绝 duplicate、command substitution、变量扩展与 malformed value）。process env 只有 trim 后非空才优先；unset/空串/纯空白都从 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/.env` 回落，并有参数化测试。只补齐以下 alert identity allowlist：`FLYWHEEL_NOTIFY_CHANNEL`、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`、`FLYWHEEL_ALERT_SENDER_TOKEN_ENV`、该变量指向且通过 identifier regex 的 token key、`FLYWHEEL_CLAIMS_DB`、`FLYWHEEL_PROJECTS_FILE`、`FLYWHEEL_ALERT_QUEUE_DIR`、`FLYWHEEL_ALERT_DEADLETTER_DIR`、`FLYWHEEL_ALERT_RATE_PER_MIN`，以及 mention/severe 所需 `FLYWHEEL_QUOTA_ALERT_MENTION_USER`、`FLYWHEEL_FOUNDER_USER_ID`、`FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID`。绝不载入其他 `.env` key，也不输出 token。

`QuotaMonitorAlertOptions.env` 默认为 `process.env`；所有 routing lookup 使用 `effectiveEnv={...process.env,...opts.env}`，传给 child 的 env 也恒为这个超集再覆盖本次 channel，保证 daemon 不传 env 时 argv/env/primary+secondary behavior byte-compatible。manual integration 不能 stub `lead-alert.sh`：用真实脚本 + hermetic fake curl/sqlite/claims/queue，process env 缺 sender/channel而 temp `.env` 提供完整 allowlist时，success 的 `primary` 必须是 `sent|duplicate|queued_transient` 且 `!=="config_error"`；另断言 token 不在 argv/stdout/stderr。缺 identity/channel 则 intent 保留并打印 stable pending/config recovery marker，不能把它当验收成功。

- [ ] **Step 5: manifest/launcher**

`flywheel-claude-switch` 检查 `node` 与 `dist/account-heal/account-switch-cli.js`，缺失打印 stable `FLYWHEEL_ATOMIC_SWITCH_RUNTIME_UNAVAILABLE`、可复制的 `pnpm --filter flywheel-teamlead build` 恢复命令并非零退出。为守住 unified atomic flow，不保留会绕过 intent 的 bash-only mutation fallback；安装/部署包必须携带已构建 dist。注册 teamlead `bin`，launcher/bash 保持 macOS bash 3.2。

在 `scripts/test-deploy.sh` 已有 `pnpm --filter flywheel-teamlead build` 后、release/restart 前增加 `test -f packages/teamlead/dist/account-heal/account-switch-cli.js` + launcher `--runtime-check`（只 load module/validate manifest，零状态读写），失败走现有 `fail_preflight`，并给 deploy shell test 加“dist 缺失不进入 restart/publish”断言。这个门不能消除 git pull 到 build 完成之间的短暂 fail-closed 窗口，但保证 build 失败不会被宣布部署成功；窗口写入 milestone。

更新 `qa-fly-1252-quota-state-e2e.sh` 的 scratch env：显式提供 Node/switch launcher/dist、Node CLI 每次 quota-bypass invocation（含第二次 noop）打印一次 loud warning并入队一次 audit，所以两次仍断言 queue/claims=2；仍用真实 public `use`，并验证 dist 缺失只报恢复 marker且 Keychain/.active 不变。

- [ ] **Step 6: Verify + commit**

Run:

```bash
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-switch-cli.test.ts src/__tests__/claude-profile-cli.integration.test.ts
pnpm --filter flywheel-claude-runner exec vitest run test/claude-profile.test.ts
```

Expected: all pass；既有 119 个 bash 红线继续真实覆盖 primitive（不被 launcher 桩假绿，audit 仍 entry/exit 成对；`next` entry 形状按真实已选 target 更新），新增 manual sender/generic next、forged delegation/internal marker、cooldown bypass、两个 emergency bypass、stale-marker 单次 reconcile、real lead-alert env-file identity 和 dist-missing recovery 均通过。

Commit: `feat(FLY-2240): route manual profile switches through account heal`

## 7. Task 6 — 退役 caller-side success seam

**Files:** `account-switch-repair.ts`/test、`infra-notify.ts`/test、全仓 consumers。

- [ ] **Step 1: RED — repair 必须 live select 且不得返回第二套 notify payload**

修改测试断言 switched disposition 只有 detail/action/outcome；executor mock 记录自己已处理 notification。另构造 store 看似 business reset 最早、但本轮 business freshness stale、school fresh 的 repair pending，断言 executor 收到 `preferredOrder:["school"]`、`quotaPreverified:true` 和完整 panorama；live 全灭时不调用 executor、resolve pending 后 `needs_human` 且 detail 含原因。全仓 `rg notifySuccess` 当前会命中生产和 tests，作为 RED inventory。

- [ ] **Step 2: GREEN — 删除 dead seam**

删除 `RepairDisposition.notifySuccess`、`SwitchSuccessNotify`、`formatSwitchSuccessDigest` 及对应 tests/import。给 repair 注入与 quota/manual 相同的 `CandidateSelectionDeps` factory；`executeSwitch` 以 `cooldownPolicy:"exclude"` 跑 live selector，ranked 非空才把结果作为 executor 的唯一 candidate order 并传 `trigger:{kind:"repair",...}`。`canAttempt/enqueue` 的旧 store check 只作 cheap admission hint，不再授权真实切换。保留 Codex `account_rotation`/`formatRotationDigest`（不同 provider/per-runner 流程，不在本单）。

- [ ] **Step 3: consumer sweep**

Run:

```bash
rg -n 'notifySuccess|formatSwitchSuccessDigest|switchAccount\(' packages scripts
```

Expected: 前两者 0；`switchAccount(` 的业务调用只剩 quota runtime、manual CLI、repair adapter 与 tests，且全部 factory 都提供统一 notification deps。

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-switch-repair.test.ts src/bridge/__tests__/infra-notify.test.ts src/bridge/__tests__/event-route.test.ts`

Expected: all pass。

Commit: `refactor(FLY-2240): remove duplicate switch success notifications`

## 8. Task 7 — 组合验收、mutation 与全仓门

- [ ] **Step 0: affected drill baseline (before edits)**

在改 `qa-fly-*` 前，以 detached `origin/main` scratch worktree 建基线，执行 `pnpm install --frozen-lockfile`（复用同版本 pnpm store但不复用本 branch dist），设置独立 `HOME/TMPDIR`，依次运行 `qa-fly-1182-isolated-switch-drill.sh`、`qa-fly-1252-quota-state-e2e.sh`、`qa-fly-1252-switch-robust-e2e.sh`、`qa-fly-1256-quota-daemon-e2e.sh account`；记录每条 command、exit code、pass/test count 和 prerequisite skip 到 milestone 草稿。改后以相同宿主/参数重跑，branch 不得引入新增失败；这些 operator drills 不是 `scripts/__tests__` CI gate，baseline 已红/宿主缺 prerequisite 必须如实并列，不伪装为 pass。

- [ ] **Step 1: focused acceptance**

Run all changed focused suites plus real bash suite和上述四个 affected drills。保存命令、test count、exit code 与 origin/main 对照到 milestone 草稿（此时不提交 milestone）。

- [ ] **Step 2: mutation controls**

临时逐一反改（不提交）：reset comparator 变回 tier/order；移除 commit enqueue；让 manual use 跳过 trampoline。每次对应新测试必须失败。恢复后重跑 green。用 `git diff` 确认无 mutant 残留。

- [ ] **Step 3: exact full-repo gates**

依次运行并完整读取输出：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
for test_file in scripts/__tests__/*.test.sh; do bash "$test_file"; done
```

所有新增/修改的 `scripts/__tests__/*.test.sh` 也必须单独运行。任一 required gate 失败按 systematic-debugging：定位根因、增加/调整最小测试、修复、重跑该门和受影响全门；不得把环境/既有失败写成 pass。

- [ ] **Step 4: inbox + diff audit**

检查 Lead inbox；`git diff origin/main...HEAD --check`；`git status --short`；按本 plan 每条验收建立 evidence 对照。确认不含 secret、`CLAUDE.md` 改动、新 daemon/timer、cooldown scope 漂移。

## 9. Task 8 — code review、PR 与 bounded completion

- [ ] **Step 1: code review**

stage set `code_review`。按动态契约通过 `codex:rescue`（绝不 raw `codex exec`）审查 `origin/main...HEAD`；同时注册：

```bash
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id 84815401-1c6c-4790-b483-93389bb87132 --no-block "Code review requested for FLY-2240"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <id>
```

轮询 verdict。CHANGES_REQUESTED：修 HIGH，补 RED→GREEN，提交/push，开新 questionId 重审；APPROVED advisories 通过 `ask --report` 转 Lead。

- [ ] **Step 2: milestone literal last commit**

新建 `engineering/doc/milestones/FLY-2240.md`，包含 issue/PR、原子语义、manual/auto/generic 验收、完整 gate 结果、review verdict、明确未动 cooldown ticket。检查 inbox 后单独提交：

```bash
git add engineering/doc/milestones/FLY-2240.md
git commit -m "docs(milestone): record FLY-2240 delivery"
```

该 commit 必须是开 PR 前 literal last commit；之后不再跑会改 tracked 文件的动作。

- [ ] **Step 3: push/open PR**

push feature branch，`gh pr create`，PR body 列 requirements、TDD/mutation、full gates、风险/非目标；不 merge、不请求 ship approval、不 dispatch QA。

- [ ] **Step 4: report and complete bounded node**

通过唯一报告通道：

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead --exec-id 84815401-1c6c-4790-b483-93389bb87132 --report "DONE: FLY-2240 implementation complete | commits: <sha list> | PR: <url>"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
```

然后 park/end 当前 implement phase；不 dispatch successor、不 merge/deploy。

## 10. Plan self-review

- Design review R1：四个 HIGH 已落实为可执行步骤与测试：manual `.env` notify-channel 白名单加载；explicit `use` cooldown bypass；freshness/quota emergency bypass 等价迁移；delegated authority 在 acquire 后判定。MEDIUM/LOW 也明确了 outbox 满的 invariant 取舍、reconcile 边界、repair live selection、idle null-first、5h churn 风险（后由 Lead 裁定 headroom fallback）、marker reconcile、context map、sweep helper 和真实 QA scripts。
- Design review R2：manual alert env 扩成 channel + sender identity + dynamic token + claims/queue/deadletter 的安全 allowlist，并要求真实 `lead-alert.sh` integration；manual bypass 改为 `CLI typed override → executor eligibility override → authenticated internal bash marker` 的完整链路。另锁定 public exec 无 orphan audit、sender env 默认 byte-compatible、dist 缺失 fail-closed recovery、reconcile 单次失败语义与 `idleUnopened/resetUnknown` 术语。
- Design review R3：86 个既有 `use/next` 测试明确分流为 authenticated primitive redlines 与九个 named public E2E，禁止 common helper 全局桩 launcher，并以 fake-security mutation meta-test防假绿。manual bypass 改为 per-candidate map 以保留 `next`，identityMismatch 永不绕过；operator drills 先跑 origin/main baseline再对照，不冒充 required CI gate；deploy preflight验证 dist；env 空白回落、truthful next audit 均有断言。
- Lead 对 5h churn 的裁定已纳入：auto/repair/manual-next 的“可用”先要求 `fiveH<trigger5hPct`，集合空才 degraded fallback 到 weekly 尚有额度的高水位号；每组内部仍按 weekly reset 最早，explicit manual use 尊重指定 target。degraded 日志/通知与 milestone 保留 churn 风险。
- Spec coverage：atomic durable intent、manual/auto same executor、earliest reset、stale/exhausted/full-dead、no new daemon、显式 manual cooldown bypass/FLY-2229 非重叠、TDD/full gates/review/PR 均有对应 Task。
- Placeholder scan：clean；所有 behavior step 有具体路径、断言或命令。
- Type consistency：统一使用 `CandidateSelectionResult`、`SwitchNotificationIntent`、`SwitchNotificationContext`、`SwitchTrigger`、`pendingSwitchNotifications`；caller-side `notifySuccess` 明确删除。
- Scope：只动 `account-heal` 及其现有 bash/Bridge compatibility consumers；不修改 `CLAUDE.md`、Codex account rotation、FLY-2229 的 automatic/next cooldown fallback、独立告警层或 deployment。
