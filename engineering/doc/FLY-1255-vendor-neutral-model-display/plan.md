# FLY-1255 厂商无关的标题与窗口模型显示 — 实施计划
Issue: FLY-1255 (https://linear.app/geoforge3d/issue/FLY-1255/fix-标题窗口模型名显示解除-anthropic-绑死-厂商无关渲染codexkimi-后端也要显示)
日期: 2026-07-14
基于: research.md

## Goal

把 resolved dispatch `{executor family, model}` 统一渲染到 Discord issue thread
标题与 tmux/cmux window：Codex `gpt-5.6-sol` 显示 `GPT-5.6`，Kimi 显示其
model id，Claude thread 继续 F/O/S/H；pending phase 读 kill-switch-aware plan。

## Architecture

`flywheel-config` 新增纯 `renderRunnerModelDisplay()`，一次产出 thread marker 与
tmux-safe window label。`flywheel-teamlead` 新增 session source resolver，执行
`actual runner_model → phase dispatch plan → persisted dispatch_model` 优先级。所有
thread stamper 改用 resolver，fresh started event 与 window spawn 直接使用已解析的
`runnerBackend + runnerModel`。非 phase window 统一放进固定 `runner-` managed
prefix；cmux pin cleanup 的 shell allowlist/tests 与 producer 同提交更新。Adapters、
StateStore schema、dispatch precedence 不改。

## Tech Stack

TypeScript、Vitest、pnpm monorepo、Discord thread title renderer、tmux window naming。
实施必须按 RED → GREEN → REFACTOR；每个 task 完成后单独 commit。

## Locked Display Contract

1. `RunnerModelDisplay`：
   - Claude known model：`{threadMarker:"F", windowLabel:"claude-Fable"}` 等；
   - Codex `gpt-5.6-sol`：
     `{threadMarker:"Model GPT-5.6", windowLabel:"codex-GPT-5-6"}`；
   - Kimi `kimi-for-coding`：
     `{threadMarker:"Model kimi-for-coding", windowLabel:"kimi-kimi-for-coding"}`。
2. 非 Claude marker 必须带 Lead 批准的人类可读 `Model ` namespace；不得使用裸
   model 方括号或任意方括号通配 parser。批准记录：correction brainstorm gate
   `df42d371-8056-475e-a35a-a0916c4f4c0f`。
3. model 空值返回 `undefined`，不猜 account-default 的具体模型。
4. thread marker payload 最多 24 chars；window label 最多 32 chars；危险字符转
   `-`，连续分隔符合并，结果确定性。
5. thread tri-state 不变：string=set/replace、`null`=clear、absent=preserve。
6. phase fallback 只读 `resolvePhaseDispatch(role, env)`；不可复制默认模型表。
7. window：三段式=`<phase>-<windowLabel>`；非三段式=
   `runner-<windowLabel>`；display 缺失时逐字保持当前
   `design/implement/qa/claude` fallback。`runner` 是 cmux reaper 可证明的固定
   producer prefix，不能改成开放式 vendor allowlist。
8. model-present Claude window 也会从旧 `claude` 变为
   `runner-claude-<tier>`；这是为了显示模型的有意 UX 变化，不宣称 byte-compatible。
   最终 50-char budget 优先保留 issue identifier + model identity，长 issue title
   确定性裁切并测试。

---

### Task 1: Pure vendor-neutral display descriptor

**Files:**

- Create: `packages/config/src/model-display.ts`
- Create: `packages/config/src/__tests__/model-display.test.ts`
- Modify: `packages/config/src/index.ts`

- [ ] **Step 1: Write failing renderer tests**

在 `model-display.test.ts` 写完整表格测试：

```ts
import { describe, expect, it } from "vitest";
import { renderRunnerModelDisplay } from "../model-display.js";

describe("renderRunnerModelDisplay (FLY-1255)", () => {
  it.each([
    ["claude", "claude-fable-5", { threadMarker: "F", windowLabel: "claude-Fable" }],
    ["claude", "claude-opus-4-8[1m]", { threadMarker: "O", windowLabel: "claude-Opus" }],
    ["codex", "gpt-5.6-sol", { threadMarker: "Model GPT-5.6", windowLabel: "codex-GPT-5-6" }],
    ["kimi", "kimi-for-coding", { threadMarker: "Model kimi-for-coding", windowLabel: "kimi-kimi-for-coding" }],
  ])("renders %s/%s", (vendor, model, expected) => {
    expect(renderRunnerModelDisplay({ vendor, model })).toEqual(expected);
  });

  it("does not reinterpret a vendor/model mismatch", () => {
    expect(renderRunnerModelDisplay({ vendor: "codex", model: "claude-fable-5" }))
      .toEqual({
        threadMarker: "Model claude-fable-5",
        windowLabel: "codex-claude-fable-5",
      });
  });

  it("infers a known family only when vendor metadata is absent", () => {
    expect(renderRunnerModelDisplay({ vendor: undefined, model: "gpt-5.6-sol" }))
      .toEqual({
        threadMarker: "Model GPT-5.6",
        windowLabel: "codex-GPT-5-6",
      });
    expect(renderRunnerModelDisplay({ vendor: undefined, model: "future-v9" }))
      .toEqual({
        threadMarker: "Model future-v9",
        windowLabel: "unknown-future-v9",
      });
    expect(renderRunnerModelDisplay({ vendor: undefined, model: "opus" }))
      .toEqual({
        threadMarker: "O",
        windowLabel: "claude-Opus",
      });
  });

  it("bounds and sanitizes opaque model ids", () => {
    expect(renderRunnerModelDisplay({ vendor: "kimi", model: " bad] model🔥 " }))
      .toEqual({ threadMarker: "Model bad-model", windowLabel: "kimi-bad-model" });
    const long = renderRunnerModelDisplay({ vendor: "future", model: "x".repeat(80) });
    expect(long?.threadMarker).toBe(`Model ${"x".repeat(24)}`);
    expect(long?.windowLabel.length).toBeLessThanOrEqual(32);
  });

  it.each([null, undefined, "", "   "])("does not guess an absent model: %s", (model) => {
    expect(renderRunnerModelDisplay({ vendor: "codex", model })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run RED test**

Run:

```bash
pnpm --filter flywheel-config test -- model-display
```

Expected: FAIL because `../model-display.js` does not exist/export the function.

- [ ] **Step 3: Implement the pure renderer**

在 `model-display.ts` 实现，不依赖 `flywheel-core`（避免 package cycle）：

```ts
import { modelDisplayName, modelShortCode } from "./model-tiers.js";

const MODEL_PAYLOAD_MAX = 24;
const WINDOW_LABEL_MAX = 32;

export interface RunnerModelDisplayInput {
  vendor: string | null | undefined;
  model: string | null | undefined;
}

export interface RunnerModelDisplay {
  threadMarker: string;
  windowLabel: string;
}

function safeToken(raw: string, max: number): string {
  return raw.trim()
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._+]+|[-._+]+$/g, "")
    .slice(0, max);
}

function windowSafe(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WINDOW_LABEL_MAX);
}

export function renderRunnerModelDisplay(
  input: RunnerModelDisplayInput,
): RunnerModelDisplay | undefined {
  const model = input.model?.trim();
  if (!model) return undefined;

  const lowerModel = model.toLowerCase();
  const explicitFamily = safeToken(input.vendor ?? "", 12).toLowerCase();
  const claudeCodeCandidate = modelShortCode(model);
  const inferredFamily = claudeCodeCandidate
    ? "claude"
    : lowerModel.startsWith("gpt-")
        ? "codex"
        : lowerModel.startsWith("kimi-")
          ? "kimi"
          : "unknown";
  const family = explicitFamily || inferredFamily;
  const claudeCode = family === "claude" ? claudeCodeCandidate : undefined;
  const familyDisplay =
    family === "claude" && claudeCode
      ? modelDisplayName(model)
      : family === "codex" && lowerModel.startsWith("gpt-")
        ? modelDisplayName(model)
        : undefined;
  const payload = safeToken(familyDisplay ?? model, MODEL_PAYLOAD_MAX);
  if (!payload) return undefined;

  return {
    threadMarker: claudeCode ?? `Model ${payload}`,
    windowLabel: windowSafe(`${family}-${payload}`),
  };
}
```

在 `packages/config/src/index.ts` 导出 types/function。

- [ ] **Step 4: Run GREEN + typecheck**

```bash
pnpm --filter flywheel-config test -- model-display
pnpm --filter flywheel-config typecheck
```

Expected: renderer tests PASS；typecheck exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/model-display.ts packages/config/src/__tests__/model-display.test.ts packages/config/src/index.ts
git commit -m "feat(FLY-1255): add vendor-neutral model display descriptor"
```

---

### Task 2: Resolve actual vs planned session display

**Files:**

- Create: `packages/teamlead/src/bridge/runner-model-display.ts`
- Create: `packages/teamlead/src/bridge/__tests__/runner-model-display.test.ts`

- [ ] **Step 1: Write failing precedence tests**

```ts
import { describe, expect, it } from "vitest";
import { sessionModelDisplay } from "../runner-model-display.js";

describe("sessionModelDisplay (FLY-1255)", () => {
  it("actual resolved runner_model wins over dispatch_model", () => {
    expect(sessionModelDisplay({
      adapter_type: "codex-tmux",
      runner_model: "gpt-5.6-sol",
      dispatch_model: "claude-fable-5",
      chat_thread_role: "implement",
    })).toEqual({
      threadMarker: "Model GPT-5.6",
      windowLabel: "codex-GPT-5-6",
    });
  });

  it("pending implement falls back to the phase dispatch plan", () => {
    expect(sessionModelDisplay({ chat_thread_role: "implement" }, {}))
      .toMatchObject({ threadMarker: "Model GPT-5.6" });
  });

  it("phase fallback follows both kill switches", () => {
    expect(sessionModelDisplay(
      { chat_thread_role: "implement" },
      { FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "0" },
    )).toEqual({ threadMarker: "F", windowLabel: "claude-Fable" });
    expect(sessionModelDisplay(
      { chat_thread_role: "design" },
      { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
    )).toEqual({
      threadMarker: "Model GPT-5.6",
      windowLabel: "codex-GPT-5-6",
    });
  });

  it("non-phase may fall back to persisted dispatch_model", () => {
    expect(sessionModelDisplay({
      adapter_type: "claude-tmux",
      dispatch_model: "claude-fable-5",
      chat_thread_role: "main",
    })).toEqual({ threadMarker: "F", windowLabel: "claude-Fable" });
  });

  it("does not lie that a GPT row with missing adapter metadata is Claude", () => {
    expect(sessionModelDisplay({
      adapter_type: undefined,
      runner_model: "gpt-5.6-sol",
      chat_thread_role: "main",
    })).toEqual({
      threadMarker: "Model GPT-5.6",
      windowLabel: "codex-GPT-5-6",
    });
  });

  it("returns undefined without actual, phase plan, or dispatch model", () => {
    expect(sessionModelDisplay({ chat_thread_role: "main" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run RED test**

```bash
pnpm --filter flywheel-teamlead test -- runner-model-display
```

Expected: FAIL on missing module/function.

- [ ] **Step 3: Implement the session resolver**

```ts
import {
  adapterTypeToFamily,
  isThreeStagePhaseRole,
  renderRunnerModelDisplay,
  resolvePhaseDispatch,
  type RunnerModelDisplay,
} from "flywheel-config";
import type { Session } from "../StateStore.js";

type DisplaySession = Pick<
  Session,
  "adapter_type" | "runner_model" | "dispatch_model" | "chat_thread_role"
>;

export function sessionModelDisplay(
  session: DisplaySession,
  env: Record<string, string | undefined> = process.env,
): RunnerModelDisplay | undefined {
  if (session.runner_model) {
    return renderRunnerModelDisplay({
      vendor: session.adapter_type
        ? adapterTypeToFamily(session.adapter_type)
        : undefined,
      model: session.runner_model,
    });
  }
  if (isThreeStagePhaseRole(session.chat_thread_role)) {
    return renderRunnerModelDisplay(resolvePhaseDispatch(session.chat_thread_role, env));
  }
  if (session.dispatch_model) {
    return renderRunnerModelDisplay({
      vendor: session.adapter_type
        ? adapterTypeToFamily(session.adapter_type)
        : undefined,
      model: session.dispatch_model,
    });
  }
  return undefined;
}
```

- [ ] **Step 4: Run GREEN + typecheck**

```bash
pnpm --filter flywheel-teamlead test -- runner-model-display
pnpm --filter flywheel-teamlead typecheck
```

Expected: tests PASS；typecheck exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/teamlead/src/bridge/runner-model-display.ts packages/teamlead/src/bridge/__tests__/runner-model-display.test.ts
git commit -m "feat(FLY-1255): resolve actual and planned model display"
```

---

### Task 3: Generalize the thread marker without losing safety

**Files:**

- Modify: `packages/teamlead/src/bridge/stage-utils.ts`
- Modify: `packages/teamlead/src/__tests__/stage-status-emoji.test.ts`
- Modify: `packages/teamlead/src/bridge/ChatThreadCreator.ts`
- Modify: `packages/teamlead/src/__tests__/ChatThreadCreator.test.ts`

- [ ] **Step 1: Add RED marker grammar tests**

在现有 FLY-755 block 增加：

```ts
expect(applyModelMarker("[FLY-1255] Title", "Model GPT-5.6"))
  .toBe("[Model GPT-5.6] [FLY-1255] Title");
expect(modelMarkerLabel("[Model kimi-for-coding] [FLY-1255] Title"))
  .toBe("Model kimi-for-coding");
expect(stripModelMarker("[Model GPT-5.6] [FLY-1255] Title"))
  .toBe("[FLY-1255] Title");
expect(applyModelMarker(
  "[Model GPT-5.6] [FLY-1255] Title",
  "Model kimi-for-coding",
)).toBe("[Model kimi-for-coding] [FLY-1255] Title");

// Parser must not claim arbitrary human prefixes or injected values.
expect(modelMarkerLabel("[infra] [FLY-1255] Title")).toBeUndefined();
expect(stripModelMarker("[infra] [FLY-1255] Title"))
  .toBe("[infra] [FLY-1255] Title");
expect(applyModelMarker("[FLY-1255] Title", "Model bad]value"))
  .toBe("[FLY-1255] Title");
```

在 `ChatThreadCreator.test.ts` 增加 create/set/replace/null/absent/long-title 用例，
expected title 使用 `[Model GPT-5.6]`。原 F/O/S/H 与 legacy ` ·F` tests 保留。

- [ ] **Step 2: Run RED tests**

```bash
pnpm --filter flywheel-teamlead test -- stage-status-emoji ChatThreadCreator
```

Expected: FAIL because current types/regex only accept F/O/S/H and
`modelMarkerLabel` does not exist.

- [ ] **Step 3: Implement a human-readable namespaced marker grammar**

在 `stage-utils.ts` 用固定 grammar 替换 F/O/S/H-only front regex；legacy tail 保留：

```ts
const MODEL_MARKER_VALUE_RE = /^(?:[FOSH]|Model [A-Za-z0-9][A-Za-z0-9._+-]{0,23})$/;
const MODEL_MARKER_RE =
  /^\[((?:[FOSH]|Model [A-Za-z0-9][A-Za-z0-9._+-]{0,23}))\] (?=\[[A-Z][A-Z0-9]*-\d+\](?:\s|$))/;

export function modelMarkerLabel(base: string): string | undefined {
  const front = base.match(MODEL_MARKER_RE);
  if (front) return front[1];
  const tail = base.match(LEGACY_MODEL_SUFFIX_RE);
  return tail ? tail[1] : undefined;
}

export function applyModelMarker(base: string, marker: string | undefined): string {
  const bare = stripModelMarker(base);
  return marker && MODEL_MARKER_VALUE_RE.test(marker) && hasIssueKeyHead(bare)
    ? `[${marker}] ${bare}`
    : bare;
}
```

删除/替换生产和测试中的 `modelMarkerCode` 名称；`stripModelMarker` 同时识别新 front
marker 与 legacy tail。

在 `ChatThreadCreator.ts`：

- `modelCode?: "F"|...|null` → `modelMarker?: string | null`；
- `composeThreadTitle(prefix, base, modelMarker)` 必须调用 `applyModelMarker()`，不手写
  第二份 marker validation；
- preserve path 使用 `modelMarkerLabel(rawBase)`；null 变 `undefined` 后 clear；
- 100-char budget 对 `prefix + markedBase` 一次计算；
- backfill placeholder 先 `stripModelMarker()`，再按同一 tri-state 选择 marker。

- [ ] **Step 4: Run GREEN tests**

```bash
pnpm --filter flywheel-teamlead test -- stage-status-emoji ChatThreadCreator
```

Expected: all old FLY-755 tests + new human-readable namespace tests PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/teamlead/src/bridge/stage-utils.ts packages/teamlead/src/bridge/ChatThreadCreator.ts packages/teamlead/src/__tests__/stage-status-emoji.test.ts packages/teamlead/src/__tests__/ChatThreadCreator.test.ts
git commit -m "feat(FLY-1255): generalize thread model markers"
```

---

### Task 4: Wire every managed thread-title writer

**Files:**

- Modify: `packages/teamlead/src/DirectEventSink.ts`
- Modify: `packages/teamlead/src/bridge/issue-display-refresher.ts`
- Modify: `packages/teamlead/src/HeartbeatService.ts`
- Modify: `packages/teamlead/src/bridge/auto-qa-effects.ts`
- Modify tests under:
  - `packages/teamlead/src/__tests__/DirectEventSink.test.ts`
  - `packages/teamlead/src/__tests__/event-route.stage-emoji.test.ts`
  - `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts`
  - `packages/teamlead/src/__tests__/HeartbeatService.monitor-loss.test.ts`
  - `packages/teamlead/src/bridge/__tests__/auto-qa-effects.test.ts`

- [ ] **Step 1: Add RED surface regressions**

至少覆盖：

1. DirectEventSink fresh start：`runnerBackend:"codex-tmux"` +
   `runnerModel:"gpt-5.6-sol"` 调 `ensureChatThread` 时携带
   `modelMarker:"Model GPT-5.6"`；
   同时覆盖 `runnerBackend` 缺失但 `runnerModel:"gpt-5.6-sol"` 的防御路径，仍显示
   `Model GPT-5.6`，不能降成 Claude/raw id；
2. issue display refresh：actual Codex row 得到 `[Model GPT-5.6]`；pending implement row
   无 `runner_model` 仍得到 planned `[Model GPT-5.6]`；kill-switch=0 得 `[F]`；
3. reconnect：Codex session 重盖标题不清空 marker；Bridge re-adopt 成功并发出
   `session_monitoring_reestablished` 时，立即清除旧 `⚠️重连中` 前缀并恢复实际 phase/status；
4. auto-QA：Claude session 仍 `[O/F]`，无 byte regression；
5. legacy stage_changed path 与 aggregate refresher 输出相同。

- [ ] **Step 2: Run RED surface tests**

```bash
pnpm --filter flywheel-teamlead test -- DirectEventSink event-route.stage-emoji issue-display-refresher auto-qa-effects HeartbeatService
```

Expected: new Codex expectations FAIL；current callers pass `modelCode:null` or omit the
new property.

- [ ] **Step 3: Replace Claude-only projections**

Fresh event path：

```ts
const display = renderRunnerModelDisplay({
  vendor: env.runnerBackend
    ? adapterTypeToFamily(env.runnerBackend)
    : undefined,
  model: env.runnerModel,
});
// ChatThreadContext
modelMarker: display?.threadMarker ?? null,
```

Session paths统一：

```ts
modelMarker: sessionModelDisplay(session)?.threadMarker ?? null,
```

在 `issue-display-refresher.ts` 的 legacy stamp 与 aggregate Face A 两处都替换；
Heartbeat/auto-QA 同理。不要改 `phaseMessageTag()`、phase header 或
`modelDisplayName()`。

- [ ] **Step 4: Run GREEN + callsite audit**

```bash
pnpm --filter flywheel-teamlead test -- DirectEventSink event-route.stage-emoji issue-display-refresher auto-qa-effects HeartbeatService
rg -n "modelShortCode\(" packages/teamlead/src --glob '!**/dist/**'
rg -n "modelCode" packages/teamlead/src --glob '!**/dist/**'
```

Expected: tests PASS；两个 `rg` 不再命中生产 title writer（若只命中历史注释/fixture，
同步改成新术语；不得留下 executable caller）。

- [ ] **Step 5: Commit**

```bash
git add packages/teamlead/src/DirectEventSink.ts packages/teamlead/src/HeartbeatService.ts packages/teamlead/src/bridge/issue-display-refresher.ts packages/teamlead/src/bridge/auto-qa-effects.ts packages/teamlead/src/__tests__/DirectEventSink.test.ts packages/teamlead/src/__tests__/event-route.stage-emoji.test.ts packages/teamlead/src/__tests__/HeartbeatService.monitor-loss.test.ts packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts packages/teamlead/src/bridge/__tests__/auto-qa-effects.test.ts
git commit -m "fix(FLY-1255): render all thread titles from resolved dispatch"
```

---

### Task 5: Put the same vendor/model identity in fresh and retry windows

**Files:**

- Modify: `packages/teamlead/src/bridge/run-dispatcher.ts`
- Modify: `packages/teamlead/src/bridge/close-runner.ts`（contract comment）
- Modify: `packages/teamlead/src/__tests__/run-dispatcher.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/run-dispatcher-backend.test.ts`
- Modify: `packages/core/test/tmux-naming.test.ts`
- Modify: `scripts/flywheel-cmux-sync.sh`
- Modify: `scripts/test-cmux-sync.sh`

- [ ] **Step 1: Write RED window-name tests**

扩展 `runnerDisplayName` tests：

```ts
expect(runnerDisplayName("implement", true, {
  threadMarker: "Model GPT-5.6",
  windowLabel: "codex-GPT-5-6",
})).toBe("implement-codex-GPT-5-6");

expect(runnerDisplayName("main", false, {
  threadMarker: "Model kimi-for-coding",
  windowLabel: "kimi-kimi-for-coding",
})).toBe("runner-kimi-kimi-for-coding");

expect(runnerDisplayName("qa", true, {
  threadMarker: "O",
  windowLabel: "claude-Opus",
})).toBe("qa-claude-Opus");

expect(runnerDisplayName("main", false, {
  threadMarker: "F",
  windowLabel: "claude-Fable",
})).toBe("runner-claude-Fable");

expect(runnerDisplayName("implement", true, undefined)).toBe("implement");
expect(runnerDisplayName("main", false, undefined)).toBe("claude");
```

在 `packages/teamlead/src/bridge/__tests__/run-dispatcher-backend.test.ts` 的 real
`RunDispatcher.start()` capture test 增加：

- project Codex `gpt-5.6-sol` → `ctx.runnerName === "runner-codex-GPT-5-6"`；
- project Kimi `kimi-for-coding` →
  `ctx.runnerName === "runner-kimi-kimi-for-coding"`；
- defensive helper case `runnerBackend:undefined` + `runnerModel:"gpt-5.6-sol"` →
  `runner-codex-GPT-5-6`（不得显示 `runner-claude-*` / raw id）；
- phase implement plan → `implement-codex-GPT-5-6`；
- 在 `packages/teamlead/src/__tests__/run-dispatcher.test.ts` 的现有
  `describe("RetryDispatcher")` harness 捕获 `blueprint.run(..., ctx)`，断言同一
  phase/model retry 仍为 `implement-codex-GPT-5-6`。

在 `packages/core/test/tmux-naming.test.ts` 加完整链断言：

```ts
const label = sanitizeTmuxName(buildWindowLabel(
  "FLY-1255",
  "implement-codex-GPT-5-6",
  "Fix a deliberately long founder-visible issue title",
));
expect(label).toHaveLength(50);
expect(label).toMatch(/^FLY-1255-implement-codex-GPT-5-6-/);
expect(label).toBe("FLY-1255-implement-codex-GPT-5-6-Fix-a-deliberatel");

const kimi = sanitizeTmuxName(buildWindowLabel(
  "LEARN-143",
  "runner-kimi-kimi-for-coding",
  "Fix a deliberately long founder-visible issue title",
));
expect(kimi).toBe(
  "LEARN-143-runner-kimi-kimi-for-coding-Fix-a-delibe",
);

const maxLabel = sanitizeTmuxName(buildWindowLabel(
  "LEARN-143",
  `runner-vendor-${"x".repeat(25)}`, // runner- + 32-char windowLabel
  "Fix a deliberately long founder-visible issue title",
));
expect(maxLabel).toBe(
  "LEARN-143-runner-vendor-xxxxxxxxxxxxxxxxxxxxxxxxx-",
);
```

最后一条锁住现有 sanitizer 的最坏边界：identifier + 完整 capped model segment
占满 50 chars 时 trailing issue title 会完全消失，并可能留下 slice 产生的末尾 `-`。
本票不顺带重写 shared sanitizer；这是明确 tradeoff，不得再描述成“只缩短 title”。

并在 `scripts/test-cmux-sync.sh` 先写 RED shell regressions：

- `FLY-1255-runner-codex-GPT-5-6-title` 与
  `FLY-9-runner-kimi-kimi-for-coding-title` 必须 managed；
- 直接 `FLY-1-codex-*` / `FLY-1-kimi-*`、`runnerX-*` 继续 non-managed；
- orphan fixture 含一个 `runner-codex-*` pin，`orphan_pin_refs` 与最终 revalidation
  都能识别/清理；
- Lead/user tabs 仍全部拒绝。

- [ ] **Step 2: Run RED window tests**

```bash
pnpm --filter flywheel-teamlead test -- run-dispatcher run-dispatcher-backend
```

Expected: FAIL because current `runnerDisplayName` ignores backend/model and returns
`implement` or fixed `claude`.

- [ ] **Step 3: Implement one window composition path**

```ts
export function runnerDisplayName(
  sessionRole: string | undefined,
  shareParentBranch: boolean | undefined,
  modelDisplay?: RunnerModelDisplay,
): string {
  const phase = shareParentBranch && isThreeStagePhaseRole(sessionRole)
    ? sessionRole
    : undefined;
  if (modelDisplay) {
    return phase
      ? `${phase}-${modelDisplay.windowLabel}`
      : `runner-${modelDisplay.windowLabel}`;
  }
  return phase ?? "claude";
}
```

fresh 与 retry 两个 `runnerSpawn` context construction 都先做：

```ts
const modelDisplay = renderRunnerModelDisplay({
  vendor: runnerSpawn.runnerBackend
    ? adapterTypeToFamily(runnerSpawn.runnerBackend)
    : undefined,
  model: runnerSpawn.runnerModel,
});
```

然后把同一 `modelDisplay` 传给 `runnerDisplayName()`。不得在 Codex/Kimi adapter 内
rename；`Blueprint → buildWindowLabel → sanitizeTmuxName` 保持原链。

同步扩展 cmux cleanup 的窄 gate（只新增固定 `runner`，不放宽任意 vendor）：

```bash
is_managed_runner_title() {
  local re='^[A-Z][A-Z0-9]*-[0-9]+-(claude|runner|design|implement|qa)(-|$)'
  [[ "$1" =~ $re ]]
}
```

更新同一函数上方 producer-contract 注释与 `close-runner.ts` 的 reaper backstop
注释：non-phase model-present 由 `runner-<family>-<model>` 产出；model-absent 仍
`claude`；三段式仍由 phase prefix 保护。Shell reverse sentinels 必须保留 direct
vendor title 为 non-managed。

- [ ] **Step 4: Run GREEN + full window chain test**

```bash
pnpm --filter flywheel-teamlead test -- run-dispatcher run-dispatcher-backend
pnpm --filter flywheel-edge-worker test -- Blueprint
pnpm --filter flywheel-core test -- tmux-naming
bash scripts/test-cmux-sync.sh
```

Expected: dispatcher tests PASS；Blueprint 仍把 `ctx.runnerName` 原样放进
`buildWindowLabel`；50-char tests 覆盖 phase GPT、最长现实 Kimi 与 32-char cap，保留
identifier/model identity，并明确最坏边界可吃掉全部 trailing title；shell gate/reaper
对 `runner-*` 正常，对 direct vendor/user tab fail-close。

- [ ] **Step 5: Commit**

```bash
git add packages/teamlead/src/bridge/run-dispatcher.ts packages/teamlead/src/bridge/close-runner.ts packages/teamlead/src/__tests__/run-dispatcher.test.ts packages/teamlead/src/bridge/__tests__/run-dispatcher-backend.test.ts packages/core/test/tmux-naming.test.ts scripts/flywheel-cmux-sync.sh scripts/test-cmux-sync.sh
git commit -m "fix(FLY-1255): show resolved model in runner windows"
```

注意：最后一条 `git add` 只添加本 Task 实际修改的 retry test；先用 `git status
--short` 核对，不能把无关 user changes 纳入 commit。

---

### Task 6: Refactor, verify, and prepare independent QA

**Files:**

- Modify only if verification exposes an uncovered caller/type error.
- Keep `engineering/doc/FLY-1255-vendor-neutral-model-display/progress.md` current via
  the mandated `flywheel-comm progress` command; do not hand-edit it.

- [ ] **Step 1: Contract and placeholder audit**

```bash
rg -n "modelCode|modelMarkerCode|modelShortCode\(" packages/teamlead/src --glob '!**/dist/**'
rg -n "gpt-5\.6-sol|kimi-for-coding|Model GPT-5\.6" packages/config/src packages/teamlead/src --glob '!**/dist/**'
git diff --check
```

Expected: no old executable title API; new Codex/Kimi assertions exist; diff check clean。

- [ ] **Step 2: Run package tests and typechecks**

```bash
pnpm --filter flywheel-config test
pnpm --filter flywheel-teamlead test
pnpm --filter flywheel-edge-worker test
pnpm --filter flywheel-core test
pnpm --filter flywheel-config typecheck
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-edge-worker typecheck
pnpm --filter flywheel-core typecheck
```

Expected: all commands exit 0。

- [ ] **Step 3: Run repository gates**

```bash
bash scripts/test-cmux-sync.sh
pnpm lint
pnpm build
```

Expected: shell cleanup contract PASS；lint/build exit 0 with no formatter/type/build error。

- [ ] **Step 4: Verify behavior against every requirement**

Evidence matrix to attach to PR/review:

| Requirement | Evidence |
|---|---|
| Existing Codex thread converges to GPT-5.6 | aggregate refresher rename test is primary proof；renderer/DirectEventSink separately cover descriptor + fresh-create only |
| Codex window identifies vendor/model | fresh + phase + retry tests assert `runner-codex-GPT-5-6` / `implement-codex-GPT-5-6`；50-char test preserves identity |
| Kimi not lost behind Claude logic | Kimi renderer + dispatcher test asserts `runner-kimi-kimi-for-coding` |
| pending phase truth | resolver tests default and both kill-switch branches |
| Missing backend metadata is honest | session、fresh event、window 三个 renderer call site 都把 absent backend 传为 undefined；Claude bare aliases 复用 `modelShortCode()` 推导，GPT 推导 Codex，unknown model 用 neutral `unknown`，never false `claude-*` |
| Claude compatibility boundary | F/O/S/H marker suite unchanged；model-absent window unchanged；model-present window intentionally adds tier |
| no runtime sniff/schema | diff contains no adapter CLI parsing or StateStore migration |
| marker safety | namespace/injection/curated-title/clear/preserve tests |
| cmux cleanup remains safe | shell gate accepts only fixed `runner`/phase/claude prefixes；direct vendor/user sentinels rejected；orphan close regression passes |

- [ ] **Step 5: Commit any bounded refactor fixes**

Only if Step 1–4 required code changes, stage the exact scoped files from Tasks 1–5 that
`git status --short` reports as modified, then commit:

```bash
git commit -m "test(FLY-1255): close model display regressions"
```

Do not use `git add -A`; if verification required no edit, skip this commit.

- [ ] **Step 6: Independent QA handoff requirements**

After code review/PR (Implement phase owns this), QA must verify the reviewed commit:

1. dispatch a real Codex phase with `gpt-5.6-sol`；
2. capture the live issue thread title containing `[Model GPT-5.6]`；
3. read that run's real tmux target from its persisted session row, assign it to
   `TARGET`, then run `tmux display-message -p -t "$TARGET" '#{window_name}'` and prove
   it contains `codex-GPT-5-6`；
4. if Kimi auth is available, dispatch `kimi-for-coding` and prove both thread/window；
   otherwise record the Kimi integration-test evidence explicitly, not as a claimed real E2E；
5. verify a Claude run still shows F/O/S/H and no duplicate marker after a stage refresh。

## Definition of Done

- Shared renderer and source resolver are the only new model-display decision points；
- all production thread-title callers are migrated；
- fresh + retry window names use the same resolved descriptor；
- cmux managed-title gate, orphan reaper tests, and producer are updated in lockstep；
- 50-char truncation keeps issue identifier + model identity；phase GPT、realistic Kimi
  与 32-char cap 均有 exact assertion；cap 边界允许 trailing title 归零并明确记录；
- Codex GPT-5.6 and Kimi regressions are explicit；
- all tests/typechecks/lint/build pass；
- cross-family code review and independent QA approve the frozen head；
- no implementation escapes this ticket's display-only scope。
