# FLY-1259 派单级 Design 后端覆盖 — 实施计划
Issue: FLY-1259 (https://linear.app/geoforge3d/issue/FLY-1259/feat-派单级-design-后端选择-apirunsstart-加-designbackend-参数覆盖全局开关codexfable)
日期: 2026-07-14
基于: research.md

> **For Implement phase:** 按任务顺序执行，每一项遵循 RED → GREEN → REFACTOR。Flywheel 三阶段流水线负责执行与审查，不从本计划派生子代理。

**Goal:** 让每次 `POST /api/runs/start` 可用 `designBackend: "codex" | "claude"` 锁定本次三阶段 run 的 design 后端，并让所有后续 phase 派发、事件与标题继承同一事实。

**Architecture:** 在 `resolvePhaseDispatch` 增加 design-only `{vendor}` override；`resolveThreeStageEntry` 在 admission 时解析 full dispatch triple 并锁定 effective vendor。锁定值通过 `StartRequest/RetryRequest → BlueprintContext → EventEnvelope → sessions.design_backend` 在 session create-time 持久化，orchestrator/retry/rescue 都从前一 session 复制；Lead event 与 FLY-1255 的统一 model renderer 读取同一字段。

**Tech Stack:** TypeScript、Express、Vitest、better-sqlite3、pnpm workspace、Flywheel Bridge/edge-worker event pipeline。

---

## Preconditions

实施开始前完成以下检查：

- [ ] 确认当前 TURN 属于 Implement phase；design 文档分支提交已经存在。
- [ ] 拉取/合并 Lead 指定的最新基线，确认 FLY-1257 的 retry TURN/startPoint 语义没有被本单回退。
- [ ] 当前分支已 revert 临时叠入的 FLY-1255，因此先完成 Task 1–7 与 Task 8A；只有 `packages/teamlead/src/bridge/runner-model-display.ts` 及其测试从正式 FLY-1255 基线出现后，才执行 Task 8B 和依赖 title renderer 的 Task 9/10 验收。不得创建替代 helper，也不得让不存在的 Vitest filter 静默通过。
- [ ] 用 `git status --short` 确认没有覆盖用户或其他 phase 的未提交改动。

## Locked-run operational contract

- 无论 request 是否显式携带 `designBackend`，首次三阶段 admission 都把当时解析出的有效 backend 锁进 `sessions.design_backend`；这是需求中的 dispatch-time lock，不改成“仅显式请求才锁定”。
- 因此 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 只影响新的、未显式指定 backend 的 admission，以及历史 `design_backend IS NULL` 记录。它不是已锁定 run 的 live reroute 开关；Bridge restart 后 retry/rescue 仍继承锁定值。
- 如果已锁定 run 因所选 vendor 的 quota/服务故障无法恢复，sanctioned recovery 是结束该失败 run，并用同一 issue 发起新的 `POST /api/runs/start`，显式指定相反的 `designBackend`。本过渡版不提供 retry-time mutation，因为那会违反“retry 继承同值”；代价是新 run 不继承旧 runner context/worktree。需要原地切换的能力留给 FLY-1135/FLY-1244 的完整 per-node dispatch 控制面。
- 不允许通过直接改 SQLite、复用 `dispatch_model` 推断 vendor，或把 `design_backend` 加入通用 metadata patch 来绕过锁定。

## File map

| Responsibility | Files |
|---|---|
| Enum + resolver precedence + flag semantics | `packages/config/src/three-stage-phases.ts`, `packages/config/src/index.ts`, `packages/config/src/feature-flags/registry.ts`, `packages/config/src/__tests__/three-stage-phases.test.ts`, `packages/config/src/__tests__/feature-flags-drift.test.ts` |
| Public request + entry lock + receipt | `packages/teamlead/src/bridge/runs-route.ts`, `packages/teamlead/src/bridge/three-stage-policy.ts`, `packages/teamlead/src/bridge/retry-dispatcher.ts`, `packages/teamlead/src/bridge/__tests__/three-stage-policy.test.ts`, `packages/teamlead/src/__tests__/start-e2e.test.ts` |
| Lead dispatch contract | `packages/teamlead/lead-rules-base/model-routing.md`, `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts` |
| Durable session field | `packages/teamlead/src/StateStore.ts`, `packages/teamlead/src/__tests__/StateStore.test.ts` |
| Request/context/event propagation | `packages/teamlead/src/bridge/run-dispatcher.ts`, `packages/edge-worker/src/Blueprint.ts`, `packages/edge-worker/src/ExecutionEventEmitter.ts`, their focused tests |
| Started-event persistence | `packages/teamlead/src/DirectEventSink.ts`, `packages/teamlead/src/bridge/event-route.ts`, `packages/teamlead/src/__tests__/DirectEventSink.test.ts`, `packages/teamlead/src/__tests__/event-route.test.ts` |
| Handoff/respawn inheritance | `packages/teamlead/src/bridge/phase-orchestrator.ts`, phase orchestrator tests |
| Retry/rescue inheritance | `packages/teamlead/src/bridge/actions.ts`, `packages/teamlead/src/bridge/rescue-runtime.ts`, `actions-retry-route.test.ts`, `rescue-runtime.test.ts`, retry E2E tests |
| Lead observability | `packages/teamlead/src/bridge/hook-payload.ts`, `DirectEventSink.ts`, `event-route.ts`, `mailbox-lead-runtime.ts`, `commdb-lead-runtime.ts`, formatter tests |
| Thread title integration (Task 8B release blocker) | FLY-1255 `runner-model-display.ts` and its test；当前分支不存在，必须等正式依赖基线 |
| Planned/message display honesty | `packages/config/src/three-stage-phases.ts`, every production `phaseMessageTag` caller, `issue-display-refresher.ts`, focused display tests |

## Task 1 — Add the typed design override to the phase resolver

**Files:**

- Modify: `packages/config/src/three-stage-phases.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/feature-flags/registry.ts`
- Test: `packages/config/src/__tests__/three-stage-phases.test.ts`
- Test: `packages/config/src/__tests__/feature-flags-drift.test.ts`

- [ ] **Step 1: Write failing precedence tests**

Add focused cases that prove both override directions and the scope boundary:

```ts
it("explicit codex design override beats a disabled global switch", () => {
  expect(
    resolvePhaseDispatch(
      "design",
      { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" },
      { vendor: "codex" },
    ),
  ).toEqual({ vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" });
});

it("explicit claude design override beats an enabled global switch", () => {
  expect(
    resolvePhaseDispatch(
      "design",
      { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
      { vendor: "claude" },
    ),
  ).toEqual({ vendor: "claude", model: "claude-fable-5" });
});

it("ignores the transitional design override for implement and qa", () => {
  expect(resolvePhaseDispatch("implement", {}, { vendor: "claude" })).toEqual(
    resolvePhaseDispatch("implement", {}),
  );
  expect(resolvePhaseDispatch("qa", {}, { vendor: "codex" })).toEqual(
    resolvePhaseDispatch("qa", {}),
  );
});
```

Also keep existing no-override tests unchanged; they are the byte-compat sentinel.

Add a semantic registry sentinel:

```ts
const designFlag = FEATURE_FLAGS.find(
  (flag) => flag.name === "three_stage_codex_design_toggle",
);
expect(designFlag?.description).toContain("未指定 designBackend");
expect(designFlag?.description).toContain("admission");
expect(designFlag?.description).toContain("retry/rescue 不再读");
expect(designFlag?.note).toContain("per-dispatch designBackend");
expect(designFlag?.note).toContain("新开 run");
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/three-stage-phases.test.ts src/__tests__/feature-flags-drift.test.ts
```

Expected: resolver cases fail because `resolvePhaseDispatch` accepts only two arguments, and the registry sentinel fails because it still describes the global flag as the sole determinant.

- [ ] **Step 3: Add the enum, guard and override contract**

In `three-stage-phases.ts` add:

```ts
/**
 * FLY-1224: three-stage phases only ever dispatch on a TRANSPORTED vendor —
 * a phase session must receive park/wake mailboxes and walk the gate flow.
 * No-transport backends (antigravity/kimi) are excluded at the TYPE level so
 * they can never enter the phase table.
 */
export type PhaseDispatchVendor = "claude" | "codex";

/** Transitional public choices for a three-stage run's design author. */
export type DesignBackend = PhaseDispatchVendor;
export const DESIGN_BACKENDS = ["codex", "claude"] as const satisfies readonly DesignBackend[];

export function isDesignBackend(value: unknown): value is DesignBackend {
  return DESIGN_BACKENDS.includes(value as DesignBackend);
}

export interface PhaseDispatchOverride {
  vendor: PhaseDispatchVendor;
}
```

Keep the existing authoritative `PhaseDispatchVendor` declaration and its FLY-1224 transported-vendor comment exactly in place. Derive the transitional `DesignBackend` type from it; do not make the permanent cross-phase vendor invariant depend on the revertible API array. The `satisfies` clause rejects public values that are not transported vendors, while the existing exact `allowed: ["codex", "claude"]` route tests pin this transition's runtime list and order.

Extend the resolver without changing default parameters:

```ts
export function resolvePhaseDispatch(
  phase: ThreeStagePhase,
  env: Record<string, string | undefined> = process.env,
  override?: PhaseDispatchOverride,
): PhaseDispatchSpec {
  if (phase === "design" && override?.vendor === "codex") {
    return CODEX_STANDARD_DISPATCH;
  }
  if (phase === "design" && override?.vendor === "claude") {
    return DEFAULT_PHASE_DISPATCH.design;
  }
  // existing implement kill-switch, design global switch and default branches
}
```

Export `DESIGN_BACKENDS`, `DesignBackend`, `isDesignBackend` and `PhaseDispatchOverride` from `packages/config/src/index.ts` beside the existing phase exports.

- [ ] **Step 4: Correct the operator-facing feature-flag contract**

Update `three_stage_codex_design_toggle` comment, description and note so they state the actual priority:

```ts
description:
  "三段式 design 段新 run admission fallback（仅在 admission 时且本次 run 未指定 designBackend：=1 → codex gpt-5.6-sol xhigh；不设/≠1 → claude/Fable；一旦写入 sessions.design_backend，retry/rescue 不再读本开关；implement/qa 不受影响；改 ~/.flywheel/.env 后需 restart-services.sh --bridge-only）(FLY-1245/FLY-1259)",
note:
  "per-dispatch designBackend 与已锁定 sessions.design_backend 优先于本全局 fallback；已锁定 run 如需换 vendor，结束旧 run 后以显式 designBackend 新开 run；display fallback 对新 run 先读 locked backend，legacy/null 才读本开关。",
```

Remove the old comment claim that every display fallback unconditionally follows the env table.

- [ ] **Step 5: Run GREEN and typecheck config**

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/three-stage-phases.test.ts src/__tests__/feature-flags-drift.test.ts
pnpm --filter flywheel-config typecheck
```

Expected: both commands exit 0; all pre-existing env/default cases still pass.

- [ ] **Step 6: Commit the resolver unit**

```bash
git add packages/config/src/three-stage-phases.ts packages/config/src/index.ts packages/config/src/feature-flags/registry.ts packages/config/src/__tests__/three-stage-phases.test.ts packages/config/src/__tests__/feature-flags-drift.test.ts
git commit -m "feat(config): support per-dispatch design backend override"
```

## Task 2 — Validate the public parameter and lock it at three-stage entry

**Files:**

- Modify: `packages/teamlead/src/bridge/runs-route.ts`
- Modify: `packages/teamlead/src/bridge/three-stage-policy.ts`
- Modify: `packages/teamlead/src/bridge/retry-dispatcher.ts`
- Modify: `packages/teamlead/lead-rules-base/model-routing.md`
- Test: `packages/teamlead/src/bridge/__tests__/three-stage-policy.test.ts`
- Test: `packages/teamlead/src/__tests__/start-e2e.test.ts`
- Test: `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts`

- [ ] **Step 1: Add failing entry-policy tests**

Add tests using opposite env values:

```ts
expect(
  resolveThreeStageEntry({
    ...eligibleInput,
    designBackend: "codex",
    env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" },
  }),
).toMatchObject({
  enteredThreeStage: true,
  designBackend: "codex",
  dispatchVendor: "codex",
  dispatchModel: "gpt-5.6-sol",
  dispatchEffort: "xhigh",
});

expect(
  resolveThreeStageEntry({
    ...eligibleInput,
    designBackend: "claude",
    env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
  }),
).toMatchObject({
  enteredThreeStage: true,
  designBackend: "claude",
  dispatchVendor: "claude",
  dispatchModel: "claude-fable-5",
});
```

Add non-entry assertions that `enteredThreeStage` is false, `notEnteredReasonCode` is bounded, `notEnteredDetail` retains the internal diagnostic, and `designBackend`/dispatch triple remain undefined. Cover `no-three-stage`, channel mismatch, global disable and disabled project config.

- [ ] **Step 2: Add failing public-route tests**

In `start-e2e.test.ts` cover:

```ts
it.each([42, true, "fable", "Codex", ""]) (
  "rejects invalid designBackend %# before dispatch",
  async (designBackend) => {
    const res = await postStart({ ...validBody, designBackend });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      code: "INVALID_DESIGN_BACKEND",
      reason: typeof designBackend === "string" ? "unknown_backend" : "wrong_type",
      allowed: ["codex", "claude"],
      silent: false,
    });
    expect(mockDispatcher.start).not.toHaveBeenCalled();
  },
);
```

Add three success assertions:

- explicit codex response ends with `designBackend: "codex"` and dispatcher receives the Codex triple plus `designBackend`;
- explicit claude response ends with `designBackend: "claude"` under global `1`;
- absent/null request response is exactly the existing five-key object and dispatcher behavior still follows env.

Add an explicit non-applicable failure test:

```ts
const res = await postStart({
  ...validBodyForNoThreeStageIssue,
  designBackend: "codex",
});
expect(res.status).toBe(400);
expect(await res.json()).toEqual({
  success: false,
  code: "DESIGN_BACKEND_NOT_APPLICABLE",
  reason: "no_three_stage_label",
  requested: "codex",
  silent: false,
});
expect(mockDispatcher.start).not.toHaveBeenCalled();
```

Add a non-main role case that fails before dedup/dispatch:

```ts
const res = await postStart({
  ...validBody,
  sessionRole: "qa",
  designBackend: "codex",
});
expect(res.status).toBe(400);
expect(await res.json()).toMatchObject({
  code: "DESIGN_BACKEND_NOT_APPLICABLE",
  reason: "non_main_role",
  requested: "codex",
});
expect(mockDispatcher.start).not.toHaveBeenCalled();
```

Add a channel-not-allowed case and assert the response contains `reason: "channel_not_allowed"` but its JSON text contains neither the dispatch channel id nor any configured allowlist id. Capture `console.warn` and assert the server-side diagnostic does include the internal policy detail.

Add a shipped-rule sentinel in `lead-rules-bundle.test.ts`:

```ts
const modelRules = readFileSync(
  join(BASE_RULES_DIR, "model-routing.md"),
  "utf8",
);
expect(modelRules).toContain('"designBackend": "codex"');
expect(modelRules).toContain('"designBackend": "claude"');
expect(modelRules).toContain("only the design phase");
expect(modelRules).toContain("DESIGN_BACKEND_NOT_APPLICABLE");
expect(modelRules).toContain("new admission");
expect(modelRules).toContain("start a new run");
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/three-stage-policy.test.ts src/__tests__/start-e2e.test.ts src/__tests__/lead-rules-bundle.test.ts
```

Expected: new fields/validation are missing.

- [ ] **Step 4: Extend the policy types and lock effective backend**

In `three-stage-policy.ts` add the typed input/result fields and resolve once:

```ts
export interface ThreeStageEntryInput {
  // existing fields
  designBackend?: DesignBackend;
}

export interface ThreeStageEntryDecision {
  // existing fields
  designBackend?: DesignBackend;
  notEnteredReasonCode?: ThreeStageNotEnteredReasonCode;
  /** Internal diagnostic only; never return verbatim over HTTP. */
  notEnteredDetail?: string;
}

if (input.requestRole !== "main") {
  return {
    role: input.requestRole,
    enteredThreeStage: false,
    notEnteredReasonCode: "non_main_role",
    notEnteredDetail: "request role is not main",
  };
}
const policy = resolveThreeStagePolicy({
  pipelineConfig: input.pipelineConfig,
  issueLabels: input.issueLabels,
  env: input.env,
  dispatchChannelId: input.dispatchChannelId,
});
if (!policy.enabled) {
  return {
    role: "main",
    enteredThreeStage: false,
    notEnteredReasonCode: policy.reasonCode ?? "policy_disabled",
    notEnteredDetail: policy.reason ?? "three-stage policy disabled",
  };
}
const override = input.designBackend
  ? { vendor: input.designBackend }
  : undefined;
const dispatch = resolvePhaseDispatch("design", input.env, override);

return {
  // existing entered result
  designBackend: dispatch.vendor,
  dispatchModel: dispatch.model,
  dispatchVendor: dispatch.vendor,
  dispatchEffort: dispatch.effort,
};
```

Define/export bounded codes shared by policy and entry:

```ts
export type ThreeStageDisabledReasonCode =
  | "global_disabled"
  | "no_three_stage_label"
  | "channel_not_allowed"
  | "policy_disabled";
export type ThreeStageNotEnteredReasonCode =
  | ThreeStageDisabledReasonCode
  | "non_main_role";

export interface ThreeStagePolicyDecision {
  enabled: boolean;
  reasonCode?: ThreeStageDisabledReasonCode;
  /** Internal diagnostic; never expose verbatim from the HTTP route. */
  reason?: string;
}
```

Add the matching `reasonCode` to every disabled return in `resolveThreeStagePolicy` while preserving its descriptive `reason` for internal logs. Do not return an effective backend from the non-entry branch.

| Policy branch | `reasonCode` |
|---|---|
| `FLYWHEEL_THREE_STAGE === "0"` | `global_disabled` |
| `no-three-stage` label | `no_three_stage_label` |
| channel missing/not in allowlist | `channel_not_allowed` |
| project pipeline absent/disabled | `policy_disabled` |

- [ ] **Step 5: Validate request body with existing route error conventions**

In `runs-route.ts`, next to `docTier` and `model` validation:

```ts
const rawDesignBackend = req.body.designBackend;
let requestedDesignBackend: DesignBackend | undefined;
if (rawDesignBackend === undefined || rawDesignBackend === null) {
  requestedDesignBackend = undefined;
} else if (typeof rawDesignBackend !== "string") {
  res.status(400).json({
    success: false,
    code: "INVALID_DESIGN_BACKEND",
    reason: "wrong_type",
    allowed: [...DESIGN_BACKENDS],
    silent: false,
  });
  return;
} else if (!isDesignBackend(rawDesignBackend)) {
  res.status(400).json({
    success: false,
    code: "INVALID_DESIGN_BACKEND",
    reason: "unknown_backend",
    allowed: [...DESIGN_BACKENDS],
    silent: false,
  });
  return;
} else {
  requestedDesignBackend = rawDesignBackend;
}
```

After `role` is normalized from `sessionRole`, reject the non-main combination before active-session dedup and before the `if (role === "main")` policy block:

```ts
if (requestedDesignBackend && role !== "main") {
  res.status(400).json({
    success: false,
    code: "DESIGN_BACKEND_NOT_APPLICABLE",
    reason: "non_main_role",
    requested: requestedDesignBackend,
    silent: false,
  });
  return;
}
```

Pass `requestedDesignBackend` into `resolveThreeStageEntry`. Inside the existing `if (role === "main")` block, immediately after `entry` is created and while it is in scope, fail a disabled policy without leaking its detailed string:

```ts
if (requestedDesignBackend && !entry.enteredThreeStage) {
  console.warn(
    `[runs/start] designBackend=${requestedDesignBackend} not applicable: ${entry.notEnteredDetail ?? entry.notEnteredReasonCode ?? "policy_disabled"}`,
  );
  res.status(400).json({
    success: false,
    code: "DESIGN_BACKEND_NOT_APPLICABLE",
    reason: entry.notEnteredReasonCode ?? "policy_disabled",
    requested: requestedDesignBackend,
    silent: false,
  });
  return;
}
```

Declare the effective value beside `dispatchVendor`/`dispatchEffort`, outside the role block:

```ts
let effectiveDesignBackend: DesignBackend | undefined;
```

When entered, assign `effectiveDesignBackend = entry.designBackend`, pass it into `startDispatcher.start`, and add it to the applied override response:

```ts
return res.json({
  success: true,
  executionId: result.executionId,
  issueId: result.issueId,
  chatThreadId,
  message: `Runner started for ${issueId}`,
  ...(requestedDesignBackend && effectiveDesignBackend
    ? { designBackend: effectiveDesignBackend }
    : {}),
});
```

The condition deliberately excludes absent requests. A non-entry explicit request never reaches this response because it failed before dispatch.

- [ ] **Step 6: Add the internal start/retry metadata field**

In `retry-dispatcher.ts`, import `DesignBackend` and add to both request interfaces:

```ts
/** FLY-1259: effective design backend locked at three-stage admission. */
designBackend?: DesignBackend;
```

This field carries metadata only. Adapter resolution continues to use `dispatchVendor/model/effort`.

- [ ] **Step 7: Teach the shipped Lead rule how to use the field**

Add a `## Three-stage design backend` section to `model-routing.md` with this contract:

```markdown
For an engineering run that enters the three-stage pipeline, an explicit
per-dispatch design choice goes in the same `/api/runs/start` body:

- `"designBackend": "codex"` selects the standard Codex design runner.
- `"designBackend": "claude"` selects the standard Claude/Fable design runner.

This affects only the design phase; it is not a synonym for the general
`model` difficulty parameter. A valid explicit value overrides the Bridge's
global design switch for this run and is echoed in the start receipt. When
there is no explicit founder, issue, or Lead choice, omit `designBackend` so
the current global default is read for that new admission. The effective
backend is then locked: retry/rescue does not re-read the switch. To change
vendor after a locked run fails, end that run and start a new run with an
explicit `designBackend`; this transitional API does not mutate a run in
place. Never restart Bridge merely to route one task. Unknown values fail with
`400 INVALID_DESIGN_BACKEND`; a valid
choice that cannot enter three-stage fails before dispatch with
`400 DESIGN_BACKEND_NOT_APPLICABLE` and a bounded reason code. `non_main_role`
means the caller attempted to combine the public override with an internal phase
role. Never treat a missing receipt field as an applied choice.
```

Keep the wording generic and shipped; do not mention Annie, this ticket's test model assignment, or project-private executors.

- [ ] **Step 8: Run GREEN and typecheck TeamLead**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/three-stage-policy.test.ts src/__tests__/start-e2e.test.ts src/__tests__/lead-rules-bundle.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: focused tests exit 0; absent request exact-equality sentinel passes.

- [ ] **Step 9: Commit the API/admission unit**

```bash
git add packages/teamlead/src/bridge/runs-route.ts packages/teamlead/src/bridge/three-stage-policy.ts packages/teamlead/src/bridge/retry-dispatcher.ts packages/teamlead/lead-rules-base/model-routing.md packages/teamlead/src/bridge/__tests__/three-stage-policy.test.ts packages/teamlead/src/__tests__/start-e2e.test.ts packages/teamlead/src/__tests__/lead-rules-bundle.test.ts
git commit -m "feat(teamlead): accept per-run design backend"
```

## Task 3 — Persist immutable effective backend in session state

**Files:**

- Modify: `packages/teamlead/src/StateStore.ts`
- Test: `packages/teamlead/src/__tests__/StateStore.test.ts`

- [ ] **Step 1: Write failing StateStore lifecycle tests**

Cover initial insert, placeholder fill, replay immutability and mapping:

```ts
it("locks design_backend on the first non-null session upsert", () => {
  store.upsertSession(makeSession({ design_backend: undefined }));
  store.upsertSession(makeSession({ design_backend: "codex" }));
  expect(store.getSession("exec-1")?.design_backend).toBe("codex");

  store.upsertSession(makeSession({ design_backend: "claude" }));
  expect(store.getSession("exec-1")?.design_backend).toBe("codex");
});

it("round-trips claude and leaves legacy rows undefined", () => {
  store.upsertSession(makeSession({ execution_id: "claude", design_backend: "claude" }));
  store.upsertSession(makeSession({ execution_id: "legacy" }));
  expect(store.getSession("claude")?.design_backend).toBe("claude");
  expect(store.getSession("legacy")?.design_backend).toBeUndefined();
});

it("locks design_backend on the first non-null persistTransition write", () => {
  store.persistTransition("transition-exec", "running", {
    issue_id: "issue-1",
    project_name: "Flywheel",
    design_backend: "codex",
  });
  store.persistTransition("transition-exec", "running", {
    issue_id: "issue-1",
    project_name: "Flywheel",
    design_backend: "claude",
  });
  expect(store.getSession("transition-exec")?.design_backend).toBe("codex");
});
```

The first test must call `upsertSession`; the third must call `persistTransition` directly. Add a migration fixture opening a pre-column DB and assert the field can be written afterward.

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.test.ts
```

Expected: `design_backend` is not part of `SessionUpsert`/schema.

- [ ] **Step 3: Add the typed field to state contracts and schema**

Import `DesignBackend`/`isDesignBackend` from `flywheel-config`. Add:

```ts
design_backend?: DesignBackend;
```

to `SessionUpsert` and `Session`.

Add `design_backend TEXT` to the initial `sessions` table and an additive migration:

```ts
try {
  this.db.run("ALTER TABLE sessions ADD COLUMN design_backend TEXT");
} catch {
  // Existing databases already have the column.
}
```

Add the column, placeholder and bound value to both hand-written statements by name:

- `StateStore.upsertSession`;
- `StateStore.persistTransition`.

The conflict assignment in both must be set-once, intentionally opposite to ordinary mutable metadata:

```sql
design_backend = COALESCE(design_backend, excluded.design_backend)
```

Do not add it to the generic overwrite-style `patchSessionMetadata` whitelist; the dispatch-time lock must not be mutable after first non-null persistence.

Map rows defensively:

```ts
design_backend: isDesignBackend(row.design_backend)
  ? row.design_backend
  : undefined,
```

- [ ] **Step 4: Run GREEN and typecheck**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: migration passes; both direct writer tests preserve the first non-null value after an opposite replay; both SQL bind counts match.

- [ ] **Step 5: Commit the state unit**

```bash
git add packages/teamlead/src/StateStore.ts packages/teamlead/src/__tests__/StateStore.test.ts
git commit -m "feat(state): lock design backend on phase sessions"
```

## Task 4 — Carry locked metadata through dispatcher and event envelopes

**Files:**

- Modify: `packages/teamlead/src/bridge/run-dispatcher.ts`
- Modify: `packages/edge-worker/src/Blueprint.ts`
- Modify: `packages/edge-worker/src/ExecutionEventEmitter.ts`
- Test: `packages/teamlead/src/__tests__/run-dispatcher.test.ts`
- Test: `packages/edge-worker/src/__tests__/ExecutionEventEmitter.test.ts`

- [ ] **Step 1: Write failing propagation tests**

Assert both `RunDispatcher.start` and `.dispatch` copy request metadata into captured Blueprint context:

```ts
expect(capturedContext.designBackend).toBe("codex");
```

In `ExecutionEventEmitter.test.ts`, call `emitStarted` with `designBackend: "claude"` and assert the POST payload contains:

```ts
payload: expect.objectContaining({ designBackend: "claude" })
```

Also assert an undefined value omits the payload key.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/run-dispatcher.test.ts
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/ExecutionEventEmitter.test.ts
```

Expected: context/envelope fields do not exist.

- [ ] **Step 3: Extend context and event contracts**

In `Blueprint.ts`:

```ts
/** FLY-1259: effective design vendor locked at three-stage admission. */
designBackend?: DesignBackend;
```

In `ExecutionEventEmitter.ts::EventEnvelope` add the same typed field. When Blueprint constructs the envelope:

```ts
...(ctx.designBackend && { designBackend: ctx.designBackend }),
```

When `TeamLeadClient.emitStarted` creates the HTTP payload:

```ts
designBackend: env.designBackend,
```

- [ ] **Step 4: Thread both dispatcher paths**

In both Blueprint context constructions in `run-dispatcher.ts` add:

```ts
...(req.designBackend && { designBackend: req.designBackend }),
```

Do not feed this field to `resolveRoleAdapter`; `dispatchVendor` remains the adapter-selection input.

- [ ] **Step 5: Run GREEN and package typechecks**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/run-dispatcher.test.ts
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/ExecutionEventEmitter.test.ts
pnpm --filter flywheel-edge-worker typecheck
pnpm --filter flywheel-teamlead typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the transport unit**

```bash
git add packages/teamlead/src/bridge/run-dispatcher.ts packages/edge-worker/src/Blueprint.ts packages/edge-worker/src/ExecutionEventEmitter.ts packages/teamlead/src/__tests__/run-dispatcher.test.ts packages/edge-worker/src/__tests__/ExecutionEventEmitter.test.ts
git commit -m "feat(runtime): propagate locked design backend metadata"
```

## Task 5 — Persist the field in both started-event sinks

**Files:**

- Modify: `packages/teamlead/src/DirectEventSink.ts`
- Modify: `packages/teamlead/src/bridge/event-route.ts`
- Test: `packages/teamlead/src/__tests__/DirectEventSink.test.ts`
- Test: `packages/teamlead/src/__tests__/event-route.test.ts`

- [ ] **Step 1: Write failing sink-parity tests**

Direct sink:

```ts
await sink.emitStarted(makeEnvelope({
  sessionRole: "design",
  chatThreadRole: "design",
  designBackend: "codex",
}));
expect(store.getSession(EXEC_ID)?.design_backend).toBe("codex");
await sink.emitStarted(makeEnvelope({
  sessionRole: "design",
  chatThreadRole: "design",
  designBackend: "claude",
}));
expect(store.getSession(EXEC_ID)?.design_backend).toBe("codex");
```

HTTP route:

```ts
await postEvent({
  event_type: "session_started",
  payload: {
    sessionRole: "design",
    chatThreadRole: "design",
    designBackend: "claude",
  },
});
expect(store.getSession(EXEC_ID)?.design_backend).toBe("claude");
await postEvent({
  event_type: "session_started",
  payload: {
    sessionRole: "design",
    chatThreadRole: "design",
    designBackend: "codex",
  },
});
expect(store.getSession(EXEC_ID)?.design_backend).toBe("claude");
```

Run the two-event HTTP replay assertion once with transition wiring enabled (`persistTransition`) and once with raw upsert wiring (`upsertSession`). Add an invalid HTTP payload case (`"fable"`) that persists undefined rather than poisoning state. These assertions are required even though Task 3 tests both writers directly: they prove the event route actually passes the locked field into each writer.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/DirectEventSink.test.ts src/__tests__/event-route.test.ts
```

Expected: state has no `design_backend` value.

- [ ] **Step 3: Implement direct and HTTP persistence**

In `DirectEventSink.emitStarted` session upsert:

```ts
design_backend: env.designBackend,
```

In `event-route.ts` started handler:

```ts
const eventDesignBackend = isDesignBackend(payload.designBackend)
  ? payload.designBackend
  : undefined;
```

Add to both transition metadata and raw upsert metadata:

```ts
...(eventDesignBackend && { design_backend: eventDesignBackend }),
```

The StateStore set-once clause prevents replay from replacing an existing backend.

- [ ] **Step 4: Run GREEN and typecheck**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/DirectEventSink.test.ts src/__tests__/event-route.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: both sinks persist the same valid value, an opposite replay cannot replace it in either event-route branch, and unknown wire values are ignored.

- [ ] **Step 5: Commit the sink unit**

```bash
git add packages/teamlead/src/DirectEventSink.ts packages/teamlead/src/bridge/event-route.ts packages/teamlead/src/__tests__/DirectEventSink.test.ts packages/teamlead/src/__tests__/event-route.test.ts
git commit -m "feat(events): persist effective design backend at start"
```

## Task 6 — Propagate the lock through all orchestrator successors

**Files:**

- Modify: `packages/teamlead/src/bridge/phase-orchestrator.ts`
- Test: `packages/teamlead/src/bridge/__tests__/phase-orchestrator.test.ts`
- Test: `packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts`

- [ ] **Step 1: Write failing normal-handoff test**

Seed a completed design session with `design_backend: "codex"`, dispatch implement, then assert:

```ts
expect(start).toHaveBeenCalledWith(expect.objectContaining({
  sessionRole: "implement",
  designBackend: "codex",
  dispatchVendor: "codex",
  dispatchModel: "gpt-5.6-sol",
}));
```

The implement triple assertion proves metadata propagation does not override the target phase table.

- [ ] **Step 2: Write failing fix-loop and QA-respawn tests**

For QA fail → implement-fix and dead QA respawn, seed predecessor rows with `design_backend: "claude"` and assert every `start` request contains `designBackend: "claude"` while the target phase triple remains implement Codex or QA Opus respectively.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/phase-orchestrator.test.ts src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts
```

Expected: successor requests omit `designBackend`.

- [ ] **Step 4: Extend orchestrator session/dependency contracts**

In `PhaseSession`:

```ts
/** FLY-1259: run-level effective design backend copied across phase rows. */
design_backend?: DesignBackend;
```

In `PhaseOrchestratorDeps.startDispatcher.start` input:

```ts
designBackend?: DesignBackend;
```

At every phase successor call—normal `dispatchNextPhase`, implement-fix and QA respawn—copy from the source session:

```ts
...(source.design_backend && { designBackend: source.design_backend }),
```

Use the actual variable name at each site (`prev`, `qa`, `implement`, etc.); do not re-read env.

- [ ] **Step 5: Run GREEN and all phase tests**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/phase-orchestrator.test.ts src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts src/bridge/__tests__/phase-orchestrator.fly939-wake-not-respawn.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: all successors preserve metadata; TURN/keepalive/respawn behavior remains green.

- [ ] **Step 6: Commit the orchestrator unit**

```bash
git add packages/teamlead/src/bridge/phase-orchestrator.ts packages/teamlead/src/bridge/__tests__/phase-orchestrator.test.ts packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts
git commit -m "feat(phases): inherit design backend across handoffs"
```

## Task 7 — Make retry and rescue consume the locked value

**Files:**

- Modify: `packages/teamlead/src/bridge/actions.ts`
- Modify: `packages/teamlead/src/bridge/rescue-runtime.ts`
- Test: `packages/teamlead/src/bridge/__tests__/actions-retry-route.test.ts`
- Test: `packages/teamlead/src/__tests__/retry-e2e.test.ts`
- Test: `packages/teamlead/src/__tests__/rescue-runtime.test.ts`

- [ ] **Step 1: Write failing retry tests for both directions**

Case A seeds a failed design row with `design_backend: "codex"`, sets global switch to `"0"`, triggers retry and expects:

```ts
expect(dispatched[0]).toMatchObject({
  designBackend: "codex",
  dispatchVendor: "codex",
  dispatchModel: "gpt-5.6-sol",
  dispatchEffort: "xhigh",
});
```

Case B seeds `design_backend: "claude"`, sets global to `"1"`, and expects Claude/Fable. Add a legacy/null row test that still follows env. Add retry-of-retry E2E assertion that the successor session stores the same backend.

- [ ] **Step 2: Write failing rescue tests**

Extend `buildRescueSuccessorDispatchFields` cases:

```ts
expect(buildRescueSuccessorDispatchFields({
  chat_thread_role: "design",
  session_role: "design",
  dispatch_model: null,
  design_backend: "claude",
})).toMatchObject({
  designBackend: "claude",
  dispatchVendor: "claude",
  dispatchModel: "claude-fable-5",
});
```

Run with global `1` to prove the stored value wins. Add an implement row assertion that carries `designBackend` metadata but retains the implement triple.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/actions-retry-route.test.ts src/__tests__/retry-e2e.test.ts src/__tests__/rescue-runtime.test.ts
```

Expected: current code re-reads the global design switch and omits metadata.

- [ ] **Step 4: Apply locked precedence in `actions.ts`**

Replace the phase dispatch calculation with:

```ts
const phaseRole = isThreeStagePhaseRole(session.chat_thread_role)
  ? session.chat_thread_role
  : undefined;
const designOverride =
  phaseRole === "design" && session.design_backend
    ? { vendor: session.design_backend }
    : undefined;
const phaseDispatch = phaseRole
  ? resolvePhaseDispatch(phaseRole, process.env, designOverride)
  : undefined;
```

Pass metadata on the retry request for every phase successor:

```ts
designBackend: phaseRole ? session.design_backend : undefined,
```

Do not replace the existing FLY-1257 TURN/startPoint logic and do not infer from `dispatch_model`.

- [ ] **Step 5: Apply the same rule in rescue**

Extend the source Pick and return type with `design_backend`/`designBackend`. Resolve with:

```ts
const designOverride =
  phaseRole === "design" && s.design_backend
    ? { vendor: s.design_backend }
    : undefined;
const dispatch = resolvePhaseDispatch(phaseRole, process.env, designOverride);

return {
  sessionRole: phaseRole,
  designBackend: s.design_backend,
  dispatchModel: dispatch.model,
  dispatchVendor: dispatch.vendor,
  dispatchEffort: dispatch.effort,
  ignoreRunnerLabelSelection: true,
  shareParentBranch: true,
};
```

Non-phase rescue keeps its previous return shape.

- [ ] **Step 6: Run GREEN, retry suites and typecheck**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/actions-retry-route.test.ts src/__tests__/retry-e2e.test.ts src/__tests__/retry-doc-tier.test.ts src/__tests__/rescue-runtime.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: locked rows beat env; legacy rows preserve current env behavior; FLY-1257-related retry tests remain green.

- [ ] **Step 7: Commit the retry/rescue unit**

```bash
git add packages/teamlead/src/bridge/actions.ts packages/teamlead/src/bridge/rescue-runtime.ts packages/teamlead/src/bridge/__tests__/actions-retry-route.test.ts packages/teamlead/src/__tests__/retry-e2e.test.ts packages/teamlead/src/__tests__/rescue-runtime.test.ts
git commit -m "fix(phases): preserve design backend on retry and rescue"
```

## Task 8A — Keep events, planned models and message tags source-honest

**Files:**

- Modify: `packages/teamlead/src/bridge/hook-payload.ts`
- Modify: `packages/teamlead/src/DirectEventSink.ts`
- Modify: `packages/teamlead/src/bridge/event-route.ts`
- Modify: `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`
- Modify: `packages/teamlead/src/bridge/commdb-lead-runtime.ts`
- Modify: `packages/config/src/three-stage-phases.ts`
- Modify: `packages/teamlead/src/bridge/issue-display-refresher.ts`
- Modify: `packages/teamlead/src/bridge/post-ship-finalization.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts`
- Modify: `packages/teamlead/src/bridge/stuck-escalation.ts`
- Modify: `packages/teamlead/src/bridge/auto-qa-effects.ts`
- Modify: `packages/teamlead/src/bridge/gate-poller.ts`
- Test: `packages/teamlead/src/__tests__/DirectEventSink.test.ts`
- Test: `packages/teamlead/src/__tests__/event-route.test.ts`
- Test: `packages/teamlead/src/__tests__/mailbox-lead-runtime.test.ts`
- Test: `packages/teamlead/src/__tests__/commdb-lead-runtime.test.ts`
- Test: `packages/config/src/__tests__/fly892-phase-tag.test.ts`
- Test: `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts`

- [ ] **Step 1: Write failing notification parity tests**

Build the same event for both runtimes:

```ts
const event = {
  event_type: "session_started",
  execution_id: "exec-design",
  issue_id: "issue-1",
  session_role: "design",
  design_backend: "codex",
};
```

Assert both formatted strings contain adjacent high-signal lines:

```text
[Event #7] [DESIGN] session_started
ID: exec-design | Issue: issue-1
Design Backend: codex
```

Add sentinel cases proving no line is added to main/implement events or when the field is absent.

- [ ] **Step 2: Write failing phase-tag and both pending-header tests**

In `fly892-phase-tag.test.ts`, set the global switch opposite to the locked value and assert:

```ts
process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "0";
expect(phaseMessageTag("design", null, "codex")).toBe(
  "[设计·GPT-5.6] ",
);
process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "1";
expect(phaseMessageTag("design", undefined, "claude")).toBe(
  "[设计·Fable] ",
);
expect(phaseMessageTag("design", undefined, undefined)).toBe(
  "[设计·GPT-5.6] ",
);
```

Restore the env after each test. This task intentionally makes both parameters 2 and 3 explicit. Update two-argument calls with the backend third argument, and update every single-argument call as `phaseMessageTag(role, undefined, undefined)`.

In `issue-display-refresher.test.ts`, seed a pending design session with `design_backend: "codex"`, `runner_model: undefined`, and global `0`; assert `plannedModel` and label both use GPT-5.6. Repeat with `design_backend: "claude"`, global `1`, and assert Fable. Execute these assertions once through the legacy header path and once through the current issue-display path so both `plannedModel` blocks are covered.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/fly892-phase-tag.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/DirectEventSink.test.ts src/__tests__/event-route.test.ts src/__tests__/mailbox-lead-runtime.test.ts src/__tests__/commdb-lead-runtime.test.ts src/bridge/__tests__/issue-display-refresher.test.ts
```

Expected: `design_backend` is missing from HookPayload/formatter/display inputs; phase tags and pending headers follow the opposite global value instead of the lock.

- [ ] **Step 4: Populate HookPayload from persisted session truth**

Add to `HookPayload`:

```ts
/** FLY-1259: effective backend locked for a three-stage run's design phase. */
design_backend?: DesignBackend;
```

In both `DirectEventSink.pushNotification` and event-route hook construction:

```ts
design_backend: session.design_backend,
```

Using the post-upsert session value makes notifications consistent with retry truth and replay immutability.

- [ ] **Step 5: Render the design-only line with runtime parity**

In both generic formatters, immediately after `ID`/`Title` handling:

```ts
if (
  e.event_type === "session_started" &&
  e.session_role === "design" &&
  e.design_backend
) {
  lines.push(`Design Backend: ${e.design_backend}`);
}
```

Keep both files structurally identical.

- [ ] **Step 6: Make `phaseMessageTag` require an explicit lock argument**

Change its signature and fallback:

```ts
export function phaseMessageTag(
  role: string | null | undefined,
  runnerModel: string | null | undefined,
  designBackend: DesignBackend | null | undefined,
): string {
  if (!isThreeStagePhaseRole(role)) return "";
  const override =
    role === "design" && designBackend
      ? { vendor: designBackend }
      : undefined;
  const name = PHASE_MESSAGE_NAME[role];
  const model =
    modelDisplayName(runnerModel) ??
    modelDisplayName(
      resolvePhaseDispatch(role, process.env, override).model,
      DEFAULT_PHASE_TIER[role],
    );
  return model ? `[${name}·${model}] ` : `[${name}] `;
}
```

Parameters 2 and 3 are intentionally required at type level: `runnerModel` loses its optional `?`, and the new lock argument is also required. Update every production caller found by:

```bash
rg -n "phaseMessageTag\\(" packages/teamlead/src --glob '!**/*.test.ts'
```

For session-backed calls in `post-ship-finalization.ts`, `plugin.ts`, `stuck-escalation.ts`, `auto-qa-effects.ts` and both `gate-poller.ts` sites, pass `session.runner_model` and `session.design_backend` (or the local variable equivalents). A caller with no session must pass both `undefined` values explicitly. Update the `founder-thread-notifier.ts` contract comment too.

- [ ] **Step 7: Fix both issue-display planned-model paths**

In each `issue-display-refresher.ts` phase loop, resolve `ps` before calculating `plannedModel`, then use the same lock for model and label:

```ts
const ps = phaseSessionByRole.get(role); // use byRole in the legacy loop
const override =
  role === "design" && ps?.design_backend
    ? { vendor: ps.design_backend }
    : undefined;
const plannedModel = modelDisplayName(
  resolvePhaseDispatch(role, process.env, override).model,
  DEFAULT_PHASE_TIER[role],
);
const label = phaseMessageTag(
  role,
  ps?.runner_model,
  ps?.design_backend,
).trim();
```

Use `label` in both the pending and active row. If no design session exists, both functions receive undefined and preserve the global fallback. Do not infer from `dispatch_model`.

- [ ] **Step 8: Run GREEN, scan callers and typecheck**

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/fly892-phase-tag.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/DirectEventSink.test.ts src/__tests__/event-route.test.ts src/__tests__/mailbox-lead-runtime.test.ts src/__tests__/commdb-lead-runtime.test.ts src/bridge/__tests__/issue-display-refresher.test.ts
pnpm --filter flywheel-config typecheck
pnpm --filter flywheel-teamlead typecheck
rg -n "phaseMessageTag\\(" packages/teamlead/src --glob '!**/*.test.ts'
```

Expected: event runtimes match; both header paths and phase tags use locked backend; TypeScript proves every production call supplies explicit runner-model and backend arguments. Review the final `rg` output against the enumerated call sites—no session-backed call may pass `undefined` when its session has `design_backend`.

- [ ] **Step 9: Commit the dependency-independent observability unit**

```bash
git add packages/config/src/three-stage-phases.ts packages/config/src/__tests__/fly892-phase-tag.test.ts packages/teamlead/src/bridge/hook-payload.ts packages/teamlead/src/DirectEventSink.ts packages/teamlead/src/bridge/event-route.ts packages/teamlead/src/bridge/mailbox-lead-runtime.ts packages/teamlead/src/bridge/commdb-lead-runtime.ts packages/teamlead/src/bridge/issue-display-refresher.ts packages/teamlead/src/bridge/post-ship-finalization.ts packages/teamlead/src/bridge/plugin.ts packages/teamlead/src/bridge/stuck-escalation.ts packages/teamlead/src/bridge/auto-qa-effects.ts packages/teamlead/src/bridge/gate-poller.ts packages/teamlead/src/bridge/founder-thread-notifier.ts packages/teamlead/src/__tests__/DirectEventSink.test.ts packages/teamlead/src/__tests__/event-route.test.ts packages/teamlead/src/__tests__/mailbox-lead-runtime.test.ts packages/teamlead/src/__tests__/commdb-lead-runtime.test.ts packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts
git commit -m "feat(observability): show locked design backend"
```

## Task 8B — Integrate the lock into FLY-1255's title renderer

**Release blocker:** 本 task 依赖正式 FLY-1255 基线。当前分支中的临时 stack 已被 revert；在依赖文件不存在时不得创建 stub、不得运行会零匹配的 Vitest filter，也不得把 FLY-1259 标为可 release。

**Files:**

- Modify: `packages/teamlead/src/bridge/runner-model-display.ts`
- Test: `packages/teamlead/src/bridge/__tests__/runner-model-display.test.ts`

- [ ] **Step 1: Fail closed if the dependency is absent**

Run both checks before staging or testing:

```bash
test -f packages/teamlead/src/bridge/runner-model-display.ts
test -f packages/teamlead/src/bridge/__tests__/runner-model-display.test.ts
```

Expected: both exit 0. If either fails, Task 8A may remain committed, but stop Task 8B and all title-dependent final acceptance. Pre-FLY-1255 `ChatThreadCreator` still derives the normal started-session marker from the actual `runner_model`, so live titles stay source-honest when that value exists; the locked-backend fallback is absent. Report the dependency block rather than shipping a second renderer.

- [ ] **Step 2: Write failing renderer tests**

Prove actual runner model remains first priority and locked fallback beats the opposite env:

```ts
expect(sessionModelDisplay({
  chat_thread_role: "design",
  design_backend: "claude",
  adapter_type: undefined,
  runner_model: undefined,
  dispatch_model: undefined,
}, { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" })).toEqual(
  renderRunnerModelDisplay({ vendor: "claude", model: "claude-fable-5" }),
);
```

Also set `runner_model: "gpt-5.6-sol"` and verify the actual model wins even if `design_backend` is Claude.

- [ ] **Step 3: Run the focused test and verify RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runner-model-display.test.ts
```

Expected: the locked fallback case follows the opposite env until the renderer accepts `design_backend`.

- [ ] **Step 4: Extend only FLY-1255's renderer**

Add `design_backend` to `DisplaySession`. Replace its phase fallback with:

```ts
if (isThreeStagePhaseRole(session.chat_thread_role)) {
  const override =
    session.chat_thread_role === "design" && session.design_backend
      ? { vendor: session.design_backend }
      : undefined;
  return renderRunnerModelDisplay(
    resolvePhaseDispatch(session.chat_thread_role, env, override),
  );
}
```

Do not change FLY-1255 title markers or add another model→short-code table.

- [ ] **Step 5: Run GREEN and typecheck**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runner-model-display.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: actual model remains first priority; locked fallback beats env; both commands exit 0.

- [ ] **Step 6: Commit the dependency integration**

```bash
git add packages/teamlead/src/bridge/runner-model-display.ts packages/teamlead/src/bridge/__tests__/runner-model-display.test.ts
git commit -m "feat(observability): align design title with locked backend"
```

## Task 9 — Run complete regression and compatibility verification

**Files:** No new production files expected. Fix only failures caused by Tasks 1–8; do not opportunistically refactor unrelated code.

- [ ] **Step 1: Run focused suites together**

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/three-stage-phases.test.ts src/__tests__/feature-flags-drift.test.ts src/__tests__/fly892-phase-tag.test.ts
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/ExecutionEventEmitter.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/three-stage-policy.test.ts src/__tests__/start-e2e.test.ts src/__tests__/lead-rules-bundle.test.ts src/__tests__/StateStore.test.ts src/__tests__/run-dispatcher.test.ts src/__tests__/DirectEventSink.test.ts src/__tests__/event-route.test.ts src/bridge/__tests__/phase-orchestrator.test.ts src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts src/bridge/__tests__/actions-retry-route.test.ts src/__tests__/retry-e2e.test.ts src/__tests__/rescue-runtime.test.ts src/__tests__/mailbox-lead-runtime.test.ts src/__tests__/commdb-lead-runtime.test.ts src/bridge/__tests__/issue-display-refresher.test.ts
```

Expected: all dependency-independent suites pass.

- [ ] **Step 2: Prove the FLY-1255 title suite exists and run it**

```bash
test -f packages/teamlead/src/bridge/runner-model-display.ts
test -f packages/teamlead/src/bridge/__tests__/runner-model-display.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runner-model-display.test.ts
```

Expected: both file checks exit 0 and the named suite runs with a non-zero test count and passes. If the dependency is absent, this is a release block; do not omit the filter and do not reinterpret the core suites as title coverage.

- [ ] **Step 3: Run package typechecks and build**

```bash
pnpm --filter flywheel-config typecheck
pnpm --filter flywheel-edge-worker typecheck
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-config build
pnpm --filter flywheel-edge-worker build
pnpm --filter flywheel-teamlead build
```

Expected: all commands exit 0.

- [ ] **Step 4: Run broader regressions**

```bash
pnpm --filter flywheel-config test
pnpm --filter flywheel-edge-worker test
pnpm --filter flywheel-teamlead test
pnpm lint
git diff --check
```

Expected: all tests/lint pass and no whitespace errors.

- [ ] **Step 5: Verify byte-compatible default response explicitly**

Keep an exact-equality test whose expected success object contains only:

```ts
{
  success: true,
  executionId: expect.any(String),
  issueId: expectedIssueId,
  chatThreadId: expectedThreadId,
  message: `Runner started for ${expectedIssueId}`,
}
```

Verify `Object.keys(body)` contains no `designBackend` when the request omitted/null'ed it.

Add exact non-applicable assertions: `sessionRole:"qa"` returns bounded `non_main_role`; a `no-three-stage`/disabled-policy request returns its bounded code; channel mismatch returns `channel_not_allowed` without exposing any channel/allowlist id; every case leaves `startDispatcher.start` at zero calls.

- [ ] **Step 6: Inspect the final diff for dependency collisions**

```bash
test -f packages/teamlead/src/bridge/runner-model-display.ts
git diff origin/main...HEAD -- packages/teamlead/src/bridge/run-dispatcher.ts packages/teamlead/src/bridge/actions.ts packages/teamlead/src/bridge/runner-model-display.ts
```

Confirm:

- FLY-1257 TURN/startPoint changes are intact;
- FLY-1255 renderer/title markers are intact;
- new code never infers backend from `dispatch_model`;
- every new state writer uses effective `design_backend`.
- every session-backed `phaseMessageTag` call supplies the session's `design_backend`;
- the feature-flag catalog describes the env toggle as a fallback, not the per-run authority.

- [ ] **Step 7: Commit any test-only integration adjustments**

If Task 9 required scoped fixes, commit only those files:

```bash
git add -p
git commit -m "test: cover design backend compatibility"
```

If no files changed, do not create an empty commit.

## Task 10 — Perform two isolated real-runner checks

**Files:** Store evidence in the project-approved QA evidence location chosen by the QA phase; do not add secrets or raw auth tokens to git.

**Dependency gate:** Task 8B must be complete before Task 10 can close. Core API/runner/event evidence may be collected earlier, but title assertions are conditional on the FLY-1255 files being present and are mandatory for final FLY-1259 acceptance.

- [ ] **Step 1: Prepare two disposable eligible issues**

Create two Lead-owned engineering issues with the labels/config needed to enter three-stage mode. Export their actual IDs as `CODEX_OVERRIDE_ISSUE_ID` and `CLAUDE_OVERRIDE_ISSUE_ID`. Confirm neither has an active session.

- [ ] **Step 2: Start an isolated Bridge with global design switch off**

Use an isolated port/state/CommDB and set:

```bash
export TEAMLEAD_PORT=19876
export BRIDGE_URL=http://127.0.0.1:19876
export FLYWHEEL_THREE_STAGE_CODEX_DESIGN=0
```

Start the built Bridge through the repository's sanctioned isolated test launcher. Do not restart the production Bridge.

- [ ] **Step 3: Dispatch the Codex override**

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST "${BRIDGE_URL}/api/runs/start" \
  --data "{\"issueId\":\"${CODEX_OVERRIDE_ISSUE_ID}\",\"leadId\":\"flywheel-eng-lead\",\"designBackend\":\"codex\"}"
```

Capture evidence that:

- receipt contains `designBackend: "codex"`;
- session row has `design_backend=codex`, `adapter_type=codex-tmux`, `runner_model=gpt-5.6-sol`;
- real Codex tmux/cmux process starts with effort `xhigh`;
- Lead notification contains `[DESIGN] session_started` and `Design Backend: codex`;
- after Task 8B, FLY-1255 thread title uses its GPT-5.6 marker; if the renderer dependency is absent, record the block and do not close this task.
- pending header and `[设计·GPT-5.6]` message tag agree with the locked backend even while global is `0`.

- [ ] **Step 4: Restart only the isolated Bridge with global design switch on**

Stop/drain the isolated instance, keep production untouched, then set:

```bash
export FLYWHEEL_THREE_STAGE_CODEX_DESIGN=1
```

Restart the same isolated test launcher.

- [ ] **Step 5: Dispatch the Claude override**

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST "${BRIDGE_URL}/api/runs/start" \
  --data "{\"issueId\":\"${CLAUDE_OVERRIDE_ISSUE_ID}\",\"leadId\":\"flywheel-eng-lead\",\"designBackend\":\"claude\"}"
```

Capture evidence that:

- receipt contains `designBackend: "claude"`;
- session row has `design_backend=claude`, `adapter_type=claude-tmux`, `runner_model=claude-fable-5`;
- a real Claude/Fable process starts;
- Lead notification contains `Design Backend: claude`;
- after Task 8B, FLY-1255 thread title uses its Fable marker; if the renderer dependency is absent, record the block and do not close this task.
- pending header and `[设计·Fable]` message tag agree with the locked backend even while global is `1`.

- [ ] **Step 6: Prove locked inheritance under an env flip**

For one run, change the isolated Bridge env after the initial session, restart/drain safely, then trigger a supported phase retry/rescue on a retryable test state. Confirm the successor session preserves the original `design_backend` and dispatch triple even though the global switch is now opposite. Do not use `terminate` as a generic retry entry; FLY-1257/FSM only permits its supported recovery states.

- [ ] **Step 7: Run an absent-field control**

Dispatch one eligible control issue without `designBackend`. Confirm:

- response has the exact legacy key set;
- design backend follows current global env at this new admission, then remains locked for that run;
- started event still records/displays the effective backend;
- no implement/QA dispatch changes.

- [ ] **Step 8: Attach evidence and request authoritative code review**

Record commands, redacted receipts, session fields, process proof, event text, thread titles and commit SHA. Then follow the Flywheel code-review and QA gates for the Implement/QA phases; the two real runs supplement but do not replace automated tests or cross-family review.

If FLY-1255 never lands, document that normal started-session titles still use the actual `runner_model` through pre-FLY-1255 `ChatThreadCreator`, but the required locked-backend fallback cannot be integrated or verified. In that state FLY-1259 remains dependency-blocked rather than shipping a duplicate renderer.

## Acceptance matrix

| Scenario | Global | Request | Effective design | Response field | Persisted | Retry/rescue |
|---|---:|---|---|---|---|---|
| Legacy default off | `0`/unset | absent | Claude/Fable | absent | `claude` for new run | locked `claude`; legacy null reads env |
| Legacy default on | `1` | absent | Codex | absent | `codex` for new run | locked `codex`; legacy null reads env |
| Override to Codex | `0` | `codex` | Codex GPT-5.6 xhigh | `codex` | `codex` | remains Codex |
| Override to Claude | `1` | `claude` | Claude Fable | `claude` | `claude` | remains Claude |
| Invalid enum/type | either | invalid | no dispatch | 400 error | none | n/a |
| Non-three-stage/non-main role | either | valid override | no dispatch | 400 `DESIGN_BACKEND_NOT_APPLICABLE` + bounded reason code | none | n/a |

For either absent-field row, changing the global flag after admission does not reroute that run. A vendor change requires a new start request with explicit `designBackend`; this is the deliberate consistency tradeoff of dispatch-time locking.

## Rollback boundary

The public parameter, resolver override, state column, inheritance and observability form one capability and should deploy/revert together. The additive nullable DB column is safe to leave during rollback. If application code rolls back, old binaries ignore it and legacy behavior resumes from the global switch; do not delete or rewrite existing values during rollback.
