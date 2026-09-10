# FLY-2482 scope.v2 — 实施证据
Issue: FLY-2482 (https://linear.app/geoforge3d/issue/FLY-2482/进度页e1前置-取数层-scopev2不再丢-backlog-子单-itemsparent-rootscounts洞-eab)
日期: 2026-09-09
基于: plan.md

## S1 — 查询与快照

- TURN: implement epoch 2, activation c3d33b57-4106-4824-ac6e-5c140dfa4885 / b6c1c16d-01b5-4313-a590-6954c4ece01f。沿用设计 v3 / review-log R3 APPROVED，未修改批准计划。
- backlog RED: 聚焦查询测试 1 failed / 5 passed；期望 EPX-1、EPX-2，实际缺 EPX-2。删除查询层过滤后 GREEN 6/6。
- parent RED: 4 failed / 4 passed；返回 parent undefined、null 未保留、漂移快照未拒绝、孙单未返回直接父单。增加查询字段、原值投影和 drift 守卫后 GREEN 8/8。
- 聚焦命令: `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/linear-epic-query.test.ts`。
- `pnpm --filter 'flywheel-teamlead^...' build` exit 0 后，`pnpm --filter flywheel-teamlead typecheck` exit 0。
- 修改文件的 Biome 检查通过。共享 snapshot fixture 补 parent；其它构造点通过 spread 继承，类型检查未发现额外缺失。
- 初次运行没有 node_modules，vitest 未找到，不计 RED。随后 `pnpm install --frozen-lockfile` 成功。
- 计划的 `test:run -- <path>` 实测触发整包运行，已中止，不计任何通过收据；聚焦命令改用上面的 exec 形式。首次 typecheck 因工作区依赖尚未 build 失败；以上成功收据是在构建依赖后重新执行所得。

## 未完成

S1–S4 已完成；全包门禁、精确 HEAD 评审、CI、PR 与 needs_review handoff 仍按下文推进。没有生产验收或部署证据。

## S2 — Cell 合同、计数与回归

- 新 `scope-v2.test.ts` 首轮 36 failed，缺失 parent / counts 与规则计算不符；实现后 36/36。
- `counts.v1` 纯函数沿父链归根，六类计数、空根零值、未知状态整根 missing、悬空/环及 null state/blocked_by 拒绝。validator 核来源、形状、根顺序、数值、总和和完整 from 重算。
- 同一冻结 v2/filterV1 输入对拍 ready/dependency/stuck `.value`，另以非空 all_blocked 对拍证明 backlog blocker 的解释边保留且 in_scope=false；backlog 信号留在 item 上、residual 不读 backlog 的坏 session。
- 既有 fixture 更新到 v2，原 truncation 负向测试先确认新 counts 合法再篡改，防止提前被 counts 拦下造成假绿。
- 聚焦：18 files / 244 tests passed（epic-page 全目录、Linear 查询、page route、residual scan、refresher、StateStore page）；`pnpm --filter flywheel-teamlead typecheck` exit 0。注意 tsconfig 排除 `*.test.ts`，测试通过另由 Vitest 证明。
- 新 fixture 已共享导出 `epicShapeSnapshotV2` / `filterV1`。不升 schema_version，不引入 rollup、迁移或 attention/排序变化。

## S3 — 规则标签

- 新渲染测试 RED 1 failed / 18 passed；只改 HTML/Markdown 的 founder-decided 规则集合及 scope 文案后 GREEN 19/19。
- 通过既有 rendered Cell seam 验证 counts.v1 裁定标签，真实页不新增 parent/counts 的渲染栏位。类型检查 exit 0。
- F3 已由设计提交修正，当前 PR 内原文指向 §6.2 已裁定结论，本阶段没有重复修改。

## S4 — 容量

- 200 张 parent-bearing 子单 / 6 根，canonical document **949,815 bytes**，小于现有 1,507,328 上限。计数 total 合计 200。没有调整字节上限。
- v2 fixture 9 张卡本地 HTML **85,012 bytes**，不是当前 Linear 验收值。
- 当前 Linear 全量无秘密快照已向 Lead 请求（question fb086598-a2c7-49fd-8189-232893893223）；生产刷新/固定页版本推进归 QA/updater，未做生产写。

## 全仓验证（进行中）

- `pnpm lint` exit 0；14 个既有 warnings，没有改无关文件。
- `pnpm -r build` exit 0。
- `pnpm test:packages:run` 正在运行。本地仅临时排除 core 的 `tmux-viewer.macos.test.ts`，该用例会操作真实 Terminal.app；运行后按原字节恢复配置。此收据不会标成无排除的完整门禁，完整门禁另查 exact-head CI。已向 Lead 告知（question bddd0506-41cb-46e1-b11b-71d72bc0abdc）。


## 当前 Linear 冻结重放

- Lead 提供 `linear-snapshot.json`；源内 observed_at **2026-09-10T06:09:09Z**，SHA-256 **16281a5788d09b465c350a9e6f953e699ba9a69414dde89128390399ad59c99d**。源为递归 children + 完整 inverseRelations 分页，保留 blocks；不把最初 issue 中的 28 写死。
- 运行 `pnpm exec tsx engineering/doc/FLY-2482-scope-v2-parent-counts/replay-linear.ts`。脚本验证输入 hash，调用生产 acceptance 提取与页面生成器，并从 raw Linear 独立分类/归根对拍；结果保存在 `linear-replay-result.json`。
- **7 根、36 项、36/36 parent 匹配**；v1 投影 22 项，v2 多且仅多 14 项 backlog。每根六类计数与 total 均逐项相等，包括嵌套父链。
- 根 totals：FLY-2481=4，FLY-2456=1，FLY-2441=11，FLY-2369=1，FLY-2355=5，FLY-2309=7，FLY-1143=7。所有细分数见 JSON，未用表格报告。
- 同冻结输入的 ready/dependency/stuck `.value` canonical JSON 一致；这里运行事实明确 missing，带真实信号的非空回归另由单测覆盖。
- 使用真实 Linear 标题、描述、来源 URL 和 blocker 标题生成 **469,843 B HTML**（上限 524,288），文档 **284,064 B**。
- 边界：运行事实 StateStore/CommDB **明确 missing，未读取**，因此是离线 Linear 数据层与 HTML 预算证据，不是线上固定页的完整运行事实或发布版本验收。QA 仍须取新快照并验固定页版本推进。

## 验证异常与授权处置

- 第一轮 full packages 在未改的 config `fly1981-final-ledgers.test.ts:262` 超时 15000ms（786 passed / 1 failed），后续包未完成。隔离重跑该文件一次，11/11 pass，原超时用例 1699ms；没有改测试或超时阈值。
- 第二轮使用 `npm_config_workspace_concurrency=1 pnpm test:packages:run`，仍只临时排除 core GUI 用例，正在运行。
- Lead 回答 bddd0506-41cb-46e1-b11b-71d72bc0abdc：明确授权本地仅排除 `packages/core/test/tmux-viewer.macos.test.ts`，PR/进度披露，exact-head CI 作为未改配置全门禁；孤立 config rerun 通过后不再追改。
- rescue companion 已按要求尝试但创建线程失败：sandbox helper exit 71 / sandbox_apply Operation not permitted。Lead 在同一回答明确改为 **只走 Bridge exact-head request-review，不再使用 rescue**。没有 rescue 审查通过的收据。
- ProofShot 开启 headless 后能读到 a11y 结构，但未产出 screenshot；独立可写 socket 重试后 Chrome 在 DevToolsActivePort 前退出。另一个 chrome_devtools 入口被审批策略拒绝。视觉截图未通过，已请求 Lead 处理（e9b250a1-5f8b-405f-b54e-b223950cc835）；不能把 markup 测试当截图收据。

## 收口裁定与当前门禁状态

- full packages R2 原始摘要：`Test Files 1 failed | 48 passed (49)`；`Tests 1 failed | 1223 passed | 2 skipped (1226)`；`Errors 1 error`。失败 `test/async-exec-file.test.ts > defaultAsyncExecFile > writes the provided input and closes stdin`，`Command timed out after 500ms`；额外错误 `[vitest-worker]: Timeout calling "onTaskUpdate"`。完整进程 exit 1，绝不是绿色收据。
- 该未改文件隔离重跑一次：7/7 pass，exit 0（含原失败用例）；没有改源文件、超时值或任何 timeout 配置。
- Lead question **3912348c-a715-4a64-9166-f74ad8a08a2b** 明确授权：隔离重跑通过后，披露两轮 full 失败，不声称本地全绿，继续一次 push → exact-head request-review → CI 14/14 → needs_review。原始测试日志位于 `/tmp/fly2482-full-packages.log`、`/tmp/fly2482-full-packages-r2.log`、`/tmp/fly2482-runner-isolated.log`。
- 补充覆盖正在运行（最多 2 workers，非全门禁替代）：edge-worker/teamlead/voice-bridge/voice-codex，以及 gemini-agent/voice-headphone。后续结果通过 PR/Lead 报告给出；不会为补结果改冻结评审 HEAD。
- Lead question **e9b250a1-5f8b-405f-b54e-b223950cc835** 裁定：本单数据层及规则标签变化，implement handoff 不需要截图；实际固定页、≤524288 B 和 last_version 前进由 QA 核验。
- 本地临时 core GUI 排除配置已按原字节恢复。PR 只保留任务改动；没有新的 `scripts/__tests__/*.test.sh`。
