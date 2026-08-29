# FLY-900 撤掉 founder-UX 签字门 — 调研

Issue: FLY-900 (https://linear.app/geoforge3d/issue/FLY-900/infragovernance-撤掉-founder-ux-签字门fly-598-implement-前-signoff-annie)
日期: 2026-07-06
基于: exploration.md

---

## 1. 目标

fleet-wide 撤掉 founder-UX 签字门，代码保留可逆。exploration 已定：撤门必须同时关掉三个 enforcement 点（A prompt 注入 / B await-gate status 路由 / C stage-guard），只关一层会让 runner 卡死在另一层（Part 1 887/898 教训）。本调研把设计锚到 codebase 既有约定 + 精确改点 + 测试面。

---

## 2. 关键发现：接入 FLY-709 feature-flags registry（不是 bespoke env 读）

`packages/config/src/feature-flags/registry.ts` 是**所有 Flywheel flag 的单一真相**，配 `resolve.ts` 计算 effective 值 + 一个 **drift scanner**（每个读 `process.env.FLYWHEEL_*` / `env.FLYWHEEL_*` 的代码点必须在某 spec 的 `readSites` 登记，否则报漂移）。

**完美先例 — `three_stage_killswitch`（registry.ts:232）**：`FLYWHEEL_THREE_STAGE` 是个 **env、bridge_global** 开关，叠在 **per-project `pipeline.three_stage` config** 之上，作 fleet-wide override。注释原话：「主开关是 per-project config；本 env 是 fleet-wide 紧急 OFF」。

我要做的正是同构：**一个 env 开关叠在 per-project `founder_ux_gate.mode` config 之上**。既有 `founder_ux_gate` project-config entry 在 registry.ts:1380（governance_gate / readonly / default enforce）。

**治理门恒 readonly**：registry 明确「governance gates → ALWAYS readonly（default-enable-policy hard exemption，永不 web-toggleable）」。先例 `founder_consent_decision_mode`（1234）、既有 `founder_ux_gate`（1380）都是 governance_gate + readonly。→ 我的新 flag 也是 governance_gate + readonly。

**polarity**：Lead 要「默认 OFF」= 门默认禁用，`=1` 才启用 → **opt_in**（resolve.ts:107 opt_in idiom = `raw === "1"`）。与 `three_stage_killswitch` 的 default_on 相反（那个默认开、=0 关；我这个默认关、=1 开），因为 Annie 要撤掉门。

**读取 idiom 对齐**：resolve.ts:107 opt_in bool = `raw === "1"`。为让 registry 显示的 effective 与真实读取**字节一致**（registry 的核心契约 + drift scanner），真实读取也用 `=== "1"`（不额外认 "true"，避免 display drift；重启用 `.env` 写 `=1` 即可）。

---

## 3. 精确改点（4 处生产代码 + 1 registry + 测试）

### 3.1 新 helper（single source of flag 语义）
`packages/config/src/founder-ux-config.ts` 新增：
```ts
export function isFounderUxGateEnabled(env: Record<string,string|undefined> = process.env): boolean {
  // FLY-900: fleet-wide kill-switch. 默认 OFF（门禁用）；=1 才启用原 enforce。
  return env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED === "1";
}
```
导出经 packages/config/src/index.ts。`resolveEffectiveFounderUxConfig` **保持纯不动**（零 resolver 测试 churn）——env kill 挂在 enforcement 点，不改 config 解析默认。

### 3.2 A — Blueprint prompt 注入（runner 侧，从源头断 await-gate）
`packages/edge-worker/src/Blueprint.ts:1127-1128`
现状：`if (founderUxMode && founderUxMode !== "off")` → 注入 FOUNDER-UX GATE 段（叫 runner 跑 record-signoff + await-founder-ux-gate）。
改：注入条件 AND `isFounderUxGateEnabled(...)`（或 run-infra 传入的 gateEnabled，env-param call_time）。禁用 → 不注入 → **runner 根本不会去跑 await-gate**（治本，断 Layer A 源头）。
- readSite: `Blueprint.ts / buildSystemPromptLines / call_time`（参照 progress_resume flag 已有的同点登记）。

### 3.3 B — await-gate status 路由（Layer A，补 gap + 兼容 stale session）
`packages/teamlead/src/bridge/founder-ux/routes.ts:103-118` 的 `GET /api/founder-ux/status` handler
现状：`res.json({ approved: signoffSatisfies(store, execId, uxHash) })` —— 不看 mode。
改：handler 内先 `if (!isFounderUxGateEnabled()) { res.json({ approved: true }); return; }`（per-request call_time）。禁用 → `await-founder-ux-gate` 立即 approved 退出，不再 timeout fail-closed。
- readSite: `routes.ts / status route handler / call_time`。
- 注意 auth 不变（仍要 ingest bearer）；只在通过 auth 后短路 approved。

### 3.4 C — stage-guard（Layer B）
`packages/teamlead/src/bridge/event-route.ts:1742-1747` stage_changed→implement 调用 `evaluateFounderUxStageGuard`
改：调用前 `if (!isFounderUxGateEnabled()) → 当作 pass`（跳过 guard，读 session 快照前短路；兼容已 snapshot enforce 的 stale session）。`evaluateFounderUxStageGuard` **保持纯**（其 docstring 强调 exhaustively unit-testable）——env 短路放调用点，不进纯函数。
- readSite: `event-route.ts / stage_changed handler / call_time`。

### 3.5 附 — claude-lead.sh Lead 规则（shell 侧一致）
`packages/teamlead/scripts/claude-lead.sh:1955-1961`
现状：mode != off → 追加 `founder-ux-rules.md`。
改：追加前加 `[ "${FLYWHEEL_FOUNDER_UX_GATE_ENABLED:-}" = "1" ]` 判断，否则跳过（Lead 不再拿到 founder-ux 规则）。shell 直读 env（与 TS helper 同 `=1` 语义）。

### 3.6 registry 登记（drift scanner 要求）
`packages/config/src/feature-flags/registry.ts` 新增 spec：
```
name: "founder_ux_gate_killswitch", category: "governance_gate", source: "env",
scope: "bridge_global", envVar: "FLYWHEEL_FOUNDER_UX_GATE_ENABLED",
polarity: "opt_in", valueKind: "bool", default: false, toggleable: "readonly",
readSites: [Blueprint(A) call_time, routes.ts(B) call_time, event-route(C) call_time],
note: "FLY-900 fleet-wide 撤 founder-UX 签字门；叠在 per-project founder_ux_gate.mode 上；=1 恢复。重启生效。"
```
（若 drift scanner 也扫 shell，则加 claude-lead.sh 的 cli_invocation readSite；实现时核实 scanner 覆盖面。）

### 3.7 D 无需改
`event-route.ts:1717` `founder_ux_declared` 置 `founder_facing_ux=1` —— C 关掉后它喂的下游失效（inert），无需动。可选：禁用时 no-op（低优先，cleanliness）。

---

## 4. 覆盖证明（撤门完整性）

runner 从 dispatch 到进 implement，founder_ux_gate 能挡它的全部路径 → 全被关：
- prompt 不注入门步骤（A off）→ runner 不 record-signoff、不 await-gate；
- 万一某 runner 仍调 await-gate（旧 prompt / 手动）→ status 路由直接 approved（B off）；
- `stage set implement` 事件 → stage-guard pass（C off，且不读 stale 快照）；
- declare 置的 flag inert（D 随 C 失效）；
- Lead 不再拿 founder-ux 规则（shell off）。
=> 任一路径都不被门挡。反向 `=1` → A/B/C/规则全恢复原 enforce（可逆，代码 dormant 不删）。

---

## 5. 测试面（8 个既有 founder-ux 测试文件 + 新增）

既有（`grep` 定位）：
- `packages/config/src/__tests__/founder-ux-config.test.ts` — resolveEffectiveFounderUxConfig（**不动**，因 resolver 保持纯）。
- `packages/edge-worker/src/__tests__/Blueprint.fly598-founder-ux.test.ts` — A 注入；断言注入的用例需设 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1` 才走 ON 路径；加禁用→不注入用例。
- `packages/teamlead/src/bridge/founder-ux/__tests__/signoff-and-guard.test.ts` — C stage-guard + B signoffSatisfies **纯函数不动**；若含 handler 集成用例则设 =1。
- `packages/teamlead/src/bridge/__tests__/runs-route.founder-ux-exempt.test.ts` — run-start（founder_facing_ux 仍可置，inert；视断言调整）。
- `packages/flywheel-comm/src/__tests__/founder-ux.test.ts` — CLI 命令（await-gate CLI 逻辑不变，只 Bridge 侧 status 变；多为 mock，核实）。
- `packages/teamlead/scripts/__tests__/fly869-founder-ux-default-mode.test.sh` — claude-lead.sh；加禁用→不追加规则用例。
- verify.test.ts / fly618-qa-independent.integration.test.ts — 视是否触 B/C。

新增：
- `isFounderUxGateEnabled` 单测（unset→false / "1"→true / "0"/"true"/其他→false）。
- A/B/C 各一「禁用→放行」行为测（Blueprint 不注入 / status approved:true / stage-guard pass）。
- registry drift 测（resolve.direct-toggle 体系 + 新 spec readSites 覆盖）。
- reverse-compat sentinel：`=1` → 三点逐字恢复 enforce（防未来回归）。

**关键**：把 env 短路挂在**调用点**（Blueprint 注入条件 / routes handler / event-route 调用点），纯函数（evaluateFounderUxStageGuard / signoffSatisfies / resolveEffectiveFounderUxConfig）**全不动** → 纯函数单测零 churn，只集成/handler 测需设 =1。这是 Option 2 相对 Option 1（改 resolver 默认）的核心优势。

---

## 6. 边界复核（只碰这一个门）

- **不碰** ship 门：`approve_to_ship` / `founder-only-authority`（lead-rules-base）/ FLY-175 `founder_consent_decision_mode`（registry.ts:1234，与 founder_ux_gate 蓄意分离，types.ts:290 明确）。
- **不碰** codex 硬门 FLY-827（`codex_hard_gate_killswitch` / `FLYWHEEL_CODEX_HARD_GATE`）。
- **不碰** 独立 QA 门（`qa_done_gate_killswitch` / `merge_approval_gate_killswitch`）。
- **不碰** 三段式 Lead-对齐 `flywheel-comm gate brainstorm`（FLY-47 channel-contract gate 系统，与 founder_ux_gate 是完全不同代码路径）。
- 我的 flag 只读 founder_ux_gate 的 A/B/C/规则；对以上零触碰。

---

## 7. 部署 / 时序 / byte-compat

- 全 readSites 用 call_time，但治理门恒 readonly（不上 fleet console 直切）；`FLYWHEEL_FOUNDER_UX_GATE_ENABLED` env 改要 **Bridge 重启**生效 → 今晚 batched Tier-3（Lead 已定）。
- byte-compat 语义：代码逻辑对 `=1` 逐字等于现状（enforce）；默认 OFF 是**蓄意行为变更**（撤门，Annie 要的），非「零变化」——但完全可逆。
- 887/898：设计已交付，implement 由 Lead re-dispatch；重启+OFF 后新 dispatch 全程不被门挡。重启前若要立即 implement = per-issue 豁免（Lead 决定，见 exploration §7 Q3）。
