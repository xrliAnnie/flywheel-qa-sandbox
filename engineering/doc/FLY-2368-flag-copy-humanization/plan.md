# FLY-2368 Flag 文案人话化 — 实施计划
Issue: FLY-2368 (https://linear.app/geoforge3d/issue/FLY-2368/2356s5-flag-文案人话化-删-governance-gate-类别registry-每条-flag)
日期: 2026-09-05
基于: research.md

## 结果

registry 的当前 23 条 flag 各有一条 founder-facing `whenOn`；管理台、共享 flag 卡片和新生成的每周留/清页从该字段显示具体含义。名字后缀不参与语义判断。`governance_gate` 继续保持生产代码零引用，约定文档保留「治理性策略不做成 flag,写死在代码里,要改走 PR」。全部 flag 的实际值、`polarity`、`default` 与解析行为逐字不变。

## 锁定范围

修改：

- `packages/config/src/feature-flags/{registry,resolve,index}.ts`
- `packages/config/src/index.ts`
- `packages/teamlead/src/bridge/{management-console-contract,management-existing-writers,fleet-console-html,feature-flag-render,flag-retirement-scan}.ts`
- `doc/engineer/implementation/flag-authoring-runbook.md`
- config registry/resolve 测试，teamlead management/render/flag-retirement 测试及直接受 additive 类型投影影响的 fixture
- `engineering/doc/FLY-2368-flag-copy-humanization/` 文档和最终 milestone

不修改：

- flag store codec、stage/apply 写路径、env/config 读取、scope precedence、runtime wrapper
- 任一 flag 的 `default`、`polarity`、source、scope、valueKind、enumValues、readSites、toggleable 或线上当前值
- 已通过 FLY-2257 删除的 `governance_gate` 生产分支
- `CLAUDE.md`

## C1：registry 人话合同（TDD）

先改 `feature-flags-registry.test.ts`，得到以下预期红灯：

1. public surface 导出 `validateWhenOnContract()`；
2. `FEATURE_FLAGS` 每条都有非空 `whenOn`；
3. 空白 `whenOn` 变异体被拒绝；
4. 当前 23 条 `[name, whenOn]` 与 research.md 表逐条一致；
5. `validateOnMeansContract()` 不再根据 `_disabled` 后缀判语义，名字不再成为真相来源；用同一个 bool spec 只改名字的变异体证明校验结果相同。

确认红灯来自字段/导出缺失后，最小实现：

- `FeatureFlagSpec` 增加兼容字段 `whenOn?: string`；真实 registry 的必填性由下一条 guard 执行，避免逼迫 drift/scan/store-policy 的合成 spec 伪造 founder 文案；
- 新增 `validateWhenOnContract(spec)`，只守非空白；
- 23 条逐条加入 research.md 锁定文案；
- 从 `validateOnMeansContract()` 删除 `name.endsWith("_disabled")` 分支，保留 bool 必填、非 bool 禁填的结构约束；
- 从 config 两层 index 导出新 guard；
- authoring runbook 第 1 步加入 `whenOn`：写打开后的结果，不带 issue 号，不拿实现术语当说明。

本 chunk 结束后运行 config registry 焦点测试。用以下固定序列化重算不变量指纹，仍须为 `23 / 6d671432f1244e529fc8dbba38f2dfe8a89da113b533ac430113e794946e5506`：

```bash
pnpm --filter flywheel-config exec tsx -e 'import {createHash} from "node:crypto"; import {FEATURE_FLAGS} from "./src/feature-flags/registry.ts"; const out=FEATURE_FLAGS.map(f=>[f.name,f.polarity,f.default,f.valueKind,f.scope,f.source]); console.log(FEATURE_FLAGS.length,createHash("sha256").update(JSON.stringify(out)).digest("hex"))'
```

## C2：只读投影（TDD）

先在以下既有测试加失败断言：

- `feature-flags-resolve.test.ts`：`resolveFlag()` 投影 `whenOn`；
- `management-existing-writers.test.ts`：provider 投影 `whenOn`；
- `management-console-snapshot.test.ts`：snapshot 保留 `whenOn`；
- 类型 fixture 同步把 `whenOn` 设为显式字符串。

确认预期红灯后，最小实现：

- `FlagView.whenOn?: string`，`resolveFlag()` 从 spec 复制；
- `ManagementFlagView.whenOn: string | null`，management provider 只把非空白 view copy 投影为 string，否则投影 `null`；
- 不改 schema version：这是 additive 字段，同一 PR 页面一起消费；既有版本握手行为不变。
- `flag-retirement-scan.ts` 的新 run item 把非空 `spec.whenOn` 冻结进既有 `description` 列供 founder 页展示；缺失时冻结明确的「未登记人话说明」错误文案，不回退工程 description，不改旧 run。

运行 config resolve + teamlead projection/snapshot 焦点测试。

## C3：页面读取 `whenOn`（TDD）

先写页面失败测试：

1. `management-console-ui-contract.test.ts` 直接调用 `flagReading()`，bool 得到 `打开代表：<whenOn>。`，value/enum 得到 value-neutral 的 `这个设置决定：<whenOn>。`；当前值未知时仍保留含义；tail 明写当前值与默认关系；tone 只由 current/default 是否相同决定。缺失/空白 `whenOn` 的 snapshot 变异体必须进入 unknown 分支并显示「这里不猜」。
2. `management-console-dom.test.ts` 抽五条人工核要求对应的 fixture：
   - 默认关、打开即停用：`cmux_rebind_disabled`；
   - 默认开功能：`alert_system`；
   - 默认关功能：`workflow_node_reuse`；
   - 项目级默认开：`pipeline_dag`；
   - 非 bool：`node_dwell_threshold_hours`。
   每行断言人话、可见的 `当前：…`、默认偏离提示；技术 `description` 不再作为主说明。
3. `fleet-console-html.test.ts` 断言第二列表头改为「打开 / 取值代表什么」且发射 `flag.whenOn`。页面脚本不含 `_disabled` 是 FLY-2257 已有 regression guard，不冒充本轮 RED。
4. `feature-flag-render.test.ts` 断言共享卡片的 effect line 使用并转义 `whenOn`，同时保留「取值型」与「每个项目单独设」提示；缺字段显示明确错误。
5. `flag-retirement-scan.test.ts` 先证明新 run 的「人话说明」仍错误地来自 engineering description，再改为 `whenOn` 并转绿。

确认红灯后，最小实现：

- `flagReading()` 先校验非空白 `whenOn`，再按 valueKind 选择「打开代表 / 这个设置决定」前缀；业务含义直接取 `whenOn`；默认偏离只做状态展示，不再生成业务解释；
- 第二列表头改为「打开 / 取值代表什么」，tail 明写 `当前：开/关/值/未知`，避免反事实说明被误读成当前状态；
- 管理台行不再显示工程 `description` 作为 founder 主说明；
- `effectSentence()` 对普通 flag 返回 `whenOn`，并保留非 bool 的取值提示和 project scope 提示；dormant 的只读警告继续保留；
- 所有 user-derived copy 继续经 `esc()`，不拼未转义 HTML。

运行 management UI/DOM/render 焦点测试。

## C4：静态守卫与视觉验证

1. `rg -n 'governance_gate' packages scripts` 必须零命中；历史文档不作为残留。约定文档精确句继续存在。这是已绿 regression check，不记作新 TDD 红灯。
2. `rg -n 'endsWith\\([^)]*_disabled|/_disabled' packages/config/src packages/teamlead/src/bridge` 必须零命中；真正由本轮删除的 registry suffix 分支另有 C1 name-mutation test 阳性证明。
3. 启动 FLY-2257 的 loopback management-console harness，至少在 1280px 打开 Flags 页：确认五条抽样行可见、人话不被裁切、HTML 中无原始 `<script>` 注入。若宿主浏览器策略阻断，保留原始失败，并用 happy-dom 的可见 DOM 断言作为非视觉证据，不把它冒充截图。
4. 重算 registry 不变量指纹；任何不一致都停止，不用更新基线掩盖。

## C5：全仓验证、代码评审与 PR

本机先依次运行安全、串行的相关门：

1. 所有 vitest 命令前置 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`，只跑受影响的 config/teamlead 文件，并显式 `--exclude "**/tmux-viewer.macos.test.ts"`；
2. `pnpm lint`；
3. 串行 `pnpm --filter flywheel-config build`、`pnpm --filter flywheel-teamlead build`，不在 founder 主机跑 `pnpm -r build` 并行浪涌；
4. 仓内每个新增 `scripts/__tests__/*.test.sh`（本计划不新增，若实现期增加则逐个串行执行）。

本机**禁止**运行会真实探测/打开 Terminal.app 的裸 `pnpm test:packages:run`，也不先造成伤害再记录。创建 PR 后，以 Linux PR CI 的 exact-head 结果覆盖动态角色要求的全仓 aggregate：CI 必须实际执行并通过 `pnpm -r build` 与 `pnpm test:packages:run`；Linux 上 macOS GUI 用例在 platform guard 前安全跳过。CI 未证明这两个 exact gates 前不执行 implement completion。

然后通过 `codex:rescue` 做独立代码审查，按动态契约注册 `review_code` gate；有 blocking finding 就修复、重新跑相关测试、提交新 head 并申请新一轮。评审通过后 push。最后一个 commit **只**新增 `engineering/doc/milestones/FLY-2368.md`，之后不再改分支；创建 PR并等待 exact-head CI 证明上述 aggregate gates，再执行 `complete --route needs_review --pr <NUMBER>`，不 dispatch QA、不 merge、不 deploy。

## 提交切片

1. docs：exploration/research/approved plan（progress 由 comm 单独提交）；
2. test + implementation：registry `whenOn` 合同与 23 条文案；
3. test + implementation：resolve/snapshot 投影与 UI；
4. review fixes（如有）；
5. milestone（PR literal last commit）。

每个行为 chunk 严格执行：先红灯并保存输出 → 最小实现 → 绿灯 → 必要重构；每批完成更新 progress ledger。
