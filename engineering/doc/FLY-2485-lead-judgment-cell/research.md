# FLY-2485 Lead 判断格 — 调研
Issue: FLY-2485 (https://linear.app/geoforge3d/issue/FLY-2485/进度页e4-lead-判断格lead-note-新表-flywheel-comm-lead-note)
日期: 2026-09-09
基于: exploration.md

## 结论

复用现有 Bridge 身份边界、StateStore 持久化和 Epic 页面刷新流程。主要工作不是多写一个 HTML 段落，而是把新增来源贯穿严格模型校验、根列表嵌套格数组、出处收据、手动/自动生成入口及 HTML/Markdown 输出。无需新依赖。

## 核验范围

本轮只读源码与本地规范，另有一个独立只读审计覆盖持久化/鉴权/刷新。没有运行生产数据库迁移、写真实判断、操作 QA 槽位、重启或部署。live Linear 代理请求 HTTP 401，需求以注入任务及仓库 PRD 为准。

## 输入与身份

- `packages/flywheel-comm/src/commands/dependency.ts:46`：`parseArgs` 严格解析，stdout JSON，stderr 诊断，project/token/Bridge URL 从参数或环境获取。它的 `show` 在 :168 调 POST generate，有持久化副作用，不能复制给 `lead-note show`。
- `packages/teamlead/src/bridge/plugin.ts:4509`：dependency 用 `masterOnlyAuthMiddleware` 挂载。`dependency-route.ts:174` 对无 master 配置返回 503，scoped 返回 403，错误 token 返回 401。
- `plugin.ts:1169` 的通用 token middleware 在无 token 配置时放行，因此新写入口必须复用 dependency 的 fail-closed middleware。
- `dependency-route.ts:825` 通过 `createComment` 写 Linear；其 `claimed_actor` 和日志作者不是本单可复用的出处字段。
- `bridge/linear-scope.ts:41` 的 `resolveProjectNameParam` 精确匹配项目注册键；`:131` 的 `issueMatchesBinding` 同时核 team、project、label。项目键仍用现有函数；R1 补核发现页面只在根层筛 binding，子单纯父子遍历（linear-epic-query.ts:177、:274）。因此最终写范围为直接 binding OR 完整 snapshot roots/descendants 成员，不能只校验子单自己的标签。
- `bridge/linear-query.ts:20` 的 lookup 返回 UUID、identifier、labels、project，足够作绑定核验。响应只投影必要字段，不能把 assignee 等整个对象发回页面。
- `ProjectConfig.ts:233` 的 `resolveLeadDepartment` 优先显式 department，否则首个 match label 小写。`SummaryRole` 是摘要流向，canonical role 的 cos/dept/companion/external 也不是工程/产品等显示角色；不能混用。

## 数据与持久化

- `StateStore.ts:3274` 正常 create 执行 migration；maintenance open (:3280) 不迁移。新表只在正常 migration 创建，reader 绝不 lazy-create。
- `StateStore.ts:6922` 页面迁移示范 `CREATE TABLE IF NOT EXISTS` 和事务；`:11745` 持久化示范参数化 SQL、transaction、`save()`。新表加入同一迁移/持久化风格，按 Lead 裁定主键为 project+issue UUID+role，角色共存。
- `epic-page/model.ts:107` 是 Cell 契约：value/provenance/observed_at，null 当且仅当 missing 存在。该契约不能为“没写”造空字符串。
- `model.ts:139` 是 item；`:232` 根列表是外层 Cell 包着对象数组；`:319` 递归禁止 value 中出现 `_at`。新增根 lead_note 必须只在精确许可路径识别嵌套 Cell，其他路径继续拒绝隐藏时间戳。
- `model.ts:371` provenance 精确判别；`:739` document/item 精确键集合；新增来源和可选字段必须进入校验，不可仅靠类型断言。
- `model.ts:1045` digest 只删 observed/source_updated/generated 时间，保留 written_at 才能区分重新撰写。不要泛化成删除所有 `_at`。

## 生成、出处、刷新

- `epic-page/materialize.ts:52` 单次 snapshot → facts/signals → 一次 generatedAt → generate → assert → receipt；统一加 root+item 笔记读取点。
- 手动 wiring `bridge/epic-page-route.ts:233`，事件/扫描 wiring `bridge/plugin.ts:6183`；两处都必须传 note reader 和策略，不能只改 CLI 路径。
- `epic-page/generate.ts:310` 显式枚举 freshness 来源，必须加实际存在的 note Cell，使用 observed_at 表示读取时点；written_at 保持写入时点。
- `epic-page/receipt.ts:209` visitor 识别来源后立即 return；root 外层 Cell 阻止遍历 nested note。扩展 leaf 来源并为 canonical root note 数组逐格遍历；保留外层 Linear 来源。
- `receipt.ts:89` 的收据校验同样只认可现有来源；修改生成而漏改校验会导致持久化失败。
- `bridge/epic-page-refresher.ts:25` debounce 默认 5 秒；`:216` requestRefresh 合并项目事件，生成期间新事件会再 drain。添加 `lead_note_changed` reason，复用此队列，不新造 timer/任务。
- `dependency-route.ts:778` 写后通知失败不推翻已成功的写；本单 CLI 使用 invoked/unavailable：void requestRefresh 内部吞掉错误并记录 skip，invoked 只证明调用过，不证明排队/发布。
- `bridge/epic-page-publisher.ts:11` HTML 512 KiB 上限；`:59` 使用相同 project token 重发。写成功而发布失败不删除判断、不换 URL、不伪造新鲜度。
- `StateStore.ts:11665` freshness 从 refresh 结果投影；正常生成不靠旧 receipt 的新来源做业务判断。旧版能忽略保留的新表，但旧版 receipt 校验器不会读懂新增 kind/reason；降级验收必须如实记录此边界。

## 消费者

- `epic-page/render-html.ts:42` 与 `render-markdown.ts:41` 的 provenance fallback 假定 derived；必须显式加 lead_note 分支，否则会读不存在的 rule/from。
- HTML 的 `renderItem` / `executionSummary` 保留；Lead 句紧邻机器句，独立语义标签与样式。根在现有 root overview 中以 state 为机器部分，独立块放判断。
- `render-html.ts:467` 与 publisher 是两条 HTML 入口；阈值必须进入生成文档，不能只在某一路 render 临时注入。
- Markdown 保持机器摘要并新增转义后的 Lead 段；`epic-page/escape.ts:1` 已有转义，零表格要求针对本单报告，不能扩成本单重写历史 Markdown 页面。
- `Signal.provenance` 目前排除 linear/derived，新增来源后会意外放宽静态类型；改成显式只允许 statestore/commdb，运行信号不得使用 Lead 判断来源。
- `residual.ts`、`rules.ts`、`subtraction.ts`、审批/调度读取应保持完全不消费 lead_note。新增负向不变性测试验证这一点。

## 验证入口

- 命令测试：`packages/flywheel-comm/src/commands/__tests__/dependency.test.ts`。
- 路由/auth 测试：`packages/teamlead/src/bridge/__tests__/dependency-route.test.ts` 及 `src/__tests__/bridge-endpoints.test.ts` 中相同挂载方式。
- SQLite 样式：`packages/teamlead/src/__tests__/statestore-epic-page.test.ts`。
- 模型/生成/物化/收据/渲染：`packages/teamlead/src/epic-page/__tests__/{model,generate,materialize,receipt,render}.test.ts`。
- 发布/自动刷新：`packages/teamlead/src/bridge/__tests__/epic-page-{route,refresher}.test.ts` 与 `packages/teamlead/src/__tests__/epic-page-publisher.test.ts`。
- 使用定向 Vitest + 各包 typecheck；不跑根目录递归测试，不启动真实桌面/QA 服务。

## 文档与交付规范

最终 HTML 参照 `.flywheel/templates/ship-report-template.html` 的结论、修法、图、验证、证据、边界骨架；本阶段明确写“设计评审”，不能带 QA PASS/ship 批准。全页零表格。

采用本地 Mermaid flowchart + ER，各图独立 svgId。任务指定浅色系统字体、零外部依赖和单 nonce script，覆盖通用 diagram-design 的远程字体/手绘布局建议。brainstorm/codex-design-review 没有发现同名本地 SKILL 文件，按注入合同手工执行研究和 request-review，不以缺少 slash tool 停止已授权工作。

## R1 补核

本轮只读项目 registry，仅输出部门标识和是否有 Linear 绑定，没有输出作者名或凭据。当前目标项目部门包含 engineering/product/infra/带项目前缀的 triage；同一部门可对应多个 Lead。显示映射据实补齐，身份允许集合仍从 resolveLeadDepartment 派生，取消额外 ASCII slug 限制。

show/clear 的 UUID 形式仅访问本项目已存记录，可在 Linear 不可用时清理本地判断；网页仍须等待下一次成功生成，不能承诺实时清除已托管快照。
