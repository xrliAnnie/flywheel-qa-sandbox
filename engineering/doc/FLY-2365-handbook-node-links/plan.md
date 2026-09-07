# FLY-2365 角色卡与 DAG 节点重连 — 实施计划
Issue: FLY-2365 (https://linear.app/geoforge3d/issue/FLY-2365/2356s1-角色卡-dag-节点重新连上manifest-在不恢复-role-的前提下给节点带执行手册引用schema-3)
日期: 2026-09-06
基于: research.md

## 0. 一句话

把系统 workflow manifest 升到 schema 3，在每个 agent 执行节点写入稳定的 `handbook_ref`（registry node name 或 custom agent path）；snapshot 原样封存这份 manifest 元数据，管理台把同一引用投影到唯一角色卡，并提供 hover/focus/click 高亮定位。schema 1/2 永久可读且逐节点显示“未关联”。本字段只服务管理台，不参与 agent 解析、dispatch、selection、admission 或 replay。按 Lead 裁定，flywheel 的 registry 节点全部真关联；legacy 项目仅在 ic-roster 与角色卡解析到同一个 canonical agentFile 时关联（当前 personal-assistant/general 一例），其余逐节点明示未关联。不伪造跨项目卡、不迁移外部仓。

## 1. 锁定边界

### 要做

1. manifest / snapshot schema 3 全链路兼容：authoring、seed、validation、materialization、selection、replay、generalized admission、release-state；除 decoder/version 分支外，运行行为与 schema 2 相同。
2. project config cache 保留 resolved registry；registry 项目的角色卡按唯一 handbook identity 生成。
3. management DTO 带 DAG `handbookRef`、角色卡 `handbookRefs` 与项目 registry/roster 解析状态。
4. DAG chip 对唯一角色卡提供鼠标、键盘与点击定位；所有缺失/悬空/legacy 情况明示原因。
5. 6 项目真实 snapshot 对照、schema 2 对照、metadata-only 不影响手册解析的负向对照与真实渲染截图。

### 不做

- 不恢复、重命名或扩大 `role`；不删除 schema 1/2 decoder。
- 不迁移 geoforge3d / growth / joycon-typeless / personal-assistant / tidal-echo 的 registry overlay 或 config。
- 不把 Flywheel bundled 手册卡伪装成别的项目的运行时绑定。
- 不加路由、不改写路径、不改模型选择、不改静态 node type 配色。
- 不让 `handbook_ref` 参与 agent 文件解析或改变 dispatch / selection / admission / replay 行为；运行时消费该字段属于 Residuals。
- 不改 DB 历史 revision/run，不做启动迁移；新 seed 以新 revision 正常发布。

## 2. 数据合同

### 2.1 manifest schema 3

```ts
interface WorkflowManifestNode {
  id: string;
  label?: string;
  type: WorkflowNodeType;
  handbook_ref?: string; // schema 3 execution nodes require it; registry node id or custom agent path
  // existing fields unchanged
}
```

- schema 3 与 schema 2 拥有相同 topology / ship-claim 形状，仅 node 增量 `handbook_ref`。
- schema 3 authoring/decoder 要求每个 agent 执行节点有非空字段；`gate` / `land` 禁止该字段。缺字段兼容由 schema 1/2 老 manifest 覆盖，因此 management DTO 必须 nullable；缺 ref 的坏 schema-3 revision 会在 validator 处使整张 DAG fail-visible，不宣称它能 node-level 降级。
- schema 3 不接受退役的 `role` key。无 custom `agent_file` 时要求 `handbook_ref === node.id`；有 custom `agent_file` 时要求 `handbook_ref === agent_file`。这让 metadata 与现有 `agent_file → node id` resolver 输入同源，却仍不让 runtime 读取 metadata；schema 2 的 historical `role`/custom 兼容保持原样。
- schema 1/2 exact-key 列表不加该字段，旧合同 byte-compatible。
- 新常量 `HANDBOOK_WORKFLOW_MANIFEST_SCHEMA_VERSION = 3`；保留值为 2 的 generalized compatibility 常量，避免把历史类型偷换含义。
- 新类型 `WorkflowManifestV3`；`WorkflowManifest` union 纳入 V3；`validatePinnedWorkflowManifest`、land/type guard 与 override helper 覆盖 V3。

### 2.2 snapshot schema 3

- 新增 `WorkflowRunSnapshotV3` 与 `buildWorkflowRunSnapshotV3()`；V2 builder 不改行为。
- 两个 builder 共用 generalized materialization helper，但输入 schema 与输出 schema必须一致；snapshot 3 通过其内嵌 manifest 自然封存 `handbook_ref`，不另造运行时权威字段。
- generalized builder 必须保持 V2 当前的 agent 解析顺序：显式 custom `agent_file` → historical `role` / bundled node id；V3 已禁止 role，因此实际只走 agent_file / node id，但不得读取 `handbook_ref` 来决定 agent 内容。
- parser 与 `validatePinnedWorkflowManifest` 接受 1 / 2 / 3；2/3 同属 generalized、都要求 pinned effort / generic handbook；digest 与 exact-key 校验不放宽。
- `StateStore.ts` 的 generalized admission、四处 release-state SQL 与 founder-approval 终态兜底，以及 runs route/selection 的 version 分支只扩到 2/3，不能改变已有派发语义或持久化名字。

### 2.3 management schema 2 的向后兼容增量

```ts
interface ManagementProjectView {
  handbookRegistryActive: boolean;
  handbookRosterAvailable: boolean;
  handbookResolvedRefs: string[];
}
interface ManagementRoleView {
  handbookRefs: string[];
}
interface ManagementDagGraphNode {
  handbookRef: string | null;
}
```

management version 不升：老页面忽略，新页面将字段缺失视为 false/空数组/null。

`handbookRegistryActive` 必须使用运行时同一个谓词 `projectUsesAgentRegistry(projectRoot)`：项目名为 `flywheel` 或存在 `.flywheel/agents/registry.yaml`。该谓词从 `workflow-menu.ts` 导出复用，不能用 `agentConfigsRequireRegistry(cfg.agents)` 代替。cache 在运行时谓词为真时独立保存 `resolvedRegistry`；即使 config 的 agents 仍是 legacy `agent_file`，角色卡也来自 resolved registry。registry 解析失败时保持 active=true、显示项目错误且所有 ref fail-visible，不回退为 legacy 卡。cache stamp 必须同时覆盖 config.yaml、项目 overlay 与 bundled registry 的 mtime/size/inode；任一 registry 文件变化都使下一个 snapshot 重算角色卡。

legacy 项目只读现有 ic-roster，把每个 roster node ref 经 `resolveNodeAgentFile()` 得到的文件与 config 角色卡 `agentFile` 都 realpath 后逐字比较。一个 ref 恰好命中一张卡时，把 ref 加进该卡的 `handbookRefs`；一张卡允许承载多个精确 roster ref。`handbookResolvedRefs` 记录 roster 中实际可解析的 ref，供 UI 区分“节点未配置”与“文件已解析但没有唯一角色卡”。不做 basename/label/模糊匹配，不落库、不改变 runtime resolver。

## 3. TDD chunks

每个行为变化按“一条 RED → 最小 GREEN → refactor”执行；每个 chunk 完成后跑聚焦测试、提交代码、更新 progress ledger。

### C1 · manifest schema 3 与内置 seed

**RED 1** — `workflow-template.test.ts`

- schema 3 接受对齐的非空 `handbook_ref`；agent 节点缺 ref 必须拒绝；gate/land 带 ref拒绝；schema 3 带 historical `role` 拒绝；ref 与 node id/custom agent_file 不一致拒绝；schema 2 带 ref 仍因 exact-key 拒绝；schema 4 拒绝。

**GREEN 1** — `workflow-template.ts`

- 加 V3 types/validator；把 V2/V3 公共验证抽成参数化 generalized validator，错误文本保留具体版本。
- land/type guards、tier presets、override 返回类型纳入 V3。

**RED 2** — `workflow-menu.test.ts`

- 6 个 graph 的 seed 均为 schema 3；每个 agent node 有 `handbook_ref === node.id`；gate/land 无 ref、无 role、无 agent_file。
- 汇总所有 agent node ref，均存在于 bundled registry nodes；每个 graph 内无重复引用。

**GREEN 2** — `workflow-menu.ts`

- `compileWorkflowMenuSeed()` 输出 schema 3，并只给 registry agent nodes填 `handbook_ref`。

聚焦门：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template.test.ts src/__tests__/workflow-menu.test.ts
```

### C2 · snapshot / selection / StateStore generalized v3

**RED 1** — `workflow-run-snapshot.test.ts`

- V3 builder 封存带 `handbook_ref` 的 manifest；node-id ref 与 custom agent-file ref 两条用例都断言 pinned agent 与 V2 现有 resolver 结果一致。另做静态/spy seam 负断言，确保 builder 不把 `handbook_ref` 传入 resolver；不能靠构造 validator 已禁止的分叉 manifest 来证明 metadata-only。
- snapshot 3 parse/replay；snapshot 2 原 fixture继续 parse；2/3 version mismatch、digest mismatch、unknown 4 拒绝。

**GREEN 1** — `workflow-run-snapshot.ts`

- 加 V3 union/builder；抽 generalized builder；parser 与 `validatePinnedWorkflowManifest` 的 generalized 条件覆盖 2/3，agent resolver 代码不读取 ref。

**RED 2** — `workflow-template-selection.test.ts`、`StateStore.generalized-execution.test.ts`、`StateStore.workkind-cutover.test.ts`、必要时 `runs-route.dag-entry.test.ts`

- fresh schema 3 candidate materializes，idempotent replay 返回同一 reservation；schema 2 既有行为不变；ref 改值不改变 agent 内容/dispatch 的对照成立。
- schema 3 execution binding 被 generalized admission 识别。
- release state 的 active run / side effect / reservation SQL 纳入 revision schema 3。
- runs route 把 schema 3 当 engine entry，不掉回 legacy；schema 2 replay 仍成立。

**GREEN 2** — `StateStore.ts`、`workflow-template-selection.ts`、`bridge/runs-route.ts`、`workflow-catalog-migration.ts`

- 所有版本 union 与 generalized predicate改成 2/3；SQL 用 `IN (2,3)`；覆盖 `StateStore.ts` founder-approval 终态兜底。
- schema 3 materialize 调 V3 builder；catalog seed census 读 `handbook_ref`。
- 保留 `entry_kind = workflow_v2`、`activeSchema2Runs` 等既有外部/持久化名字，只修注释为 generalized compatibility，不做迁移。

聚焦门：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-run-snapshot.test.ts src/__tests__/workflow-template-selection.test.ts src/__tests__/StateStore.generalized-execution.test.ts src/__tests__/StateStore.workkind-cutover.test.ts src/bridge/__tests__/runs-route.dag-entry.test.ts
```

### C3 · 管理台数据投影与真实角色卡

**RED 1** — `management-dag-source.test.ts`

- schema 3 graph agent node 投影 `handbookRef`；gate/land为 null；schema 2 老 revision 所有 node 为 null 且整图仍渲染。

**GREEN 1** — `management-console-contract.ts`、`management-dag-source.ts`

- DTO 增量字段；映射时只读 manifest `handbook_ref`，不以 node id/label/type 回猜。

**RED 2** — `feature-flag-config-source.test.ts`、`management-topology-source.test.ts`

- registry 激活项目 config cache 保存 `resolvedRegistry`；active 判据精确复用 `projectUsesAgentRegistry(projectRoot)`，不依赖 config agents 是否含 `node:`。
- flywheel 角色卡按 resolved registry node name 唯一生成，包含 `eng_design` / `implement`；config alias 不产生重复卡。
- legacy 项目仍保留原 config 角色卡，`handbookRegistryActive=false`；按 canonical agentFile 精确相等把 ic-roster refs 附到对应卡。
- overlay 已存在但 config agents 仍为 legacy 的夹缝 fixture：active=true，角色卡来自 registry；registry 解析错误时 active 不反转且不静默回退。
- 修改 config、项目 overlay、bundled registry 任一 stamp 后，cache 的下一次 `get()` 都重载；未变化时仍命中 cache。
- personal-assistant fixture：`general` roster ref 与 `life` 卡 realpath 相同，`life.handbookRefs=["general"]`；geoforge3d 无 roster，所有角色卡 refs 为空。路径仅 basename 相同或 symlink 逃逸不得匹配。

**GREEN 2** — `feature-flag-config-source.ts`、`management-topology-source.ts`

- registry 按运行时谓词 resolve 一次并存入 cache；只有 config agent 解析需要时才作为该解析的输入。cache identity 纳入 config/overlay/bundled 三个源。
- active 项目从 `resolvedRegistry.nodes` 生成卡且每卡 refs 为稳定 node name；legacy 才回退 `resolvedAgents` 并用 canonical agentFile 精确交集附 roster refs。

聚焦门：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-dag-source.test.ts src/__tests__/feature-flag-config-source.test.ts src/__tests__/management-topology-source.test.ts src/__tests__/management-console-snapshot.test.ts
```

### C4 · 前端 hover / focus / click 与失败显示

新增 focused happy-dom 文件 `management-console-handbook-links.test.ts`，不只做字符串断言。

**RED 1** — 关联阳性

- flywheel fixture 包含 7 个 handbook refs 与 6 DAG；每个 agent chip 的唯一匹配数为 1。
- mouseover/focus 给 chip 与对应 `.ic` 加高亮；mouseleave/blur 清除。
- click 与 Enter/Space 调用目标卡 `scrollIntoView` 并 focus，别的卡不亮。

**GREEN 1** — `fleet-console-html.ts`

- `icCard` 输出 escaped 的 `data-handbook-refs`（JSON 数组或等价安全编码）；dag render 用 node ref 在当前项目卡数组中做精确唯一匹配。
- linked chip 才有 `tabindex=0` / button semantics / `data-handbook-role`。
- delegated event 不用用户值拼 CSS selector，而是遍历 dataset 精确比对。
- 添加窄而清楚的 focus/highlight 样式，不改静态 type 色。

**RED 2** — 失败与兼容

- schema 2/null ref：chip 可见副标题只显示“未关联”，完整 `title` / `aria-label` 显示“模板未提供执行手册引用”。
- personal-assistant `general` 必须 linked 到 `life` 卡，完整关联说明为“按项目 ic-roster 解析到同一手册”。legacy 其余节点不得用 blanket 原因覆盖项目差异：无 roster/overlay 显示“该项目无 ic-roster / 无 overlay”；roster 没有该 ref 显示“该节点未在项目 ic-roster 中配置”；ref 已解析但不唯一命中卡显示“该项目 roster 解析到的文件与任何唯一角色卡不同”。可见副标题仍只放“未关联”；不声称 fallback，也不推断运行会失败。
- active project 悬空 ref显示“未关联”；完整 `title` / `aria-label` 显示“找不到对应角色卡”。重复 ref 是当前 `ResolvedProjectRegistry.nodes` Record 结构不可达的防御分支，只作合成 no-op 测试，不计作生产负例。
- gate/land继续显示“人工审批/引擎执行”，不出现未关联。
- 保留当前 `layNote()` 的产品/工程分类说明与 `data-rule="eng-node-types"` 断言；在旁边新增独立 `data-rule="handbook-links"` 说明：“悬停或聚焦节点可查看执行手册，点击可定位到角色卡；未关联节点会明示原因”。不对仓库里本来不存在的“两套颜色互不对应”做空断言。

**GREEN 2** — 完成 node-level reason 与 no-op interaction。

聚焦门：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-console-handbook-links.test.ts src/__tests__/management-console-dom.test.ts src/__tests__/management-console-projection-dom.test.ts src/__tests__/fleet-console-html.test.ts
```

### C5 · 6 项目渲染尺子与截图

在本 doc folder 新增只读 `evidence/harness.mjs`、`evidence/ruler.mjs`、`evidence/run.sh`、`evidence/README.md`：

- fixture 精确 6 个生产项目名、每项目 6 DAG；flywheel active，5 个 legacy；personal-assistant 的真实 roster 例外单列。
- `run.sh self-check` 的否定臂移除一个 flywheel role ref，必须以指定 `FLY2365_MISSING_UNIQUE_ROLE` 失败，连接/启动错误不能算成功。
- 启动 fixture 前只读抓取一次真实 `http://127.0.0.1:9876/api/fleet/snapshot` 基线。fail-closed 不变量只包括 6 个 project 名、每项目 6 个全局 DAG 的 id/templateId 与 runtime registry-active 判据；部署前必然不同的 handbookRef 存在性和 flywheel role-card 集合只作为 expected before/after delta 写入 metrics，不作 baseline failure。
- GREEN：flywheel 所有 agent chip 都 linked；personal-assistant/general linked 到 life 卡且带 ic-roster 说明；geoforge3d 与其余不可解析节点 explicit-unlinked；schema 2 专门卡显示模板缺 ref；原产品/工程分类说明仍为 1、新关联说明为 1。
- Playwright 对 6 个项目逐页验证一个 DAG agent chip；flywheel 与 personal-assistant/general 截唯一高亮卡，其余 legacy 截“未关联”并校验 title/aria 完整原因。chip 的 76–118px 可见副标题不承载长句；截图只要求短文案不截断，完整原因由属性断言。记录 console error / pageerror / 非 GET 请求均为 0。
- harness 在启动时绑定当前 dist HTML digest；脚本每次 build→停旧→起新→核 digest→测量→trap 清理，防止量到旧进程。

视觉产物保存为 `evidence/green/*.png` 与 `metrics.json`；人工打开主截图核对高亮、文字不截断、无重叠。

### C6 · 回归、review 与 PR

1. inbox 边界检查；扫描 schema 2/3 所有硬编码，确认无半升级。PR body 单列三个 tsc 无法兜住的 checklist：StateStore generalized admission、四处 release-state SQL、founder-approval 终态兜底。
2. 运行精确全仓门：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

3. 运行本单新增的所有 `scripts/__tests__/*.test.sh`（预期无新增；若 C5 放入 scripts 则逐个运行）。
4. 用 `codex:rescue` 做 code review，不直接调用 raw `codex exec`；修完每个 HIGH 后重新跑门并新开 review round。
5. 注册 `review_code` gate + `request-review --type code`，轮询到 APPROVED；advisory 另发 Lead report。
6. push feature branch，创建 PR。最后一个 commit **只**新增 `engineering/doc/milestones/FLY-2365.md`；确认它是 literal last commit 后更新/打开 PR。
7. 发 self-contained DONE report，然后执行 `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不 ship、不 merge。

## 4. 验收对账

| 要求 | 权威证据 |
|---|---|
| 不恢复 role | seed 精确对象 + repo diff：schema 3 agent node 有 handbook_ref，无 role/agent_file |
| schema 2 老 manifest 仍渲染 | validator/snapshot/source/DOM 四层 V2 fixture |
| 后端生成引用 | 6 graph 编译对照，ref ∈ bundled registry nodes |
| flywheel 任一 agent 节点唯一角色卡 | 真实 resolved registry projection + 6 DAG DOM matching count=1 |
| legacy 项目不伪造 | realpath 后 roster/role agentFile 对照；personal-assistant/general 唯一同文件映射必须链接，geoforge3d 等其余节点 explicit-unlinked + exact reason |
| 缺失不静默 | schema2/null 与 dangling 两个生产可达 DOM 负例；duplicate 仅作不可达防御测试 |
| 点击/悬停/键盘定位 | happy-dom 事件断言 + Playwright 截图 |
| 关联说明 | 保留产品/工程 `layNote`；source/DOM/visual ruler 断言新增 handbook 交互说明精确出现一次 |
| tsc/测试绿 | `pnpm -r build` + 聚焦套件 + `pnpm test:packages:run` |

## 5. 回滚

- seed hash 变化会在 Bridge 启动迁移中先做 verified online backup，再发布 6 个 schema-3 revision；这是显式 DB 状态写入，不可按“无状态”处理。
- 首选回滚是保留 schema-3 decoder，仅停止生成/展示新引用；这样当前 schema-3 revision 与历史 1/2 可继续读取，新派发不受版本降级影响。
- 若必须把代码整体 revert 到只认 1/2 的版本，必须先用仍识别 schema 3 的版本发布 schema-2 seed revision并核验其成为 current，再回退代码。反序操作会让 candidate selection fail closed、管理台模板变 errorDag；任何重新发布都依赖 verified backup 成功，备份失败必须停止回滚并恢复兼容版本。
- 不删除/重写 schema 2 revision/run/snapshot。运行中的 schema 2/3 都由 generalized release/admission路径继续处理。
- 外部 5 项目零写入，因此回滚不涉及跨仓修复。
