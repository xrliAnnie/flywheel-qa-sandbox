# FLY-900 撤掉 founder-UX 签字门 — 实施计划

Issue: FLY-900 (https://linear.app/geoforge3d/issue/FLY-900/infragovernance-撤掉-founder-ux-签字门fly-598-implement-前-signoff-annie)
日期: 2026-07-06
基于: exploration.md, research.md

---

## 0. 一句话

新增 fleet-wide env kill-switch `FLYWHEEL_FOUNDER_UX_GATE_ENABLED`（默认 OFF），OFF 时把 founder-UX 签字门的三个 enforcement 点（Blueprint prompt 注入 / await-gate status 路由 / stage-guard）+ Lead 规则全放行；代码保留，`=1` 逐字恢复原 enforce（可逆，不硬删）。经 FLY-709 feature-flags registry 登记。改动需 Bridge 重启生效（随今晚 batched Tier-3）。

## 1. 目标 / 非目标

**目标**：撤掉 FLY-598/869 founder-UX implement-前签字门，fleet-wide，可逆。
**非目标（边界，绝不碰）**：`approve_to_ship` / `founder-only-authority` / FLY-175 `founder_consent`（ship 门）；FLY-827 codex 硬门；独立 QA 门（`qa_done_gate` / `merge_approval_gate`）；三段式 Lead-对齐 `flywheel-comm gate brainstorm`（不同代码路径）。

## 2. 设计（已选 Option 2 + registry 接入）

单一 helper 定义 flag 语义；env kill 精确挂在**三个真实阻断点 + Lead 规则**；纯函数（`resolveEffectiveFounderUxConfig` / `evaluateFounderUxStageGuard` / `signoffSatisfies`）全不动 → 纯函数单测零 churn。

flag 属性（对齐 registry 约定）：env / bridge_global / **governance_gate**（治理门恒 readonly）/ **opt_in**（默认 false，`=== "1"` 才启用）。先例 = `three_stage_killswitch`（env 叠在 per-project config 上的 fleet-wide override）。

## 3. 改动清单（精确到 file:symbol）

### 3.1 helper（新）— `packages/config/src/founder-ux-config.ts`
```ts
export function isFounderUxGateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // FLY-900: fleet-wide kill-switch. 默认 OFF（门禁用）；仅 "1" 启用原 enforce。
  return env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED === "1";
}
```
- 经 `packages/config/src/index.ts` 导出（供 edge-worker + teamlead import）。
- `resolveEffectiveFounderUxConfig` **不改**。

### 3.2 A — `packages/edge-worker/src/Blueprint.ts:1127-1128`（runner prompt 注入）
注入条件加 gate-enabled：
```ts
const founderUxMode = this.founderUxGateConfig?.mode;
if (founderUxMode && founderUxMode !== "off" && isFounderUxGateEnabled()) { ... }
```
禁用 → 不注入 FOUNDER-UX GATE 段 → runner 不 record-signoff、不 await-gate（治本，断 Layer A 源头）。

### 3.3 B — `packages/teamlead/src/bridge/founder-ux/routes.ts`（status 路由，Layer A）
`GET /api/founder-ux/status` handler（当前 line 105-117）在 auth 通过、参数校验后，`signoffSatisfies` 之前短路：
```ts
if (!isFounderUxGateEnabled()) { res.json({ approved: true }); return; }
```
禁用 → `await-founder-ux-gate` 立即 approved 退出（补 Layer A gap + 兼容 stale session）。auth（ingest bearer）不变。

### 3.4 C — `packages/teamlead/src/bridge/event-route.ts:1742-1747`（stage-guard，Layer B）
调用 `evaluateFounderUxStageGuard` 前短路：
```ts
if (isFounderUxGateEnabled()) {
  const guard = evaluateFounderUxStageGuard(store, mode, {...});
  // ...原 block/audit 处理
} // else: 门禁用 → 当作 pass，不读 snapshot、不 block
```
`evaluateFounderUxStageGuard` 保持纯不动。

### 3.5 D — `packages/teamlead/scripts/claude-lead.sh:1958`（Lead 规则，shell）
追加 `founder-ux-rules.md` 前加 env 判断：
```sh
if [ "${FLYWHEEL_FOUNDER_UX_GATE_ENABLED:-}" = "1" ] && [ "$FOUNDER_UX_MODE" != "off" ]; then
  CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_FOUNDER_UX_RULES")
fi
```
禁用 → Lead 不再拿 founder-ux 规则。

### 3.6 registry 登记 — `packages/config/src/feature-flags/registry.ts`（Codex R1-#1 修正）
新增 spec `founder_ux_gate_killswitch`。**readSite 只登记 helper 文件**（drift 测反向检查要求登记的 readSite 文件 `.includes(envVar)` 字面量；A/B/C 只调 `isFounderUxGateEnabled()` 无字面量，登记它们会让反向检查失败）：
```
category: "governance_gate", source: "env", scope: "bridge_global",
envVar: "FLYWHEEL_FOUNDER_UX_GATE_ENABLED", polarity: "opt_in",
valueKind: "bool", default: false, toggleable: "readonly",
readSites: [
  packages/config/src/founder-ux-config.ts / isFounderUxGateEnabled / env-param / call_time,
],
note: "FLY-900 fleet-wide 撤 founder-UX 签字门；单一 helper isFounderUxGateEnabled 被 Blueprint(A)/status route(B)/stage-guard(C)/claude-lead.sh 消费；叠在 per-project founder_ux_gate.mode 上；=1 恢复；重启生效。"
```
**drift 测已核实**（`feature-flags-drift.test.ts`）：
- forward scan 只扫 `packages/{teamlead,config,flywheel-comm,edge-worker}/src/*.ts` 的 `process.env.FLYWHEEL_*` 与 `env.FLYWHEEL_* ===/!== "0|1|true|false"`（boolean-gate anchored）。helper 的 `env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED === "1"` 命中 → 必须登记（本 spec 满足 “no silent new gate”）。A/B/C 调 helper 无字面量、非 env-gate 比较 → 不被扫、无需登记（plan/research 文档化为 consumer）。
- reverse check（“every registered env flag is read where its readSite file claims”）：登记的 `founder-ux-config.ts` `.includes("FLYWHEEL_FOUNDER_UX_GATE_ENABLED")` → 通过。
- claude-lead.sh 非 `.ts` → drift scanner **不覆盖 shell**（SCAN_DIRS 只含四个 `src`），无需登记（文档化为 shell-side 读取点）。

### 3.7 不改
- `resolveEffectiveFounderUxConfig`（纯，字节兼容）
- `evaluateFounderUxStageGuard` / `signoffSatisfies`（纯决策，短路在调用点）
- `founder_ux_declared` handler（D 随 C 失效，inert）
- run-start founder_facing_ux 置位（inert；不动以最小化 blast radius）

## 4. 覆盖证明

runner 从 dispatch→implement，门能挡它的全部路径皆关：A prompt 不注入→不跑 await-gate；B status→approved；C stage-guard→pass；D→inert；Lead 规则→不注入。反向 `=1` → 全恢复。（详 research §4）

## 5. 测试计划

**新增**：
- `isFounderUxGateEnabled` 单测：unset→false / "1"→true / "0"/"true"/""/其他→false。
- A：Blueprint 禁用→不注入 FOUNDER-UX 段；`=1`+mode enforce→注入（reverse-compat）。
- B：status 路由禁用→`approved:true`（不查 signoff）；`=1`→原 signoffSatisfies 行为。
- C：stage-guard 调用点禁用→pass（不 block founder-facing 无签字的 implement）；`=1`→原 block。
- registry：新 spec resolve + drift-scanner 覆盖（readSites 全登记，无漂移）。
- reverse-compat sentinel：`=1` 下 A/B/C 逐字等于现状 enforce。

**既有需调整**（设 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1` 保留 ON-path 断言）：
- `Blueprint.fly598-founder-ux.test.ts`（A 集成）。
- `signoff-and-guard.test.ts` / `verify.test.ts` / `fly618-qa-independent.integration.test.ts`（若触 B/C handler 集成）。
- `fly869-founder-ux-default-mode.test.sh`（claude-lead.sh 专用 shell test）。
- **launcher golden（Codex R1-#2 补漏）**：`fly231-companion-launch-plan.test.sh`（:194-199,:232,:270）+ `fly879-external-launch-plan.test.sh`。二者 golden 现含 `rule=founder-ux-rules.md`（FLY-869 default-ON 加的）。默认 OFF 后：**两默认都覆盖** —— (a) env 未设 → non-companion/non-external dept/cos lead golden **去掉** `founder-ux-rules.md`；(b) `=1`+mode!=off → 保留追加（现状行为）。external-agent 负向用例（本就不追加）作边界不变。
- `founder-ux-config.test.ts` / `runs-route.founder-ux-exempt.test.ts`：纯 resolver / run-start，**预期不动**（resolver 未改；run-start 置位保留）。

**全仓**：`pnpm test`（相关包）+ `pnpm lint`（biome）+ registry drift 测过。

## 6. Rollout / 部署

- 默认 OFF = 撤门（Annie 要的行为变更），`=1` 恢复（可逆）。
- 全 readSites call_time，但治理门恒 readonly（不上 fleet console 直切）；env 改要 **Bridge 重启**生效 → 今晚 batched Tier-3。
- **生效边界（Codex R2 非阻塞建议）**：A(Blueprint)/B(status 路由)/C(stage-guard) 都是 Bridge 侧 → **Bridge 重启即生效**（新 run-start 不注入 A、status 返 approved、stage-guard pass）。但 **D-shell（claude-lead.sh 移除 founder-ux 规则）只在每个 Lead 下次 relaunch/restart 时生效**（claude-lead.sh 在 Lead 启动时跑）——已在跑的 Lead 会保留 founder-ux 规则在其 prompt 里直到重启。对撤门无实质影响（Lead 规则只是引导文字，真 enforcement 在 A/B/C），但部署验证时注意这一时序差。
- PR → codex code review → **hold 在 founder ship-gate**（Annie review / Lead 按隔夜授权 executor merge）→ 随 Tier-3。绝不自 ship。
- 上线后验证：新 dispatch 的 issue 进 implement 不再被门挡；`await-founder-ux-gate`（若被调）返回 approved；Lead 启动 log 不再 append founder-ux 规则。

## 7. 与 887/898 的关系（Lead 已定：不提前解封）

Lead 决定（brainstorm gate 回复）：**不在重启前解封 887/898**——① 887 的 implement 本就在等 Annie 拍 model 优先级（Lead hold 着），提前解封没用；② 不搞 per-issue exempt re-dispatch（churn + 风险）；③ 让门正经撤（本 PR）+ 今晚重启后它俩自然进 implement。那两个卡在 await-gate 的 implement session 让它 **timeout 自然收**，重启后 Lead 重派。（Part 1 已清的 founder_facing_ux 标记无害、非必需，不回退。）

## 8. 风险 / 回滚

- **风险**：漏某 enforcement 点 → runner 仍卡。缓解：§4 覆盖证明 + A/B/C 各一行为测 + Codex design/code review（R1 已核实 A/B/C 是 Bridge-up 下全部主阻断点）。
- **风险**：既有测试假设 enforce-default 而红。缓解：§5 列出需设 `=1` 的测试（含 launcher golden）。
- **回滚（Codex R1-#3 修正 — 限定范围）**：`FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1` 恢复 enforce，但**「逐字 byte-identical」只对 `=1` 之后新启动的 Lead/Runner session 成立**。run-start 快照**不改**（`run-infra.ts` 仍传 effective `mode:enforce` 给 DirectEventSink + Blueprint；`founder_ux_gate_mode=enforce` / `founder_facing_ux=1` 仍会写库）。所以：一个在 **OFF 期间启动**的 session 没收到 A（prompt 注入），runner 没被告知去备 UX-brief/signoff；若之后重启回 `=1`，C 会拿它的 enforce 快照 enforce 它——**这与在 `=1` 下启动的 session 不等价**。→ 回滚 runbook：重启回 `=1` 只干净影响其后新启动的 session；**OFF 期间在飞的 session 需 re-dispatch 或人工处理**再 re-enable。若要求在飞 session 的干净回滚，则需给 fleet 开关做 per-session 快照（更大改动，本 PR 不做）。整体 revert PR 亦可。
- **接受的边缘（Codex R1-#4）**：`stage.ts:245-331` 把带 `ux_hash` 的 implement 事件当 gated-implement，Bridge-down / 非-gate 非-2xx 时 fail-closed 退出非零。**本 kill-switch 只解 Bridge-up 的 status/stage 路径 + 新 OFF prompt**（新 OFF run 不注入 A → 不发 `--ux-file` → 不触 gated 逻辑；Bridge-up 的 stale runner 经 C 放行）。**残余边缘**：旧 prompt / 手动带 `--ux-file` **且 Bridge down** 仍被 CLI fail-closed。**明确接受为 out-of-scope**（双重边缘：需 stale `--ux-file` prompt + Bridge 同时挂；门整体在撤，Bridge-down 是独立故障模式；补它要给 runner 可见 flag + `stage.ts` gatedImplement 分支 = 更大 blast radius，不值）。
- **byte-compat**：`=1` 下 A/B/C 逐字等于现状（对新启动 session）；纯函数零改动 → 无隐藏行为漂移。
