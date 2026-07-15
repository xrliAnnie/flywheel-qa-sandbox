# FLY-1245 design 段 Codex↔Fable kill-switch — 调研

Issue: FLY-1245 (https://linear.app/geoforge3d/issue/FLY-1245/add-flywheel-three-stage-codex-design-kill-switch-toggle-three-stage)
日期: 2026-07-14
基于: exploration.md

## 1. `resolvePhaseDispatch` 现状（`packages/config/src/three-stage-phases.ts:158`）

```ts
export function resolvePhaseDispatch(
  phase: ThreeStagePhase,
  env: Record<string, string | undefined> = process.env,
): PhaseDispatchSpec {
  if (phase === "implement" && env.FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT === "0") {
    return { vendor: "claude", model: MODEL_TIERS.heavy.id };
  }
  return DEFAULT_PHASE_DISPATCH[phase];
}
```

`DEFAULT_PHASE_DISPATCH`（同文件 :140）：
```ts
design:    { vendor: "claude", model: MODEL_TIERS.heavy.id },       // = claude-fable-5
implement: { vendor: "codex",  model: "gpt-5.6-sol", effort: "xhigh" },
qa:        { vendor: "claude", model: MODEL_TIERS.medium.id },      // = claude-opus-4-8
```

改法：在 return 前加一个 design 分支（对称于 implement）。codex spec 与 implement 完全相同（`gpt-5.6-sol` / `xhigh`）。

**codex spec 去重决策**：`gpt-5.6-sol` / `xhigh` 目前只在 `DEFAULT_PHASE_DISPATCH.implement` 出现一处。design kill-switch 也要返回同一份「Annie 标准 Codex 配置」。为避免未来 model 改名时两处漂移（本文件顶部注释本就担忧「a model rename is a one-line diff here」），抽一个模块级常量 `CODEX_STANDARD_DISPATCH` 作单一真相，`DEFAULT_PHASE_DISPATCH.implement` 与 design 分支都引用它。这是命名值、非抽象层，符合「enforce simplicity」；同时直接落实 issue 要求的「命名/语义对齐已有 implement」。

## 2. feature-flags drift 守卫（`packages/config/src/__tests__/feature-flags-drift.test.ts`）

双向守卫：
- **正向**：production `src` 里凡是 `env.FLYWHEEL_X === "0"|"1"|"true"|"false"` 形式的布尔门（`BOOL_CMP` 正则），必须在 `FEATURE_FLAGS` 注册或进 `NON_FLAG_ALLOWLIST`。我新增的 `env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN === "1"` 命中此正则 → **必须注册**。
- **反向**：每个注册项的 `readSites[].file` 必须真的含该 env var 名。

结论：在 `registry.ts` 加一条 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 记录，`readSite` 指向 `three-stage-phases.ts` / `resolvePhaseDispatch`，`category: "kill_switch"`, `polarity: "opt_in"`, `default: false`（对比 implement 那条是 `polarity: "default_on"`, `default: true`）。`FlagPolarity = "default_on" | "opt_in"`（registry.ts:25）。

## 3. Cross-family review 路径核实（issue 重点 ⚠️，结论：现有基建已支持，零代码改动）

design=Codex 后，design 产出由 Codex 写。三段式里 design 段产出走的是 **design review** lane（不是 code-review gate）。核实链条：

1. **`isReviewableRole`（codex-gate.ts:50）** 对 `design` 返回 **false**——这是**正确的**：design 不 own PR、不到 `awaiting_review`（注释原文：「`design` never reaches `awaiting_review`」）。`isReviewableRole` 管的是 code-review / founder-hold 门（`main`/`implement`）。design 的 review 是**另一条独立 lane**，与 FLY-1231 那个 code-path verifiability gap（1 个未接线的列）无关。

2. **design review 自动翻到 Claude reviewer**：`event-route.ts:274-286` 的 `handleCodexAutoTrigger` 显式判 author：
   ```ts
   if ((refreshedSession?.adapter_type ?? "claude-tmux") === "codex-tmux") {
     // FLY-1188 §7.1: codex-tmux AUTHORS 不走 legacy codex-reviewer 触发；
     // review 由 runner 开 gate + /review-requests 注册 → ReviewRequestCoordinator
     // 跑跨厂商 Claude reviewer 应答绑定的 question。
     return;
   }
   ```
   design=Codex 时 session `adapter_type = "codex-tmux"` → 命中此分支 → design review 走 FLY-1188 request-review lane（Claude 审）。这正是 `three-stage-phases.ts:26-28` 注释承诺的「若 design 变 codex author，其 design review 自动翻到 Claude lane，无需新决策」。

3. **跨厂商由 coordinator 结构性保证**：`review-request-coordinator.ts` 处理 `reviewType==='design'|'code'` 两类；对非-claude author（codex）接受并跑 reviewer，而 `buildPrompt`（:766）**硬编码**「CROSS-FAMILY REVIEWER ... independent Claude lane」——即 design review 一定由 **Claude** 审。claude author 会被 :211 以 409 拒，强制走 legacy codex lane（防同厂商自审）。所以 reviewer-inversion 不变式对 design review 由「coordinator 恒跑 Claude reviewer + author-family 409 闸」保证，不依赖任何记录戳记。

4. **戳记记录（`codex_review_record` + `crossFamilyReviewSatisfied`）是 code-review-only**（Codex R1 LOW 核实）：`commitAuthorityIfApproved`（review-request-coordinator.ts:733）**只在** `job.review_type === "code"` 时写 `codex_review_record`（stamp `author_family=codex, reviewer_family=claude`），供 `verify-approval` / `isCodexCodeReviewApproved` / `crossFamilyReviewSatisfied` 做 merge 门。design review **不**写该记录——它的结果直接应答绑定的 `review_design` gate。因此 design=Codex **不碰** code-review 的戳记路径，与 FLY-1231 那个 code-path verifiability gap（1 个未接线的列）无关。

**综上**：design=Codex 的 design review 由现有 FLY-1188 §7.1 request-review lane **恒跑 Claude reviewer** 保证跨厂商，本 issue 无需任何 review-lane 改动，也不会引入新的 verifiability gap（戳记路径是 code-review-only，design 从不进入）。

## 4. vendor 派发管线端到端（design=Codex 真的 spawn codex-tmux）

- entry：`resolveThreeStageEntry`（three-stage-policy.ts:195）已调 `resolvePhaseDispatch("design", input.env)` → 返回 `dispatchModel/dispatchVendor/dispatchEffort`。
- 传递：`run-dispatcher.ts:555` 透传 `dispatchVendor/dispatchEffort` → `role-adapter-resolver.ts:211` `backend = VENDOR_TO_EXECUTOR[args.dispatchVendor]`。
- design=Codex 复用 implement 已上线验证（FLY-1224）的同一套 vendor 管线，仅是 design 段也走一遍。零新增管线代码。

## 5. display / tag 自动跟随

`phaseMessageTag`（:245）与 issue-display-refresher 已用 `resolvePhaseDispatch(role).model` 作 pending-行 fallback。design=Codex 时 design pending 行显示 GPT-5.6 而非 Fable——与 FLY-1224 R1 #3 修复一致（不给 codex 派发行显示 Fable）。零额外改动。

## 6. 测试面

`packages/config/src/__tests__/three-stage-phases.test.ts` 已有 implement kill-switch 的 4 个用例（describe "resolvePhaseDispatch kill-switch"）。新增对称的 design 用例组 + 交叉独立性用例。`DEFAULT_PHASE_DISPATCH` 的 `toEqual` 断言在抽常量后仍绿（深比较值）。
