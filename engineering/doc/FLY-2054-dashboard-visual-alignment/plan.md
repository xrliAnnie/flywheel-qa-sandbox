# FLY-2054 管理台视觉回归 — 实施计划
Issue: FLY-2054 (https://linear.app/geoforge3d/issue/FLY-2054/dashboard视觉-管理台视觉回归原型逐屏-side-by-side-对齐-fly-1038-prototype-观感founder-8)
日期: 2026-08-25
基于: research.md

## 0. 完成定义

本节点完成必须同时满足：

1. FLY-1038 prototype 与生产 fixture 在实例页模型/DAG/Cron、Infra 虚拟组、Feature Flags 页逐屏 side-by-side 观感对齐；
2. Issue 列出的六条逐项有自动或浏览器证据；
3. FLY-2052 阴性对照（land/engine 无模型不红）和阳性对照（agent node 真缺模型仍红）同时通过；
4. FLY-1262 PRD §6 四条既有自动验收保持通过，写回/级联交互未改变；
5. targeted + whole-repo gates 完成；code review APPROVED；PR 已开；最后一个 commit 是独立 milestone 文件；
6. implement node 只 `complete --route needs_review --pr <N>`，不请求 founder/ship、不 merge。

### Design review R1 修订

本版吸收 R1 全部 findings：gate 与 engine 两条件共同过滤；改用合法 land-v1 fixture；长下拉改成字体实测；Infra Lead 从普通 project model view 排除；derived-only project 仍可达；group search 使用自身 label；视觉 token 增加 computed-style 断言；浏览器能力在执行时重探；统一 comm CLI 解析；Infra detail 保留“dept 组不是独立项目”的说明。

## 1. TDD：锁定 FLY-2052 正反对照

**Files**

- Modify: `packages/teamlead/src/__tests__/management-dag-source.test.ts`
- Modify: `packages/teamlead/src/bridge/management-dag-source.ts`

### 1.1 RED

直接绑定仓库现有且已通过 validator 的 `tpl_eng_heavy_land_v1` fixture（不得向非 land-v1 manifest 临时塞 `execution` 字段），断言：

- projection 不产生 `land` model target；
- DAG 无 `has no model binding` error；
- design/implement/qa 等 agent nodes 仍存在、可编辑。

阳性对照从一个可通过 `validateWorkflowManifest(..., {allowUnsupportedModels:true})` 的普通 agent node fixture 同时移除 `vendor/model`；先显式断言 validator 接受该 manifest，再断言 management DAG 显示 `has no model binding`。这样 RED 不会来自 fixture schema 错误。先运行并保存失败输出：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-dag-source.test.ts
```

### 1.2 GREEN

把 projection predicate 从 `node.type !== "gate"` 改为**共同排除**：`node.type !== "gate" && node.execution !== "engine"`。gate 合法地没有 `execution` 字段，不能用后一条件替代前一条件。不放宽 manifest validation，不为未知 node type 加默认吞错。

## 2. TDD：锁定视觉 contract 与 Infra 语义

**Files**

- Add: `packages/teamlead/src/__tests__/management-console-visual-regression.test.ts`
- Modify: `packages/teamlead/src/__tests__/fleet-console-html.test.ts`
- Modify: `packages/teamlead/src/__tests__/management-console-dom.test.ts`

### 2.1 RED：静态视觉 contract

断言生成 HTML 与实际挂载后的 computed style：

- 有 `.window-frame` / `.window-chrome` / 三个 traffic dots；
- 静态 token 包含 prototype 的 `#eef0f4`、`#f7f8fb`、`#5646d6`，且不再包含旧深色 nav `#15233d`；同时挂载真实 CSS，以 `getComputedStyle()` 断言 `.side` 实际背景为浅色、`.nav-button.active` 实际使用 indigo soft/accent，避免“声明但未使用/被覆盖”的假绿；
- model 三列有 provider/model/effort 专用 class 与 `132/170/96px` 级别最小宽度；
- 页头模板不再含 `真源 revision`，仍保留 `observedRevision`/source revision 的 JS 数据流；
- 两个主页与已有 endpoint/data-attribute contract 不变。

### 2.2 RED：DOM/derived group

扩展 DOM fixture：同一个 flywheel project 同时出现在 ordinary `flywheel` group 与 derived `infra` group，且 `leadIds` 指向 infra Lead。断言：

- sidebar 文本 `flywheel` 只出现一次；
- `Infra` 虚拟 item 只出现一次，badge 为 Lead 数；
- 点击 Infra 后只显示指定 infra Leads，不显示 project runner/DAG/Cron tabs；
- 回点 flywheel 后完整 project tabs 恢复，但 model tab 只显示**不属于任何 derived group** 的普通 Leads；infra Leads 只在 Infra 中出现，两个 sidebar badge 与 prototype 一致；
- 搜索 `Infra` 只命中 derived group 自身 label；搜索 `flywheel` 不把 Infra group 当作 flywheel 的别名；
- 再加一个“某 project 的全部 Leads 都属于 derived Infra”的 fixture：该 project 必须落入 `其他` fallback，仍能进入其 Runner/DAG/Cron；
- project 页头显示 `N 个可见 Lead · N 个 DAG · N 个 Cron`，不显示 hash；Infra detail 显示“按 dept 归组，不是独立项目”的说明。

先运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/management-console-visual-regression.test.ts \
  src/__tests__/management-console-dom.test.ts \
  src/__tests__/fleet-console-html.test.ts
```

## 3. GREEN：重做 renderer 视觉层

**File**

- Modify: `packages/teamlead/src/bridge/fleet-console-html.ts`

### 3.1 Shell / chrome / navigation

- 外层 body 改为 prototype 冷灰背景，加入满高 `.window-frame` 和装饰 `.window-chrome`；
- source health 移到 chrome 右侧 pill；
- sidebar 158px 浅底 + 细线，active nav 用 indigo soft background/left rail；
- project rail 收到 210px；mobile media query 保留现有可用降级。

### 3.2 Density / typography / controls

- detail padding、tab、section title、card radius/border/shadow 对齐 prototype；
- model control 三列加专用 class + min-width，较窄容器整组换行；
- Lead model 从大卡片网格收敛为紧凑 row；DAG/cron/flags 分别使用 prototype 的模板卡、cron row、flag group 层次；
- 不删除任何 `data-*` event target，不改 `drafts`/stage/apply/confirm/progress JS。

### 3.3 Header / Infra projection

- project subtitle 只显示 Lead/DAG/Cron 统计；
- client 建 `leadsById` 与 `derivedLeadIds`；ordinary group 渲染 project，derived group 用自身 `label` 作为搜索 key 渲染一个 group item；
- ordinary project 的 model Lead rows 与 Lead badge 排除 `derivedLeadIds`，derived group detail 只按自身 `leadIds` 渲染，确保 Lead 行也不重复；
- 计算 `其他` fallback 的 `grouped` 集合时只纳入 ordinary groups，不纳入 derived groups；因此全员 infra 的 project 仍有 project button，可访问其 Runner/DAG/Cron；
- 新增 `selectedGroupId` 或等价本地 UI state，group detail 复用 Lead model renderer，显示“这些仍是原 project 的 Lead；这里只是 dept 聚合，不是独立项目”；不把 group 写进 snapshot、不制造可写 project entity。

### 3.4 Refactor

仅在 GREEN 后抽取 `renderLeadRows` / `projectStats` / `selectedPresentationGroup` 等纯 helper，避免分叉相同 HTML。对意外发现但与本单无关的交互缺陷只记录，不顺手扩 scope。

## 4. 交互与 §6 回归

运行完整 management console focused suites：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fleet-console-html.test.ts \
  src/__tests__/management-console-page-switch.test.ts \
  src/__tests__/management-console-ui-contract.test.ts \
  src/__tests__/management-console-dom.test.ts \
  src/__tests__/management-console-visual-regression.test.ts \
  src/__tests__/management-dag-source.test.ts \
  src/__tests__/management-console-contract.test.ts \
  src/__tests__/management-console-snapshot.test.ts \
  src/__tests__/management-change-coordinator.test.ts \
  src/__tests__/management-existing-writers.test.ts
node scripts/qa-fly-1262-management-dashboard.mjs
```

对 §6 的判定：脚本四项各自必须打印 PASS；单个总 exit 0 不能替代四项逐条证据。

## 5. 浏览器逐屏 side-by-side

**Artifacts**

- Add: `engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/README.md`
- Add: `engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/*.png`

实现时先耐久记录浏览器能力探针：检查当前 runner 是否实际暴露 callable ProofShot / Claude-in-Chrome / Playwright connector，而不把另一 session 的安装文件等同于本 session 可调用。若可调用，优先走项目要求的 ProofShot/Chrome 路径；否则记录 exact unavailable probe，使用 system Chrome 151 + CDP。两条路径都只连接临时 loopback harness（不提交 inventory、不访问 live writer），并另起 prototype `serve.mjs`。同 viewport（建议 1440×1000）截图：

1. 实例 / 模型（普通 project，长值 `Anthropic` + `Opus 5 (1M)`）；
2. Infra virtual group；
3. DAG 模板（正常 land fixture）；
4. DAG 真缺模型 error fixture；
5. Cron；
6. Feature Flags。

每个 screen 生成 prototype + production 两张，再用系统图像工具拼 side-by-side。除视觉判断外记录 DOM measurements：

- inactive page `display:none`；
- provider/model/effort 的选中文字宽度实测：用 select 的 computed font 在 offscreen span（或 canvas `measureText`）测选中 option label，比较 `textWidth` 与 `clientWidth - paddingLeft - paddingRight - nativeArrowReserve`；`scrollWidth <= clientWidth` 不作为证据，因为原生 select 截字时该式仍会绿；
- sidebar `flywheel` count=1、Infra count=1；
- detail header 不含 `file:`/64-char hash；
- 정상 DAG `.role-error` count=0，真缺模型 fixture count>0。

`evidence/README.md` 逐条列 viewport、fixture、图片和六项结论；明确这些是作者证据，不替代后续独立 QA 与 founder 终验。

## 6. Whole-repo gates

按风险从窄到宽，避免把全量红先归咎环境：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
git diff --check
```

若全量失败，保存 exact command/signature，先在 base/head 或 targeted control 上归因；不以“已知 flake”口头跳过，也不在 host 跑 provisioning suites。

## 7. Durability、review 与 PR

1. 每个 RED/GREEN/visual/gate 边界更新 `progress.md`。
2. 实现与测试 commit 后 stage `code_review`，按 Codex author 协议。先解析一次同一 CLI，之后所有 protocol 命令都使用它：

```bash
COMM_CLI="${FLYWHEEL_COMM_CLI:-/Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js}"
node "$COMM_CLI" gate review_code --lead flywheel-eng-lead \
  --exec-id 8048f66f-dcbd-49ac-b9cf-739f5b10db61 --no-block \
  "Code review requested for FLY-2054"
node "$COMM_CLI" request-review --type code --question-id <id>
```

轮询到 APPROVED；CHANGES_REQUESTED 则修复并开新 gate/request。
3. Push feature branch，开 base=`main` 的非 draft PR。
4. 按 `engineering/doc/milestones/README.md` 新建 `engineering/doc/milestones/FLY-2054.md`，与本 issue 文档收尾一起作为 PR 最后一个 commit；不改 `CLAUDE.md`。
5. 核 exact head CI/PR 状态，向 Lead 发 DONE report，执行：

```bash
node "$COMM_CLI" complete --route needs_review --pr <NUMBER>
```

不执行 verify-approval、merge、restart 或 founder-review gate；这些属于后续 DAG 节点/Lead。
