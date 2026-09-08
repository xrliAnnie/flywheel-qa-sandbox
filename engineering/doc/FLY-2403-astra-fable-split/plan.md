# FLY-2403 Astra / Fable 设计分臂 — 实施计划
Issue: FLY-2403 (https://linear.app/geoforge3d/issue/FLY-2403/模型ab-设计段-astra-fable-对半分流-对比台账注册-gpt-6-astra)
日期: 2026-09-06
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:test-driven-development` and execute inline in this bounded DAG implementation node. Do not dispatch successor/review workflow nodes.

**Goal:** 注册 Astra 为设计/实现节点可选 Codex 模型，让 Flywheel Lead 对同一 Epic 的 `code` 设计节点按奇 Astra、偶 Fable 显式分臂，并交付从已有 receipt 计算四项指标与逐项 N 的只读 SQL。

**Architecture:** 内建 registry 提供稳定 alias→canonical 映射，graph-local YAML 决定节点 allowlist，Lead prompt 决定本次 design override；统计层只读已有 StateStore 表，不持久化 experiment arm。

**Tech Stack:** TypeScript, Vitest, YAML registry, SQLite JSON1, Bash acceptance harness, Markdown Lead rules.

---

## 文件结构

- 修改 `packages/config/src/model-builtins.ts` 与 `packages/config/src/__tests__/model-registry.test.ts`：新增并验证 Astra 身份。
- 修改 `.flywheel/agents/registry.yaml`、`packages/teamlead/src/workflow-menu.ts` 及菜单/API tests：开放节点 policy、更新现有合法集合断言并保留精确错误码。
- 修改 `.lead/flywheel-eng-lead/identity.md`，新建 prompt contract test：锁定 Lead 手工奇偶分臂。
- 新建 `scripts/fly2403-design-model-comparison.sql` 与 shell test，并在 `.github/workflows/ci.yml` literal 枚举：跨两条 review lane 输出四指标、两臂逐项 N 与排除计数。
- 最后更新本文件夹 docs/progress，并以 `engineering/doc/milestones/FLY-2403.md` 作为 literal last commit。

### Task 1: 注册 Astra，同时冻结 `codex` alias 语义

- [ ] **Step 1: 写 registry RED test**

在 `model-registry.test.ts` 新增：

```ts
it("registers Astra separately without rebinding codex", () => {
  expect(getModelRegistryEntry("codex")?.id).toBe("gpt-5.6-sol");
  expect(getModelRegistryEntry("astra")).toMatchObject({
    id: "gpt-6-astra",
    provider: "openai",
    runtimeVendor: "codex",
    aliases: ["astra"],
    surfaces: ["runner", "workflow"],
    effortsBySurface: {
      runner: ["xhigh"],
      workflow: ["low", "medium", "high", "xhigh", "max"],
    },
  });
  expect(isModelSelectable({ surface: "lead", model: "astra" })).toBe(false);
  expect(isModelSelectable({ surface: "cron", model: "astra" })).toBe(false);
});
```

- [ ] **Step 2: 验证 RED**

Run `pnpm --filter flywheel-config exec vitest run src/__tests__/model-registry.test.ts`.

Expected: FAIL because `getModelRegistryEntry("astra")` is null.

- [ ] **Step 3: 最小 GREEN 实现**

在 `MODEL_IDS` / `MODEL_ALIASES` 增加 `CODEX_ASTRA: "gpt-6-astra"` 与 `ASTRA: "astra"`，并在 Sol entry 旁加入：

```ts
{
  id: MODEL_IDS.CODEX_ASTRA,
  provider: "openai",
  runtimeVendor: "codex",
  label: "GPT-6 Astra",
  aliases: [MODEL_ALIASES.ASTRA],
  surfaces: ["runner", "workflow"],
  effortsBySurface: { runner: ["xhigh"], workflow: ROLE_EFFORT_LEVELS },
},
```

- [ ] **Step 4: 验证 GREEN 并提交**

复跑 focused test；提交 `model-builtins.ts` 与 test，commit message `feat(config): register Astra workflow model`。

### Task 2: 开通 graph-local policy 与 HTTP override

- [ ] **Step 1: 写 menu/API RED tests**

`workflow-menu.test.ts` 先要求：

```ts
const resolved = resolveMenuOverrides(code(), {
  eng_design: { model: "astra" },
});
expect(resolved.templateOverride.nodes?.eng_design).toEqual({
  vendor: "codex",
  model: "gpt-6-astra",
  effort: "xhigh",
});
expect(resolved.receipts.eng_design.model).toBe("astra (= gpt-6-astra)");
```

另断言 `code.implement` 与 `simple_code.implement` 都列出 `astra`，而 `simple_code` 没有 `eng_design`。同步更新 `workflow-menu.test.ts`、`runs-route.dag-entry.test.ts` 已有的 `['fable','codex']` legal-set 断言。在 `runs-route.dag-entry.test.ts` 添加 `eng_design:astra` POST 200/canonical dispatch/`resolved.nodeModels.eng_design` receipt，以及 `eng_design:atsra` POST 400/`INVALID_MODEL`。

- [ ] **Step 2: 验证 RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/workflow-menu.test.ts \
  src/bridge/__tests__/runs-route.dag-entry.test.ts
```

Expected: Astra policy missing；错拼目前返回 `MODEL_NOT_ALLOWED_FOR_NODE`。

- [ ] **Step 3: 最小 GREEN 实现**

在 `code.eng_design`、`code.implement`、`simple_code.implement` 三处加入相同 policy：

```yaml
- model: astra
  allowedEfforts: [low, medium, high, xhigh, max]
  defaultEffort: xhigh
```

保持 design/implement defaults 与所有 QA block 字节语义不变。在 `resolveMenuOverrides` 找不到 node policy 前先执行：

```ts
if (!getModelRegistryEntry(requestedModel)) {
  throw new WorkflowMenuValidationError(
    "INVALID_MODEL",
    `model ${requestedModel} is not registered`,
    node.models!.map((model) => model.model),
  );
}
```

已注册但节点未允许仍为 `MODEL_NOT_ALLOWED_FOR_NODE`。

- [ ] **Step 4: 验证 GREEN 并提交**

复跑 Step 2，再跑 `workflow-menu-policy.test.ts`、`workflow-menu-routes.test.ts` 和 `pnpm verify:workflow-seeds`；确认现有 `SAME_VENDOR_REVIEW_COMBINATION` 仍绿。提交 registry YAML、实现与 tests，commit message `feat(teamlead): allow Astra workflow overrides`。

### Task 3: 固化 Lead 侧奇偶分臂规则

- [ ] **Step 1: 写 prompt-contract RED test**

新建 `packages/teamlead/src/__tests__/fly2403-astra-fable-split.test.ts`，读取 identity；以 A/B 规则 heading 为锚点截取该 section，再断言精确 literal JSON 和关键 fail-loud 合同：

```ts
expect(section).toContain('{"overrides":{"eng_design":{"model":"astra"}}}');
expect(section).toContain('{"overrides":{"eng_design":{"model":"fable"}}}');
expect(section).toContain('astra (= gpt-6-astra)');
expect(section).toContain('overridden: true');
expect(section).toMatch(/同一 Epic.*Linear/);
expect(section).toMatch(/首个.*code.*workflow run.*runtime receipt/);
expect(section).toMatch(/simple_code.*不计入/);
expect(section).toMatch(/不依赖对话记忆/);
expect(section).toMatch(/不随机/);
expect(section).toMatch(/不.*自动分配器/);
```

- [ ] **Step 2: 验证 RED**

Run `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly2403-astra-fable-split.test.ts`.

Expected: FAIL because the A/B paragraph does not exist.

- [ ] **Step 3: 最小 GREEN 实现**

在 literal call 后增加项目级规则；每次新 issue 派单前从 Linear 列出同一 Epic children，以已有首个 `code` workflow run 的 `workflow_execution_runtime(node_id='eng_design')` receipt 重建已派数量，ordinal=`count+1`。奇数传 `{"overrides":{"eng_design":{"model":"astra"}}}`，偶数传 `fable`；`simple_code` 不计入，不依赖对话记忆，不随机，不做自动分配器，run 重试沿用 pinned snapshot。只改变 `eng_design`，不交替 implement/QA。

收到 `200` 后必须校验 `resolved.nodeModels.eng_design.model` 与预期 alias/canonical 完全一致且 `overridden: true`；缺失/不符 fail loud 且不计作已派臂。

- [ ] **Step 4: 验证 GREEN 并提交**

复跑 focused test；提交 identity 与 test，commit message `docs(lead): alternate Astra and Fable design arms`。

### Task 4: 交付四项逐臂 N 的只读 SQL

- [ ] **Step 1: 写只读 fixture RED harness**

新 shell test 先用 `command -v sqlite3` fail loud，再在临时 SQLite 写入：Astra run 通过两行 `codex_review_job` 在第 2 轮 approved、一次 QA 打回、两次 founder 打回、两小时 design；Fable run 通过 `design_review_manifest` revision 1 approved、零打回、一小时 design。每个 design execution 都有 matching `workflow_execution_runtime` 与 `dispatch_vendor_resolved`。另放三类反例：`simple_code` 噪音、runtime/event model 冲突、带空 `edge_id` legacy loop 的 QA run。fixture chmod 只读，记录 SHA-256，执行：

```bash
sqlite3 -readonly -header -csv "$DB" < scripts/fly2403-design-model-comparison.sql
```

断言恰好四个 metric、两臂各自逐项 `n`，Fable review N 不为 0，零打回在已到观察窗时进入 `n=1`，污染归因样本与 ambiguous QA 样本分别显示在排除计数且不被当成 0，前后 SHA-256 相同。

- [ ] **Step 2: 验证 RED**

Run `bash scripts/__tests__/fly2403-design-model-comparison.test.sh`.

Expected: FAIL because SQL file does not exist.

- [ ] **Step 3: 最小 GREEN SQL**

用 CTE 依次构造：

1. `design_runtime` 与逐 execution matching `dispatch_vendor_resolved`；
2. 仅单臂且 receipt 全匹配的 `design_arms`，以及显式 attribution exclusion count；
3. Astra `codex_review_job` / Fable `design_review_manifest` 的 per-execution final round union，再按 run 求和；
4. 观察窗内 `qa_kickbacks`、`founder_kickbacks`、`design_duration`，对任何空 edge legacy loop 将该 run 的 QA 值置空；
5. 四行 `metric_values`。

只把 `gpt-6-astra` 与 `claude-fable-*` 映射成臂；最终列为 `metric, astra_avg, astra_total, astra_n, fable_avg, fable_total, fable_n, attribution_excluded_n, qa_ambiguous_excluded_n`。

- [ ] **Step 4: 验证 GREEN 并提交**

复跑 shell test；在 `.github/workflows/ci.yml` 的 hermetic test lane literal 加入 `bash scripts/__tests__/fly2403-design-model-comparison.test.sh`，再跑 `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`。提交 SQL、harness 与 CI 枚举，commit message `feat(reports): compare Astra and Fable design outcomes`。

### Task 5: 综合验证、review 与 PR

- [ ] **Step 1: 运行 focused tests 与完整硬门**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run -- --exclude '**/tmux-viewer.macos.test.ts'
bash scripts/__tests__/fly2403-design-model-comparison.test.sh
```

若 aggregate test script 不接受透传 exclude，则使用仓库各 package Vitest config 的等价排除命令，并记录证据；绝不启动真实 GUI test。

- [ ] **Step 2: 走 code review**

通过 `codex:rescue`（不直接调用 `codex exec`）审阅 diff；再注册 `review_code` gate 与 `request-review --type code`。若 `CHANGES_REQUESTED`，先补 RED regression、修复、复验，再开新 gate/request round。

- [ ] **Step 3: 完成文档与 literal last milestone commit**

更新 `progress.md` 与验收证据，新建 `engineering/doc/milestones/FLY-2403.md`。确保 milestone 是最后一个 commit，message `docs: record FLY-2403 implementation milestone`。

- [ ] **Step 4: push、开 PR、handoff**

Push feature branch、创建 PR，不 merge/ship/dispatch QA。用 `flywheel-comm ask --report` 报 commit、PR、验证结果及“真实 Astra design 阳性对照待合入启用后由后续 code issue 完成”，然后执行 `complete --route needs_review --pr <number>`。

## Plan 自检

- 覆盖模型注册、三处 policy、HTTP 200/400、实际 model receipt、四指标/N、Lead 交替规则及 simple_code/QA/authority 边界。
- 无占位步骤；真实阳性对照明确属于部署后外部验收，未以本地 mock 冒充。
- 类型一致：alias=`astra`，canonical=`gpt-6-astra`，runtime vendor=`codex`，override node=`eng_design`，Astra default effort=`xhigh`。
