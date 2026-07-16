# FLY-1262 统一管理台 — 实施计划
Issue: FLY-1262 (https://linear.app/geoforge3d/issue/FLY-1262/build-flywheel-统一管理台fly-1038-prd-落地-ssot-自动发现-统一提交流落盘6-硬约束为核心验收)
日期: 2026-07-14
基于: research.md

## Goal

在现有 localhost Fleet Console 上交付 FLY-1038 的生产统一管理台：一个 versioned backend snapshot 自动聚合真实 projects/Leads/roles/DAG/flags/cron；一个 server-side unified stage/apply 协议把可写变更落到 projects/config/workflow catalog/flag source/plist + launchctl；前端不含手工业务名单，形态逐屏对照 prototype；PRD §6 四条均有自动化与独立真机证据。

## Non-negotiable Decisions

1. 复用 `FleetConsole` 的 loopback/same-origin/token/audit/journal；不另建 admin service。
2. frontend 只请求一个 aggregate snapshot，只调用一对 unified changes stage/apply；不做 domain fan-out。
3. model/provider/effort registry 在 `packages/config`，runtime validation 与 UI 共用。
4. DAG 直接消费 FLY-1135 workflow catalog；不新增 project-config DAG override。
5. cron 扫全部 scheduled plist；归属看 `Program` + 全部 absolute argv path，不看 label prefix 或 argv0-only。
6. Lead 跨 provider v1 全部 fail-closed 只读；不实现 managed cutover，不把 manual note 当写回。
7. mixed-source apply 不宣传全局 ACID；首写前全量 preflight，domain 原子/CAS，durable per-item partial result。
8. governance/dormant/无 dedicated writer 的 flag 只读；“统一 toggle”是统一视觉与状态语义，不是绕开安全边界。
9. 本计划执行必须逐行为 RED→验证正确失败→最小 GREEN→验证全绿→REFACTOR；若 production code 先于失败测试，删除后重做。

## Delivery Boundaries

### In scope

- versioned management DTO + providers；
- canonical model registry；
- topology/agent/DAG/flag/cron read model；
- DAG node model/effort revision+publish；
- weekly Cartesian cron schedule + enable/disable + typed model binding write；
- existing same-backend Lead model/effort、runner default、direct/project flag 适配；
- server-side unified change coordinator、journal/audit/progress；
- prototype-equivalent production HTML；
- generic extension section seam；
- automated acceptance harness + independent QA instructions。

### Explicitly out of scope

- Lead cross-provider managed cutover；
- 自动推断脚本是否使用 LLM；
- 编辑非 weekly Cartesian 的高级 launchd schedule；
- 新权限/多用户系统；
- FLY-1256 quota 参数与 FLY-1259 dispatch 参数的具体 tab（只交付接缝）；
- PM 验收 FLY-830；
- 把本单拆成新 issue。

## Implementation Order and Dependency Gate

FLY-1135 catalog 在开放 PR #593，head 会移动，不 pin SHA。Implement phase 开始时：

```bash
node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID"
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
git fetch origin
gh pr view 593 --json state,mergedAt,mergeCommit,statusCheckRollup,url
```

仅在 TURN 输出 `yours` 后触碰 worktree。若 #593 已 merge，合并最新 `origin/main`，再验证 symbols：

```bash
git merge --no-edit origin/main
test -f packages/teamlead/src/workflow-template.ts
rg -n "createWorkflowTemplateRevision|publishWorkflowTemplate|workflow_template_revision" \
  packages/teamlead/src/StateStore.ts packages/teamlead/src/workflow-template.ts
```

Expected：文件和 symbols 均存在。若 #593 未 merge：

- 先完成 Task 1-3、5-10 中不 import catalog 的部分；
- 在进入 Task 4 前用非阻塞 `ask` 通知 Lead dependency 仍未落；
- 不 cherry-pick 未批 head、不复制 schema、不写 config fallback；
- 等依赖进入 main 后再合并并执行 Task 4/最终集成测试。

每个 task 完成后更新同目录 `progress.md`；只提交当前 task 文件，不夹带其它 runner/user change。

## Task 0 — Freeze Baselines and Acceptance Fixtures

**Files:**

- Add: `packages/teamlead/src/__tests__/fixtures/fly1262/README.md`
- Add: `packages/teamlead/src/__tests__/fixtures/fly1262/projects.json`
- Add: `packages/teamlead/src/__tests__/fixtures/fly1262/project-config.yaml`
- Add: `packages/teamlead/src/__tests__/fixtures/fly1262/com.xiaorongli.weee-weekly.plist`
- Modify: `engineering/doc/FLY-1262-unified-management-dashboard/progress.md`

### Step 0.1 — Record current green baseline

```bash
pnpm --filter flywheel-config exec vitest run \
  src/__tests__/model-tiers.test.ts \
  src/__tests__/three-stage-phases.test.ts \
  src/__tests__/feature-flags-registry.test.ts \
  src/__tests__/feature-flags-resolve.test.ts

pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fleet-console-model.test.ts \
  src/__tests__/fleet-console-model-flags.test.ts \
  src/__tests__/fleet-console.test.ts \
  src/__tests__/fleet-console-html.test.ts \
  src/__tests__/fleet-routes-mount.test.ts \
  src/__tests__/runner-routes.test.ts
```

Expected：baseline tests 全绿。若失败，先证明是否 main/environment baseline；不要在本单 production diff 中“顺手修”。

### Step 0.2 — Add source-like fixtures only

Fixtures 必须表达真实反例：

- project `personal-assistant` root 指向 temp-replaced placeholder；
- `weee-weekly` label 不含 `com.flywheel`；
- plist argv0 `/bin/bash`，argv1 才位于 project root；
- schedule Wed 09:00；
- fixture 不含 secret/env value；
- README 声明这些是 test source fixtures，不是 production data list。

这里不写 production code，不需要伪造 RED；fixtures 在后续 task 的首个 RED 被消费。

### Step 0.3 — Commit fixture baseline

```bash
git add packages/teamlead/src/__tests__/fixtures/fly1262 engineering/doc/FLY-1262-unified-management-dashboard/progress.md
git commit -m "test(management): add SSOT discovery fixtures"
```

## Task 1 — Create the Canonical Provider/Model/Effort Registry

**Files:**

- Add: `packages/config/src/model-registry.ts`
- Add: `packages/config/src/__tests__/model-registry.test.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/model-tiers.ts`
- Modify: `packages/config/src/three-stage-phases.ts`
- Modify: `packages/config/src/__tests__/model-tiers.test.ts`
- Modify: `packages/config/src/__tests__/three-stage-phases.test.ts`
- Modify: `packages/teamlead/src/bridge/fleet-capabilities.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-capabilities.test.ts`

### Step 1.1 — RED: specify registry invariants

Create tests for:

1. provider ids/labels unique；model ids globally unique；aliases collision-free case-insensitively；
2. Claude Fable/Opus/Sonnet/Haiku + explicit 1M selectors resolve to existing canonical ids；
3. Codex `gpt-5.6-sol` exists under provider `openai`/runtime vendor `codex` and permits `xhigh` on workflow/runner surface；
4. every `MODEL_TIERS` entry and every `DEFAULT_PHASE_DISPATCH` row resolves through registry；
5. target surface filters return only compatible provider/model/effort combinations；
6. unknown current model can be rendered as `legacyCurrent:true` but cannot become selectable；
7. registry has no Google option unless a real model entry exists；
8. Lead cross-provider target remains `writable:false` even if model exists；
9. `fleet-capabilities` options are projections of registry, not a second model list。

Run RED:

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/model-registry.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fleet-capabilities.test.ts
```

Expected：first command fails because module/export is absent；second fails on new projection assertions, not a syntax/setup error。

### Step 1.2 — GREEN: implement minimum registry

Implement typed immutable registry:

```ts
interface ModelRegistryEntry {
  id: string;
  provider: "anthropic" | "openai";
  runtimeVendor: "claude" | "codex";
  label: string;
  aliases: readonly string[];
  effortsBySurface: Readonly<Record<ModelSurface, readonly string[]>>;
  surfaces: readonly ModelSurface[];
}
```

Export lookup/filter/normalize helpers and a serializable `buildModelCatalog(surface)`。Keep existing `MODEL_TIERS` exports byte-compatible, but derive/validate them against registry。Make `DEFAULT_PHASE_DISPATCH` use registry constants instead of a private Codex string。Refactor `fleet-capabilities.ts` to request Lead-surface catalog while retaining current DTO shape and cross-provider readonly ruling。

Run GREEN:

```bash
pnpm --filter flywheel-config exec vitest run \
  src/__tests__/model-registry.test.ts \
  src/__tests__/model-tiers.test.ts \
  src/__tests__/three-stage-phases.test.ts
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fleet-capabilities.test.ts \
  src/__tests__/fleet-console-model.test.ts
pnpm --filter flywheel-config typecheck
pnpm --filter flywheel-teamlead typecheck
```

Expected：all pass，无 duplicate-list drift。

### Step 1.3 — REFACTOR and sentinel

- 删除 `fleet-capabilities.ts` 内重复 canonical model ids，只保留 Lead-specific eligibility/capability policy；
- registry builder 在 module init/test 中 fail loud on duplicate/invalid surface；
- 保留 legacy aliases behavior；
- 全绿后 commit。

```bash
git add packages/config/src/model-registry.ts packages/config/src/index.ts \
  packages/config/src/model-tiers.ts packages/config/src/three-stage-phases.ts \
  packages/config/src/__tests__/model-registry.test.ts \
  packages/config/src/__tests__/model-tiers.test.ts \
  packages/config/src/__tests__/three-stage-phases.test.ts \
  packages/teamlead/src/bridge/fleet-capabilities.ts \
  packages/teamlead/src/__tests__/fleet-capabilities.test.ts
git commit -m "feat(config): centralize model capabilities"
```

## Task 2 — Define the Versioned Management Contract

**Files:**

- Add: `packages/teamlead/src/bridge/management-console-contract.ts`
- Add: `packages/teamlead/src/__tests__/management-console-contract.test.ts`
- Modify: `packages/teamlead/src/bridge/fleet-console-model.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-console-model.test.ts`

### Step 2.1 — RED: define DTO and stable ids

Test a wished-for `ManagementSnapshotV1` contract:

- `schemaVersion:1`、`generatedAt`、`snapshotRevision`；
- one `modelCatalog`；projects、presentationGroups、flags、extensions；
- every managed value has current/sourceRevision/writeCapability/consequence/error；
- target ids are opaque and stable across value changes；
- cron target id uses canonical plist path identity hash + label, never raw path as authority；
- same label in two files yields distinct ids；
- JSON serialization contains none of `botToken`, `botTokenEnv`, hydrated `match` or secret canary；
- unknown source kind/target kind cannot be constructed；
- current errors are data, not silently defaulted values。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-console-contract.test.ts
```

Expected RED：missing module/types/functions。

### Step 2.2 — GREEN: add discriminated contract

Add:

- `SourceRef` (`projects_json|project_config|model_registry|workflow_catalog|flag_registry|launchd_plist|launchctl|extension`)；
- `SourceRevision` string helpers (`file:<sha256>` / `db:<revision>:<digest>` / `registry:<version>`)；
- `WriteCapability` (`writable`, `reason`, `consequence`, `requiresAcknowledgement`)；
- stable target-id builders/parsers that reject client path injection；
- DTO variants for Lead/runner/role/DAG/cron/flag/extension。

Keep old `ConsoleSnapshot` as an internal compatibility alias/projection until UI migration is green；do not delete old fields in the same RED cycle。

Run GREEN + existing DTO tests：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-console-contract.test.ts \
  src/__tests__/fleet-console-model.test.ts \
  src/__tests__/fleet-console-model-flags.test.ts
pnpm --filter flywheel-teamlead typecheck
```

### Step 2.3 — REFACTOR

Extract only pure id/revision helpers used by ≥2 providers。Do not put source IO in contract file。

## Task 3 — Build Topology, Role and Snapshot Provider Orchestration

**Files:**

- Add: `packages/teamlead/src/bridge/management-topology-source.ts`
- Add: `packages/teamlead/src/bridge/management-console-snapshot.ts`
- Add: `packages/teamlead/src/__tests__/management-topology-source.test.ts`
- Add: `packages/teamlead/src/__tests__/management-console-snapshot.test.ts`
- Modify: `packages/teamlead/src/bridge/fleet-console.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-console.test.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-routes-mount.test.ts`

### Step 3.1 — RED: topology discovery behaviors

Use temp projects/config fixtures and real `ProjectConfig`/`ConfigLoader` parsing。One assertion per behavior：

- adding a new Lead to projects fixture adds one Lead view with no UI/source list change；
- projects sorted alphabetically；
- `department=infra` derives Infra presentation group while source project remains flywheel；
- `sub-lead` stays under tidal-echo；
- every `agents` entry yields a role card using exact validated `agent_file`；
- configured `projectRepo` yields encoded GitHub blob link；missing repo yields `link:null` + diagnostic；
- invalid/missing project config yields project/role error data, not omission；
- duplicate project name/root ambiguity fails closed；
- source errors do not remove unaffected projects。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-topology-source.test.ts
```

Expected RED：source builder missing。

### Step 3.2 — GREEN: implement provider

Implement `buildTopologyView(liveProjects, loadedConfigs)` with no filesystem paths from client。Do not special-case real ids; derive Infra solely from department。Link builder uses `projectRepo` + validated repo-relative path；no `git remote` shell per snapshot。

### Step 3.3 — RED: aggregate endpoint

`management-console-snapshot.test.ts` should inject fake topology/model/flag providers and assert：

- one snapshot call invokes each provider once；
- provider errors attach to `sources` and preserve other sections；
- deterministic ordering produces stable `snapshotRevision` for unchanged inputs；
- changed provider revision changes snapshot revision；
- no static project data in builder。

Route test `GET /api/fleet/snapshot` asserts versioned contract and NO Bearer on loopback, plus existing non-loopback rejection/secret canary。

Run RED, then add the minimum snapshot composer and wire it behind `FleetConsole.buildSnapshot()`。Keep route URL for compatibility。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-console-snapshot.test.ts \
  src/__tests__/fleet-console.test.ts \
  src/__tests__/fleet-routes-mount.test.ts
```

### Step 3.4 — REFACTOR and commit

Provider interfaces must be data-oriented (`read(): SectionResult`), not Express-aware。Remove compatibility projection only after old tests/UI are migrated in Task 10。

```bash
git add packages/teamlead/src/bridge/management-console-contract.ts \
  packages/teamlead/src/bridge/management-topology-source.ts \
  packages/teamlead/src/bridge/management-console-snapshot.ts \
  packages/teamlead/src/bridge/fleet-console.ts \
  packages/teamlead/src/bridge/fleet-console-model.ts \
  packages/teamlead/src/bridge/plugin.ts \
  packages/teamlead/src/__tests__/management-console-contract.test.ts \
  packages/teamlead/src/__tests__/management-topology-source.test.ts \
  packages/teamlead/src/__tests__/management-console-snapshot.test.ts \
  packages/teamlead/src/__tests__/fleet-console-model.test.ts \
  packages/teamlead/src/__tests__/fleet-console.test.ts \
  packages/teamlead/src/__tests__/fleet-routes-mount.test.ts
git commit -m "feat(management): aggregate topology snapshot"
```

## Task 4 — Consume the FLY-1135 Workflow Catalog for DAG Read/Write

**Dependency:** PR #593 symbols must be on current branch before this task。

**Files:**

- Add: `packages/teamlead/src/bridge/management-dag-source.ts`
- Add: `packages/teamlead/src/bridge/management-dag-writer.ts`
- Add: `packages/teamlead/src/__tests__/management-dag-source.test.ts`
- Add: `packages/teamlead/src/__tests__/management-dag-writer.test.ts`
- Modify: `packages/teamlead/src/StateStore.ts`
- Modify: `packages/teamlead/src/workflow-template.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-templates.test.ts`
- Modify: `packages/teamlead/src/__tests__/workflow-template.test.ts`
- Modify: `packages/teamlead/src/bridge/management-console-snapshot.ts`

### Step 4.1 — Dependency proof

```bash
test -f packages/teamlead/src/workflow-template.ts
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/StateStore.workflow-templates.test.ts \
  src/__tests__/workflow-template.test.ts \
  src/__tests__/workflow-template-routes.test.ts
```

Expected：dependency tests green before FLY-1262 changes。

### Step 4.2 — RED: DAG read projection

Test：

- project/category binding resolves current published revision + digest + manifest nodes；
- node target ids stable across revision value changes；
- design/implement/qa cards carry vendor/model/effort + catalog capability；
- unbound project shows roles but no fake workflow；
- invalid/missing current revision surfaces error；
- role cards remain from config, not synthesized from template；
- registry rejects manifest model incompatible with vendor/surface。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-dag-source.test.ts
```

Expected RED：provider missing。

### Step 4.3 — GREEN: read from StateStore only

Implement provider using existing list/get/binding APIs；do not query SQLite from Bridge file directly。Attach DB revision/digest as `sourceRevision`。

### Step 4.4 — RED: atomic edit+publish

Add StateStore tests for a wished-for atomic operation：

- expected current revision matches → append exactly one revision, append publication/audit, move current pointer；
- expected mismatch → conflict and **zero** new revision/publication/audit；
- model change only mutates named node；all edges/loops/gates byte-semantically preserved；
- canonical registry/vendor/model/effort validation runs before transaction；
- two concurrent expected-same writers yield one published/one conflict；
- existing run snapshot stays old；new admission gets new revision；
- published revision remains immutable/update/delete blocked。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/StateStore.workflow-templates.test.ts \
  src/__tests__/management-dag-writer.test.ts
```

Expected RED：no atomic method/writer。

### Step 4.5 — GREEN: implement one transaction

Add a StateStore method such as `createAndPublishWorkflowTemplateRevision(input)` that：

1. validates/canonicalizes manifest before mutation；
2. transactionally checks expected current；
3. appends revision/publication/audit；
4. CAS-updates pointer；
5. calls `save()` only after transaction success；
6. returns typed `published|conflict|not_found`。

`management-dag-writer.ts` must accept target id + desired dispatch fields, re-read current manifest server-side, copy and mutate only target node, then call atomic method。Client never supplies authoritative full manifest。

Run GREEN：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/workflow-template.test.ts \
  src/__tests__/StateStore.workflow-templates.test.ts \
  src/__tests__/management-dag-source.test.ts \
  src/__tests__/management-dag-writer.test.ts
pnpm --filter flywheel-teamlead typecheck
```

### Step 4.6 — REFACTOR and commit

No second DB schema/API。Keep `/api/workflow` read routes working。

```bash
git add packages/teamlead/src/StateStore.ts packages/teamlead/src/workflow-template.ts \
  packages/teamlead/src/bridge/management-dag-source.ts \
  packages/teamlead/src/bridge/management-dag-writer.ts \
  packages/teamlead/src/bridge/management-console-snapshot.ts \
  packages/teamlead/src/__tests__/management-dag-source.test.ts \
  packages/teamlead/src/__tests__/management-dag-writer.test.ts \
  packages/teamlead/src/__tests__/StateStore.workflow-templates.test.ts \
  packages/teamlead/src/__tests__/workflow-template.test.ts
git commit -m "feat(management): edit workflow catalog revisions"
```

## Task 5 — Discover and Normalize Launchd Cron Jobs

**Files:**

- Add: `packages/teamlead/src/bridge/management-cron-source.ts`
- Add: `packages/teamlead/src/__tests__/management-cron-source.test.ts`
- Modify: `packages/teamlead/src/bridge/management-console-snapshot.ts`
- Test fixtures from Task 0

### Step 5.1 — RED: parser and discovery matrix

Write separate tests：

1. arbitrary `com.xiaorongli.weee-weekly` label appears；
2. argv0 `/bin/bash` + argv1 project script maps to project；
3. label `com.flywheel.*` with no project path becomes Unassigned, proving label is ignored；
4. scan uses `Program` + every absolute ProgramArgument；relative args ignored for ownership；
5. longest registered root wins (`tidal-echo` vs nested root fixture)；
6. ambiguous equal matches produce readonly diagnostic；
7. Adobe/unmatched scheduled job appears Unassigned/Unmanaged, not omitted；
8. symlink/non-regular plist is visible error and not writable；
9. malformed plist error is data and scan continues；
10. same label in two files produces distinct stable ids；
11. no `StartCalendarInterval` means not a cron card；
12. source listing order deterministic。

Schedule table tests：

- dict and array；
- missing Weekday → all seven days；
- 0/7 Sunday → ISO 7；
- daily/workday/weekend/custom labels；
- multiple times Cartesian product；
- duplicate entries warning；
- Month/Day/Second, missing Hour/Minute, sparse non-Cartesian → read-only；
- range errors → source error, no invented default。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-cron-source.test.ts
```

Expected RED：module missing；fixtures themselves parse with system `plutil`。

### Step 5.2 — GREEN: injectable source adapter

Implement IO dependencies (`readdir/lstat/realpath/readFile/execFile/launchctl`) as constructor args with production defaults。Use `execFile` argv arrays, never shell interpolation。`plutil -convert json -o - path` parses plist。

Ownership uses path-segment-aware containment on canonical candidates。Do not read script contents。Model binding rules：

- recognize a canonical direct `--model <id>` pair only when writer supports preserving argv；
- accept typed provider binding supplied by project config/registry；
- otherwise set `modelWritable:false, reason:"未声明模型载体"`。

Runtime view separately resolves disabled override and loaded evidence；errors do not overwrite declared schedule。

### Step 5.3 — GREEN verification and REFACTOR

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-cron-source.test.ts \
  src/__tests__/management-console-snapshot.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Extract pure `normalizeWeeklySchedule` and `matchProjectRoot` only after green。

## Task 6 — Write Plist Schedule and Launchctl State with Rollback

**Files:**

- Add: `packages/teamlead/src/bridge/management-cron-writer.ts`
- Add: `packages/teamlead/src/__tests__/management-cron-writer.test.ts`
- Modify: `packages/teamlead/src/bridge/management-cron-source.ts`

### Step 6.1 — RED: stage is zero-mutation

Tests with temp LaunchAgents dir + injected plutil/launchctl：

- valid weekly schedule returns canonical old/new/file SHA/prior runtime state；
- stage never renames file or calls launchctl；
- target id resolves server-side, client path ignored/rejected；
- SHA drift, Label mismatch, uid mismatch, symlink, directory escape reject；
- zero days/zero times、bad hour/minute、duplicates reject or canonicalize per contract；
- advanced schedule refuses edit but still allows independent enable/disable if safe；
- model edit without typed binding refuses。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-cron-writer.test.ts
```

Expected RED：writer absent。

### Step 6.2 — GREEN: render candidate only

Use JSON object from plutil, replace only `StartCalendarInterval` or declared model carrier, render same-dir temp, `plutil -lint` candidate。Preserve unrelated keys, file mode, uid/gid。Do not write a `Disabled` key as substitute for launchctl state。

### Step 6.3 — RED: apply/verify/rollback state machine

One test per failure boundary：

- loaded schedule change: bootout → rename → enable → bootstrap → verify；
- enabled but unloaded calendar job: rename/bootstrap, verify registered without requiring PID；
- disable: bootout if loaded → disable → verify；
- enable: enable → bootstrap → verify；
- plutil render/lint fail → old bytes untouched, zero launchctl；
- SHA drift at apply → zero mutation；
- bootout fail before rename → old bytes untouched；
- rename success then bootstrap fail → exact bytes restored + prior load/disabled restoration attempted；
- rollback failure returns `partial` with original and rollback diagnostics；
- no-op causes zero side effects；
- two writers on same file serialize and second stale conflicts。

Verify call sequence and final real bytes/state, not merely mock call count。

### Step 6.4 — GREEN: implement minimal state machine

Use same-directory random temp with exclusive create, fsync before rename, then post-action `launchctl print`/`print-disabled` verify。All commands arrays include exact `gui/$uid` domain and validated Label。Journal-facing result is typed `applied|no_op|rejected|rolled_back|partial`。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-cron-source.test.ts \
  src/__tests__/management-cron-writer.test.ts
pnpm --filter flywheel-teamlead typecheck
```

### Step 6.5 — REFACTOR and commit

```bash
git add packages/teamlead/src/bridge/management-cron-source.ts \
  packages/teamlead/src/bridge/management-cron-writer.ts \
  packages/teamlead/src/bridge/management-console-snapshot.ts \
  packages/teamlead/src/__tests__/management-cron-source.test.ts \
  packages/teamlead/src/__tests__/management-cron-writer.test.ts \
  packages/teamlead/src/__tests__/fixtures/fly1262
git commit -m "feat(management): manage launchd cron schedules"
```

## Task 7 — Adapt Existing Lead, Runner and Flag Writers

**Files:**

- Add: `packages/teamlead/src/bridge/management-writer.ts`
- Add: `packages/teamlead/src/bridge/management-existing-writers.ts`
- Add: `packages/teamlead/src/__tests__/management-existing-writers.test.ts`
- Modify: `packages/teamlead/src/bridge/fleet-console.ts`
- Modify: `packages/teamlead/src/bridge/fleet-capabilities.ts`
- Modify: `packages/teamlead/src/bridge/flag-routes.ts`
- Modify: `packages/teamlead/src/bridge/runner-routes.ts`
- Modify: `packages/teamlead/src/__tests__/runner-routes.test.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-routes.test.ts`

### Step 7.1 — RED: common writer interface

Specify `ManagementWriter` with `resolve`, `preflight`, `apply`, optional `rollback` and typed consequence/result。Tests assert：

- exact target kind maps to one writer；unknown/duplicate registration fails；
- writer never trusts client `from`, path, projectRoot, consequence or writerId；
- preflight is side-effect-free；
- same target duplicate changes coalesce only if desired value identical, otherwise reject。

### Step 7.2 — RED: Lead ruling and reuse

- same backend model/effort delegates to existing Fleet canonical/engine path；
- provider/backend desired change always rejects `readonly_cross_provider`；
- backend-only draft cannot exist；
- forged apply cannot bypass disabled UI；
- manual cutover note is not `applied` and is absent from canonical changes。

### Step 7.3 — RED: runner and flag policies

- runner default uses exact project config root from server topology + expected SHA；
- direct flag delegates existing safe env/config writer；
- conversational/governance/dormant/unsupported flag rejects with registry reason；
- project override only where resolver supports project scope；
- global-only flag rejects project override；
- direct flag apply refreshes effective state on next snapshot。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-existing-writers.test.ts \
  src/__tests__/runner-routes.test.ts \
  src/__tests__/fleet-routes.test.ts
```

Expected RED：common adapter missing/new policy assertions fail。

### Step 7.4 — GREEN: extract services, keep routes compatible

Extract pure service functions from route handlers only as needed so both old compatibility routes and new writer adapters share validation/mutation。Do not call an Express route from coordinator。Do not widen flag writability。

Run GREEN：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-existing-writers.test.ts \
  src/__tests__/fleet-routes.test.ts \
  src/__tests__/runner-routes.test.ts \
  src/__tests__/feature-flag-config-source.test.ts
```

## Task 8 — Add One Server-side Unified Stage/Apply Coordinator

**Files:**

- Add: `packages/teamlead/src/bridge/management-change-coordinator.ts`
- Add: `packages/teamlead/src/__tests__/management-change-coordinator.test.ts`
- Modify: `packages/teamlead/src/bridge/fleet-admin.ts`
- Modify: `packages/teamlead/src/bridge/fleet-admin-audit.ts`
- Modify: `packages/teamlead/src/bridge/fleet-progress.ts`
- Modify: `packages/teamlead/src/bridge/fleet-console.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-admin.test.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-admin-audit.test.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-progress.test.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-routes-mount.test.ts`

New routes：

- `POST /api/fleet/changes/stage`
- `POST /api/fleet/changes/apply`
- existing `GET /api/fleet/progress` extended with per-item results。

### Step 8.1 — RED: canonical stage

Tests：

- request accepts only `{targetId,desiredValue,observedRevision}`；
- all writers resolve/preflight under one coordinator mutex before audit/token；
- unknown/readonly/incompatible/stale/duplicate conflict returns bounded error；
- any item preflight failure means zero writer apply and no token；
- staged audit failure returns 503 and no token；
- canonical old value comes from source, not client；
- items sorted deterministically and grouped by consequence；
- high-risk group sets required acknowledgement；missing acknowledgement prevents apply token or apply；
- confirm token binds canonical digest、origin、TTL、snapshot/source revisions；
- no-op items excluded with explicit no-op summary。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-change-coordinator.test.ts
```

Expected RED：coordinator/routes absent。

### Step 8.2 — GREEN: stage only

Implement minimum coordinator stage using registered `ManagementWriter`s and existing `ConfirmTokenStore`/audit primitives。A process mutex prevents overlapping UI batches；cross-process CLI races remain protected by each source SHA/CAS at preflight+apply。

### Step 8.3 — RED: apply and partial results

Tests：

- valid single-use token + unchanged sources applies；
- replay/forged/expired/wrong-origin token refuses + denied audit；
- after stage, mutate any later source → apply re-preflight rejects **before first writer apply**；
- audit pre-write failure → zero mutation；
- DB/config/plist group success combinations；
- independent item A success + item B runtime failure → final `partial` with A applied/B failed；
- one target file write success + runtime step fail + rollback success → `rolled_back`；rollback fail → `partial`；
- failure in one independent group does not erase truthful status or falsely mark whole batch success；
- every state transition persists to journal and survives coordinator recreation/reconcile；
- SSE exposes per-item terminal state；
- apply order deterministic；same target steps remain contiguous。

### Step 8.4 — GREEN: apply coordinator

Use durable batch id/canonical plan。Before first write re-run **all** preflights。Then execute target groups, persist each transition, invoke writer rollback on target failure, continue independent groups per approved P5 behavior, write final audit summary。Return 202 for detached long operation or terminal response for all-sync batch, but both use same journal/result schema。

### Step 8.5 — RED/GREEN: route security

Route tests must prove：

- loopback Host required for read/write；
- same-origin required for stage/apply；
- DNS-rebinding Host fails；
- no Bearer required/embedded；
- malformed/oversized change set bounded；
- old domain routes still work during migration；new UI later uses only unified routes。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-change-coordinator.test.ts \
  src/__tests__/fleet-admin.test.ts \
  src/__tests__/fleet-admin-audit.test.ts \
  src/__tests__/fleet-progress.test.ts \
  src/__tests__/fleet-routes-mount.test.ts
pnpm --filter flywheel-teamlead typecheck
```

### Step 8.6 — REFACTOR and commit

No provider-specific `if kind===...` mutation logic in Express route；registry dispatch owns it。

```bash
git add packages/teamlead/src/bridge/management-writer.ts \
  packages/teamlead/src/bridge/management-existing-writers.ts \
  packages/teamlead/src/bridge/management-change-coordinator.ts \
  packages/teamlead/src/bridge/fleet-admin.ts \
  packages/teamlead/src/bridge/fleet-admin-audit.ts \
  packages/teamlead/src/bridge/fleet-progress.ts \
  packages/teamlead/src/bridge/fleet-console.ts \
  packages/teamlead/src/bridge/plugin.ts \
  packages/teamlead/src/__tests__/management-existing-writers.test.ts \
  packages/teamlead/src/__tests__/management-change-coordinator.test.ts \
  packages/teamlead/src/__tests__/fleet-admin.test.ts \
  packages/teamlead/src/__tests__/fleet-admin-audit.test.ts \
  packages/teamlead/src/__tests__/fleet-progress.test.ts \
  packages/teamlead/src/__tests__/fleet-routes-mount.test.ts
git commit -m "feat(management): unify staged writes"
```

## Task 9 — Add the Generic Extension Section Seam

**Files:**

- Add: `packages/teamlead/src/bridge/management-section-registry.ts`
- Add: `packages/teamlead/src/__tests__/management-section-registry.test.ts`
- Modify: `packages/teamlead/src/bridge/management-console-contract.ts`
- Modify: `packages/teamlead/src/bridge/management-console-snapshot.ts`
- Modify: `packages/teamlead/src/bridge/management-change-coordinator.ts`

### Step 9.1 — RED: fake future provider

Register a test-only `quota-settings` provider with number/select/order-list fields and revision。Assert：

- no provider → no empty extension tab；
- registering provider adds section to snapshot with no core switch statement；
- field change becomes standard target/draft/canonical item；
- provider cross-field validation error blocks full stage；
- provider apply/rollback result uses same journal；
- duplicate section/field ids fail startup；
- unsupported field kind rejects rather than raw HTML injection。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-section-registry.test.ts
```

Expected RED：registry absent。

### Step 9.2 — GREEN: minimum field vocabulary

Support only `boolean|number|select|order_list`，足够覆盖 FLY-1256 contract。Do not implement quota source or designBackend defaults。All labels/help/options are server DTO text escaped by renderer。

### Step 9.3 — GREEN + REFACTOR

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-section-registry.test.ts \
  src/__tests__/management-console-snapshot.test.ts \
  src/__tests__/management-change-coordinator.test.ts
```

Document extension provider API in file comments pointing to FLY-1256/1259 source contracts；no generic arbitrary JSON editor。

## Task 10 — Rebuild the Production UI to Match the Prototype Shape

**Files:**

- Modify: `packages/teamlead/src/bridge/fleet-console-html.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-console-html.test.ts`
- Add: `packages/teamlead/src/__tests__/management-console-ui-contract.test.ts`
- Modify: `packages/teamlead/src/bridge/management-console-contract.ts`

### Step 10.1 — RED: static/network contract

Tests against generated HTML：

- title `Flywheel 管理台`；nav contains exactly 实例/Feature Flags；
- instance shell contains project search + model/DAG/cron tabs；
- full-height layout and sticky internal pending bar；
- old→new confirm modal and discard action；
- HTML references only `/api/fleet/snapshot`、`/api/fleet/changes/stage`、`/api/fleet/changes/apply`、progress；
- HTML does **not** reference old `/flag/stage`、`/runner/stage`、Lead stage/apply or cron copy commands；
- source has no `PROJECTS`/`VENDORS`/`FLAG_GROUPS` or real project/Lead/cron ids；
- no `${` template leak、no iframe、no remote script/style dependency；
- text/URL fields escaped, GitHub links `noopener noreferrer`。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fleet-console-html.test.ts \
  src/__tests__/management-console-ui-contract.test.ts
```

Expected RED：old Fleet UI/network paths fail assertions。

### Step 10.2 — GREEN: two-page shell and source-driven render

Rewrite only against `ManagementSnapshotV1`：

- nav switches pages without refetching static data；
- project groups sorted from DTO；Infra group uses `presentationGroup`；
- role cards render GitHub link or visible no-repo diagnostic；
- model cascade options are filtered `modelCatalog` + target capability, provider change disabled for Lead；
- DAG stage controls use DAG target ids；
- flags all render disabled/enabled toggle consistently with reason/effectiveByProject；
- extension tabs render generic field descriptors only when present。

No client-side source discovery or writer policy。

### Step 10.3 — RED/GREEN: cron interaction pure behaviors

Add testable functions/assertions for：

- weekday toggles never allow zero days；
- labels 每日/工作日/周末/自定义 derive correctly；
- add/remove time leaves at least one row；
- hour/minute validation blocks draft；
- readonly advanced schedule has no editable affordance；
- enable/model controls follow capability；
- draft keyed by targetId replaces prior desired value, reverting to current removes draft。

Use pure functions embedded/generated by the same source where possible；do not duplicate a test-only implementation。If DOM behavior cannot be proven without a new browser dependency, keep pure state functions testable and leave rendering integration to Task 12/QA, rather than adding a broad framework。

### Step 10.4 — RED/GREEN: unified pending flow

- all domain changes feed one Map；
- pending count and bar update；
- submit calls only unified stage once；
- modal renders **server canonical** from/to/consequence, not local reconstruction；
- required acknowledgement gates confirm button；
- confirm calls apply once；progress updates each item；
- discard clears draft and refetches snapshot；
- partial result renders “部分成功” with per-item state, never generic success。

### Step 10.5 — GREEN verification

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fleet-console-html.test.ts \
  src/__tests__/management-console-ui-contract.test.ts \
  src/__tests__/management-change-coordinator.test.ts \
  src/__tests__/fleet-routes-mount.test.ts
pnpm --filter flywheel-teamlead typecheck
```

### Step 10.6 — REFACTOR and commit

Keep one packaged HTML artifact per existing distribution model。Extract repeated HTML escaping/render helpers only after behavior green。

```bash
git add packages/teamlead/src/bridge/fleet-console-html.ts \
  packages/teamlead/src/bridge/management-console-contract.ts \
  packages/teamlead/src/__tests__/fleet-console-html.test.ts \
  packages/teamlead/src/__tests__/management-console-ui-contract.test.ts
git commit -m "feat(management): deliver unified dashboard UI"
```

## Task 11 — Add §6 Automated Acceptance Harness

**Files:**

- Add: `packages/teamlead/src/__tests__/fly1262-ssot-acceptance.test.ts`
- Add: `scripts/qa-fly-1262-management-dashboard.mjs`
- Modify: `packages/teamlead/package.json` only if script distribution requires it
- Modify: `engineering/doc/FLY-1262-unified-management-dashboard/progress.md`

### Step 11.1 — RED: hard requirement #1/#2

Start isolated `createBridgeApp` with temp sources。Assert：

- one GET returns projects/Leads/roles/DAG/flags/cron/modelCatalog；
- browser HTML contains no LM/manual ingest endpoint or static lists；
- source provider calls are deterministic code paths, not generated artifacts；
- secret canaries absent。

### Step 11.2 — RED: hard requirement #3 auto-discovery

In the same test, without changing production UI：

1. add Lead to projects fixture + refresh → one more Lead；
2. inject one new registered FlagView → one more flag；
3. add arbitrary-label plist with `/bin/bash`, project script at argv1 → one more project cron；
4. add unmatched plist → one Unassigned cron, not omission；
5. remove each source → snapshot follows true state。

No test should patch an HTML list between snapshots。

### Step 11.3 — RED: hard requirement #4 writeback

Drive HTTP stage→modal canonical data→apply against temp YAML/DB/plist/flag source：

- verify exact old/new values；
- verify files/DB actually changed；
- verify launchctl injected state sequence；
- mutate a source after stage → apply 409 and all original bytes/rows unchanged；
- mixed runtime failure → durable partial result；
- discard path causes zero mutation。

### Step 11.4 — GREEN and runnable QA script

Implement only missing integration glue。`scripts/qa-fly-1262-management-dashboard.mjs` must support：

- default isolated mode using temp HOME/sources and stubbed launchctl；
- `--live-readonly` mode fetches current Bridge snapshot and prints secret-free counts/source diagnostics；
- destructive live mode absent；real LaunchAgent actions belong to independent QA with explicit scratch label。

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly1262-ssot-acceptance.test.ts
node scripts/qa-fly-1262-management-dashboard.mjs
node scripts/qa-fly-1262-management-dashboard.mjs --live-readonly
```

Expected：test green；script emits PASS per §6 item and live readonly counts, no token/path secret。

## Task 12 — Regression, Review and Independent QA Handoff

### Step 12.1 — Focused suites

```bash
pnpm --filter flywheel-config exec vitest run \
  src/__tests__/model-registry.test.ts \
  src/__tests__/model-tiers.test.ts \
  src/__tests__/three-stage-phases.test.ts \
  src/__tests__/feature-flags-registry.test.ts \
  src/__tests__/feature-flags-resolve.test.ts \
  src/__tests__/feature-flags-drift.test.ts

pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-console-contract.test.ts \
  src/__tests__/management-topology-source.test.ts \
  src/__tests__/management-console-snapshot.test.ts \
  src/__tests__/management-dag-source.test.ts \
  src/__tests__/management-dag-writer.test.ts \
  src/__tests__/management-cron-source.test.ts \
  src/__tests__/management-cron-writer.test.ts \
  src/__tests__/management-existing-writers.test.ts \
  src/__tests__/management-change-coordinator.test.ts \
  src/__tests__/management-section-registry.test.ts \
  src/__tests__/management-console-ui-contract.test.ts \
  src/__tests__/fly1262-ssot-acceptance.test.ts \
  src/__tests__/fleet-console-model.test.ts \
  src/__tests__/fleet-console.test.ts \
  src/__tests__/fleet-console-html.test.ts \
  src/__tests__/fleet-routes-mount.test.ts \
  src/__tests__/fleet-routes.test.ts \
  src/__tests__/runner-routes.test.ts \
  src/__tests__/fleet-admin.test.ts \
  src/__tests__/fleet-admin-audit.test.ts \
  src/__tests__/fleet-progress.test.ts \
  src/__tests__/StateStore.workflow-templates.test.ts \
  src/__tests__/workflow-template.test.ts
```

Expected：all green, no warning/error output。

### Step 12.2 — Package/full repository checks

```bash
pnpm --filter flywheel-config test
pnpm --filter flywheel-teamlead test
pnpm --filter flywheel-config typecheck
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-config build
pnpm --filter flywheel-teamlead build
pnpm lint
git diff --check
```

Any failure：先按 systematic-debugging 证明 root cause。不能以“main flake”跳过；若确为 baseline/environment，保存复现命令、baseline 对照和本 diff 无关证据给 code review/QA。

### Step 12.3 — Static anti-manual sentinel

```bash
rg -n "PROJECTS|VENDORS|FLAG_GROUPS|com\.xiaorongli\.weee-weekly|codex-infra-bot-lead" \
  packages/teamlead/src/bridge/fleet-console-html.ts \
  packages/teamlead/src/bridge/management-*.ts

rg -n "/api/fleet/(flag|runner)/(stage|apply)|data-cron-copy|copy command" \
  packages/teamlead/src/bridge/fleet-console-html.ts
```

Expected：both commands exit 1/no matches。Fixture/docs matches are allowed；production source matches fail the task。

### Step 12.4 — Implement phase authoritative code review

After implementation PR/head freeze, follow dynamic request-driven cross-family code-review gate exactly；do not treat self-review as the authoritative gate。Any CHANGES verdict：fix by new RED test first, push new head, open a new review question。

### Step 12.5 — Independent QA handoff (same issue)

QA must run after reviewed head and must not accept Implement self-verification as substitute：

1. `node "$FLYWHEEL_COMM_CLI" turn ...` gets QA TURN。
2. Start production console and prototype; use Claude-in-Chrome to compare every screen/control/layout state。
3. Read live snapshot and independently sample projects/Leads/agents/DAG/91+ flags/LaunchAgents/launchctl against sources。
4. Create a unique scratch registered project + real LaunchAgent label **not** prefixed `com.flywheel`，script path behind `/bin/bash` argv1；schedule far-future safe time。
5. Prove auto appearance, weekdays×multiple times write, disable/enable, stale rejection, and exact cleanup/restore。
6. In isolated Bridge, add Lead and flag fixture with zero UI edit；capture network showing one snapshot and unified stage/apply only。
7. Verify Lead provider control is disabled and forged backend change server-rejected。
8. Verify all flag cards appear；readonly reasons honest；supported project override persists and refreshes effective state。
9. Verify server modal old→new, acknowledgement, discard, partial error rendering。
10. Record PRD §6 #1-#4 as separate PASS/FAIL with screenshots/logs/source evidence；any missing evidence = FAIL。

QA cleanup is part of PASS：remove scratch plist/project, bootout/enable state as appropriate, verify no scratch label/source remains。Do not touch production jobs such as `weee-weekly`。

## Definition of Done

| Requirement | Authoritative proof |
|---|---|
| §6.1 one clean backend SSOT | versioned `/api/fleet/snapshot` contract + route/integration test + browser network capture |
| §6.2 no LM/manual aggregation | production static sentinel + provider code audit + no ingest/manual list path |
| §6.3 auto new cron/Lead/flag | fixture acceptance + real arbitrary-label/argv1 QA proof |
| §6.4 unified real writeback | one stage/apply capture + exact YAML/DB/flag/plist/launchctl post-state + stale/partial tests |
| Prototype shape | Claude-in-Chrome per-screen checklist and screenshots |
| Model cascade truthful | runtime+UI shared registry tests；no phantom provider；Lead cross-provider disabled |
| DAG write truthful | PR #593 catalog integration、atomic revision/publish CAS、old-run pin tests |
| Cron safe | parser matrix、path/symlink guards、plutil lint、launchctl verify、rollback tests + scratch real QA |
| Flags safe | all registry entries visible；capability-aware toggle；governance server reject；real supported override |
| Extensible | fake generic section auto tab + same unified write flow；no 1256/1259 business duplication |
| Review/QA | cross-family code review APPROVED at frozen head + independent QA PASS at same head |

No row may be closed by intent, indirect test, or “no failure observed”。Every row needs the named current-head evidence。
