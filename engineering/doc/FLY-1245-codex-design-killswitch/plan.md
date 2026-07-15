# FLY-1245 design 段 Codex↔Fable kill-switch — 实施计划

Issue: FLY-1245 (https://linear.app/geoforge3d/issue/FLY-1245/add-flywheel-three-stage-codex-design-kill-switch-toggle-three-stage)
日期: 2026-07-14
基于: research.md

## 目标

加对称的 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 开关：`=1` → design 段派发 Codex（gpt-5.6-sol/xhigh）；不设/`!=1` → 现状 Fable（claude/heavy），字节兼容。默认 off。

## 变更清单（3 个源文件 + 1 个测试文件，doc 随分支）

### C1. `packages/config/src/three-stage-phases.ts`

1. 抽模块级常量（design 与 implement 的 codex spec 单一真相）：
   ```ts
   /** Annie's standard Codex config (ground truth: host ~/.codex/config.toml —
    *  model = "gpt-5.6-sol", model_reasoning_effort = "xhigh"). Shared by the
    *  implement default row AND the design kill-switch so a model rename is ONE
    *  line and the two codex phases can never drift. */
   const CODEX_STANDARD_DISPATCH: PhaseDispatchSpec = {
     vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh",
   };
   ```
   `DEFAULT_PHASE_DISPATCH.implement` 改为 `CODEX_STANDARD_DISPATCH`（值不变，`toEqual` 保绿）。

2. `resolvePhaseDispatch` 加 design 分支（放在 implement 分支旁）：
   ```ts
   if (phase === "design" && env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN === "1") {
     return CODEX_STANDARD_DISPATCH;
   }
   ```

3. 更新文件顶部 KILL-SWITCH 注释段（:30-33）+ `resolvePhaseDispatch` 的 JSDoc（:148-157），写清**两个开关方向相反的原因**：
   - implement 默认 codex → `=0` 回落 claude（default-on kill-switch）。
   - design 默认 claude/Fable → `=1` 切 codex（opt-in）。
   - 两者命名对齐 `FLYWHEEL_THREE_STAGE_CODEX_<PHASE>`；方向由各段默认 vendor 决定。
   - 顺带点出 design=Codex 的 review 自动翻 Claude lane（已由现有基建支持，指 three-stage-phases.ts:26-28 那条注释）。

### C2. `packages/config/src/feature-flags/registry.ts`

在 `three_stage_codex_implement_killswitch` 条目后加对称条目：
```ts
{
  name: "three_stage_codex_design_toggle",
  category: "kill_switch",
  source: "env",
  scope: "bridge_global",
  envVar: "FLYWHEEL_THREE_STAGE_CODEX_DESIGN",
  polarity: "opt_in",           // ← 与 implement 的 default_on 相反
  valueKind: "bool",
  default: false,               // ← 默认 off = design 仍 Fable
  description: "三段式 design 段 codex 派发开关（=1 → design 切 codex gpt-5.6-sol xhigh；不设=Fable claude/heavy；implement/qa 不受影响；改 ~/.flywheel/.env 后需 restart-services.sh --bridge-only）(FLY-1245)",
  readSites: [ envSite("packages/config/src/three-stage-phases.ts", "resolvePhaseDispatch", "call_time") ],
  toggleable: "readonly",
  note: "与 implement 开关方向相反：implement 默认 codex(=0 关)，design 默认 Fable(=1 开)。正交于 FLYWHEEL_THREE_STAGE / KEEPALIVE。",
}
```

### C3. `packages/config/src/__tests__/three-stage-phases.test.ts`（TDD：先写红）

新增 `describe("resolvePhaseDispatch design toggle (FLY-1245)")`：
- `resolvePhaseDispatch("design", { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" })` → `{ vendor:"codex", model:"gpt-5.6-sol", effort:"xhigh" }`。
- 不设 → `{ vendor:"claude", model:"claude-fable-5" }`（= `DEFAULT_PHASE_DISPATCH.design`，字节兼容）。
- 只有精确 `"1"` 激活（`"true"` / `"0"` → 仍 Fable）。
- design toggle **不碰** implement / qa。
- **交叉独立性**：`{ FLYWHEEL_THREE_STAGE_CODEX_DESIGN:"1", FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT:"0" }` → design=codex 且 implement=claude/heavy，两开关各自独立生效。

### C4. 无需改动（确认项，写进 PR 说明）

- cross-family review：design=Codex 自动走 FLY-1188 request-review Claude lane（research.md §3）。零改动。
- vendor 派发管线：复用 FLY-1224 已验证管线（research.md §4）。零改动。
- display/tag：`phaseMessageTag` / issue-display 已读 `resolvePhaseDispatch`，自动跟随。零改动。

## TDD 顺序

1. RED：C3 测试先写（design toggle 断言）→ 跑 `packages/config` 测试确认新用例红、旧用例仍绿。
2. GREEN：C1（抽常量 + design 分支）→ 新用例转绿。
3. C2 registry → `feature-flags-drift.test.ts` 转绿（注册新 env）。
4. REFACTOR：注释收尾（C1.3）。
5. 全量：`pnpm --filter flywheel-config test` + 全 suite + `pnpm typecheck` + `pnpm lint`。

## 验收（对齐 issue）

- [ ] 单测：`resolvePhaseDispatch('design', {FLYWHEEL_THREE_STAGE_CODEX_DESIGN:'1'})` → codex/gpt-5.6-sol/xhigh；不设 → claude/heavy 原样。
- [ ] 全 suite + typecheck + lint 绿。
- [ ] off 时字节兼容（`DEFAULT_PHASE_DISPATCH` toEqual 不变；design 派发不设开关时不变）。
- [ ] feature-flags drift 守卫绿（新 env 已注册）。
- [ ] Codex code review（FLY-827 硬门）过。

## 风险 / 边界

- 抽 `CODEX_STANDARD_DISPATCH` 改动了 `DEFAULT_PHASE_DISPATCH.implement` 的**写法**（引用常量），但**值不变** → `toEqual` 深比较保绿，运行时字节兼容。这是本计划唯一「触及既有 implement 代码」的地方，收益是消除 codex model 双处漂移，直接服务 issue 的「语义对齐」要求。若 review 更偏好纯 inline 字面量（design 分支内直接 `return { vendor:"codex", model:"gpt-5.6-sol", effort:"xhigh" }`，不动 implement），可退回——功能等价，仅少一层去重。
- 本次不做「按任务复杂度自动分流」——issue 明确那是长期方向，本次只交付「一键 env 切换」基建。
