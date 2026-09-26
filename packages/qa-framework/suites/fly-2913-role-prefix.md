# FLY-2913 逐角色固定前缀 — 529 验收套件
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-26
基于: [当前 design-correction C6](../../../engineering/doc/FLY-2913-role-prefix/design-correction.md#c6--顺序实施与验收矩阵)；原 plan 的角色内容与测量定义保留为历史验收依据。

本轮落实已批准的 DAG 模板版本切换，不是执行回执。五角色为 `design`、
`implement`、`qa`、`review-design`、`review-code`。前缀内容的节省复用 Lead 提供的
QA@2：implement -11.3%、QA -10.1%；交卷关联原始 receipt 与 SHA，不重新测省量，
也不把它算成本轮版本链通过。inventory/weekly/context-probe 不能代替真实消费者
与 C6 的发布、回退、pinned run 和 session 证据。

## 装房与身份前置

由 Lead 或已获授权的沙箱外载体从被测 worktree 执行标准装房命令，参数为
`bash scripts/test-deploy.sh 1 --generalized --expect-head <完整40位SHA>`。
实际槽号以 Lead 当前分配为准；不传 `--stub-runner` 或 `--codex-runner`，不自行
起拆房。每次部署先推送并向 Lead 提交完整 SHA，房间存续期间保持被测头不变。

执行前核验 room-info、`/health` 的 buildSha/artifactBuildSha、当前 checkout HEAD
一致，runnerMode=real，slot-local 目录与凭证路径符合 529 路书。测试请求只发往
该房的 loopback Bridge，使用该房私有 token，不打印 token 或完整 env。保留
slot lease/owner、runId、executionId、activationId、sessionId；未知身份拒绝继续。
需要数据库副本时使用受管 snapshot 命令，不复制 live DB。

原 `qa-529-generalized-e2e.mjs --real` 不能直接充当本套件：其
`buildGeneralizedStartRequest` 固定 `implement: {model: "codex"}`，只能证明
Codex 实现，不覆盖 Claude implement。它还驱动完整九步流程，不能为本单采样
顺手走 ship。专项 driver 必须按以下两个独立且串行的任务组启动真实消费者，
在本套件需要的阶段收集证据，交给既有控制器处理阶段边界。

| 任务组 | 受测路径 | 需要保存的生产者证据 |
|---|---|---|
| Claude 作者 | Claude design、Claude implement；Codex 反向评审 | 已授权 runs/start 的现有 model overrides、parsed pinned snapshot、实际 claude-tmux 启动记录；反向评审保留原技能与 companion |
| Codex 作者 | Claude QA、Claude design-review、Claude code-review | Codex 作者的持久 execution 与 review request；QA 使用 pinned phase；两个 Claude reviewer 使用持久 job.review_type，经真实 ClaudeReviewRunner 启动 |

任务组分别用已授权的 sandbox issue/run，顺序执行并释放负载，不启动五具并发模型。
不能为凑五个角色而把同一家族作者/QA 组合绕过现有门禁，不能手工插入执行或评审行。
reviewer 的原有 print 载体保留，普通 runner 的 tmux 载体保留。

engineering 身份只从 parsed pinned run 的 `tpl_code` / `tpl_simple_code` 推导；
实际选择来自同一 snapshot 中作者节点的 `prefix_profile` / `review_prefix_profile`，
两字段独立，缺失各自为 legacy，不查询当前模板指针来决定已有 run 的配置。
不新增 `prefixTaskSet` payload，不以角色名、标题、标签或 prompt 文本推断。非工程
及无 template 的现有来源必须留在 legacy。Lead 配置、模型、effort、认证、权限、
HOME、Codex 配置和 skill arm 均保持，不能用换 home 或 bare 模式降低测量值。

## 历史内容验收：每角色三组配对测量

以下保留原角色内容验收口径，供核对 QA@2 来源；本轮不重测省量。原验收先采真实
legacy 基线和加载清单，再确定移除项；每角色至少三个独立新 session 的
legacy/role-v1 配对。配对保持 CLI binary/version、model/effort、项目、任务摘要、
权限、skill arm、载体和 cwd 一致。允许实现前后 SHA 与 settings/profile 摘要不同，
差异必须入证据。每次捕获模型首轮之前的加载元数据，后续工具展开单列，不能混成首轮。

1. 从实际 consumer 的最终 argv/settings/角色 prompt 及 pinned 身份取得来源清单。
   不把另起一个缺角色 prompt 的 print 探针标成普通 runner 基线。
2. 保存 `/context all` 或等价原生 structured context、`/skills`、`/mcp`、init 工具
   清单及 system/append snapshot 的去敏证据。MCP 等待结束后再次核对名单与状态，
   pending/failed/needs-auth、来源漂移和采样超时均使该样本未完成。
3. 分离 system/role、builtin、MCP 已加载与 deferred roster、skills/agents、
   rules/memory、hook context 及残差。插件作为来源维度，不重复加总。任务、历史、
   reserved output、auto-compact/free space 不计固定前缀。
4. 当前 CLI 未提供的逐 builtin、hook 与 roster 成本用同条件受控消融补齐；未知为
   null。deferred schema 潜在展开估值不加进已发送前缀。标明 diagnostic-estimate，
   不声称 provider billed exact。只改变一个来源并保留身份/差额证据。
5. 每来源记录规范 ID、版本/hash、loaded/advertised/deferred、token/占比、七天
   调用数、requiredBy、keep/remove 原因；未测或未裁决项不能算完整。低频必需能力
   按角色合同及技能传递依赖保留，不能因七天零调用删除。
6. 用 `qa-2913-prefix-inventory.mjs` 生成 JSON/CSV，核三组配对、组件加总与总数、
   p50/range/delta。该校验只证明数据结构与算术；另附真实控制和任务回执。

## 五角色代表任务

| 角色 | 任务与成功判据 |
|---|---|
| design | 对 sandbox 小变更读代码、查文档、使用所需设计技能、生成 Mermaid/HTML 并以浏览器验证；真实 design-review 请求及阶段完成 receipt 成功 |
| implement | sandbox 缺陷用真实失败测试→最小修复→相关绿测试；Read/Edit/Write/Bash、TDD/debug、Context7、浏览器能力实际必要使用，原 Codex code-review 路由成功 |
| qa | 检查预置 UI/后端故障，Chrome/Playwright 操作及截图，明确负控 FAIL；修复后 PASS，独立 QA receipt 与同一被测头/任务绑定 |
| review-design | Codex 作者计划含预置且可证的缺陷，真实 Claude reviewer 给出 CHANGES_REQUESTED；修正后同 session reround APPROVED，plan blob 与结构化 verdict 可验证 |
| review-code | Codex 作者 diff 含真实错误与失败回归；Claude reviewer 看 diff、运行相关测试并识别错误；修正后新 head 获有效 verdict，不能复用旧 head 的批准 |

每次保留去敏行为链、工具请求/结果状态、必要技能调用身份、artifact 摘要、结构化
verdict 和注册路由回执。`回复 OK`、进程 exit 0、模型总结、空 transcript、命令
被拒绝都不能代替任务成功。原内容验收要求缺工具/技能后修补配置，重跑该角色全部
配对及任务；本轮若发现缺项，按 C6 记录失败，不擅改已验 role-v1 内容。

## 模板候选、发布与指针回退

按 [design-correction C3/C4](../../../engineering/doc/FLY-2913-role-prefix/design-correction.md#c3--移除-flagstore-切换与启动意外启用)
在授权房间保存两份完整 GET 响应：`/api/workflow/templates/tpl_code` 与
`/api/workflow/templates/tpl_simple_code`。响应使用 `template.current_published_revision`
与 `current_revision.{template_id,revision,manifest,manifest_digest}`。先构建
`flywheel-config`，再用以下离线命令生成完整候选；输出目录必须全新且父目录已存在：

```sh
node scripts/prepare-2913-prefix-revisions.mjs --code "$PREFIX_CODE_GET" --simple-code "$PREFIX_SIMPLE_GET" --out-dir "$PREFIX_CANDIDATES"
```

输出 `tpl_code.role-v1.json`、`tpl_simple_code.role-v1.json` 和 `before.json`。
后者的 `templates.<templateId>` 保存旧 revision、canonical manifest digest、原始
响应文件 SHA-256 与候选 digest。生成器逐模板校验身份、当前版本及原始摘要，保留
完整 model/effort/handbook/edge/loop/tier preset，只添加两个 profile 字段；不写
数据库、seed 或当前指针。发布仍由现有受管入口校验完整 manifest。

design/implement/qa 均声明 `prefix_profile=role-v1`，包括默认 Codex 节点，以便
受管 vendor override 后由 Claude 消费。三者也声明 `review_prefix_profile=role-v1`：
现有 `/review-requests` 入口与 `ReviewRequestCoordinator.accept` 以真实 session、
worktree、vendor、reviewType、执行所属 gate/head 为守卫，没有按作者 QA 阶段禁止
code review；`resolveWorkflowReviewRouteForExecution` 从固定 runtime 的 vendor/model
选 reviewer。故 QA 经已有 Codex 作者路径可消费该字段；此声明不增加路由或评审权限。

以下变量从保存响应、`before.json`、实际发布 receipt 与 room-info 读取。
`FLYWHEEL_BRIDGE_URL` 必须指目标房间；生产操作须由获授权操作方执行。不要使用
`--from seed` 覆盖 founder 编辑；bundled seed 缺字段保持 legacy，安装或重启不启用。

```sh
node "$FLYWHEEL_COMM_CLI" workflow-template publish --template tpl_code --from file --file "$PREFIX_CODE_MANIFEST" --expected-revision "$PREFIX_CODE_BEFORE_REV" --expected-digest "$PREFIX_CODE_BEFORE_DIGEST" --operation-id "$PREFIX_CODE_PUBLISH_OP" --reason 'FLY-2913 node prefix role-v1'
node "$FLYWHEEL_COMM_CLI" workflow-template publish --template tpl_simple_code --from file --file "$PREFIX_SIMPLE_MANIFEST" --expected-revision "$PREFIX_SIMPLE_BEFORE_REV" --expected-digest "$PREFIX_SIMPLE_BEFORE_DIGEST" --operation-id "$PREFIX_SIMPLE_PUBLISH_OP" --reason 'FLY-2913 node prefix role-v1'
node "$FLYWHEEL_COMM_CLI" workflow-template rollback --template tpl_code --revision "$PREFIX_CODE_BEFORE_REV" --expected-revision "$PREFIX_CODE_ROLE_REV" --expected-digest "$PREFIX_CODE_ROLE_DIGEST" --operation-id "$PREFIX_CODE_ROLLBACK_OP" --reason 'FLY-2913 regression rollback'
node "$FLYWHEEL_COMM_CLI" workflow-template rollback --template tpl_simple_code --revision "$PREFIX_SIMPLE_BEFORE_REV" --expected-revision "$PREFIX_SIMPLE_ROLE_REV" --expected-digest "$PREFIX_SIMPLE_ROLE_DIGEST" --operation-id "$PREFIX_SIMPLE_ROLLBACK_OP" --reason 'FLY-2913 regression rollback'
node "$FLYWHEEL_COMM_CLI" workflow-template status --operation-id "$PREFIX_CODE_ROLLBACK_OP"
```

每个操作使用新唯一 UUID；丢失响应先查同 operation ID 的 status。409 后重新读取并
比较，不自动覆盖并发编辑。两模板各自独立事务，分别保存 before、publish 和 rollback
receipt。回退必须先核目标 manifest 两字段缺失或 legacy，不能假定“上一号”等于
legacy；receipt 的 published_revision 必须等于目标旧 revision，revision 行数和
原文保持不变。指针回退只影响新 run，不迁移或重钉正在跑的 role-v1 run。

二进制回滚是另一项受管操作：先把两个模板当前指针回退至已核验的 legacy revision，
然后核实没有 active/held 的 role-v1 run（包括等待阶段恢复或评审的 run），才可考虑
回滚旧 binary。旧 parser 可能不支持新字段；满足此项前置不替代既有二进制发布守卫。

## 本轮 C6 版本链验收

完整矩阵以 [design-correction C6](../../../engineering/doc/FLY-2913-role-prefix/design-correction.md#c6--顺序实施与验收矩阵)
为准。本套件沿用上面的五角色代表任务，每角色至少一次真实必要工具调用，另外保存：

- R0 起跑 A；发布 R1 后起跑 B：A snapshot 不变，B 固定 R1 且最终 Claude settings
  为 role-v1。A 的后续节点、retry/resume 和关联 review 都继续 R0 legacy。
- B 活跃时回退指针至 R0，再起跑 C：B 后续节点和 reviewer 仍 role-v1，C legacy
  settings 与基线逐字节一致；current pointer、revision 行数和旧 bytes 符合回退合同。
- Codex 作者的 design/code review、land content review、同 session reround 与新
  session fallback 都按作者固定版本；独立 profile 字段和双向 vendor override 生效，
  Codex/Lead 的 argv/settings 不变。核对 run snapshot、execution runtime、实际 stamp
  的 templateId/revision、nodeId、selectionSource、effectiveProfile 与 settings hash。
- 旧 role-v1 会话同 session 恢复时复用可核验 settings/hash；不匹配不能报同版本成功；
  新 session 沿历史无字段 snapshot 使用 legacy。遗留 DB/env 值不影响选择。
- 过期 token、digest/registry/CAS 冲突、retired/丢失目标、不安全 active run 均拒绝且
  无半提交；断响应可 status 恢复、同 operation 幂等；重启 seed/migration 不覆盖指针。

## 控制测试与回退

- 内置 `--tools` 生效；`allowed-tools` 的权限语义保持。必要工具/技能成功调用，
  被移除工具/技能既不 advertised 也不可调用。无效 settings 负控要检测为未生效。
- 非插件 skillOverrides、混合插件副本 namespace、manifest 组件引用、相对 assets、
  hooks 恰好一次和 source hash 均验证；不得把整个混合包保留当作完成选定加载。
- strict MCP 下每个必要 server 恰好一个，真实调用成功；无关 server 不出现。
  managed 来源不可排除，无法控制的成本单列。
- 必要能力被删、no-chrome 与 browser 必需冲突、产物/来源/身份漂移都必须拒绝
  role-v1；unknown role/backend、full-mcp、非工程/无 template 保留原 legacy 能力。
- 新建、retry、standby resume、review reround/fallback 和 land-content-review
  分别证明 session stamp 行为；不能从同一 prompt 内容推导 reviewer 身份。
- 子代理独立采 inventory；父配置正确不证明子代理继承正确。
- Lead settings/argv 与 Codex 配置做前后相同的负控。会议/小红书/Sub nightly/806/
  自定义来源不映射为 engineering，仍能加载其原能力，不对外部账户执行写操作。
- 配置只按固定模板 revision 的节点字段消费，遗留全局 flag/env 无消费者。指针回退
  后只有新 run 恢复 legacy；已有 run 的新节点、新 session 与评审仍使用原 snapshot。
  活会话不热变，不能把只改指针或 store 行当作消费者回退成功；超时/启动失败不能造 PASS。

## 退出条件与证据

本轮 C6 的版本链、五角色真实任务、控制与回退全部通过，才可交付模板发布方案。
PR 附本轮 receipt、回退实证、原始证据摘要和局限；省量与角色内容复用 QA@2 的
原始 receipt/SHA 和 before/after 表，不冒称本轮重新测量或 boot 默认启用。
任何本轮验收缺项都不交付；本套件文本、局部测试和 CI Scope OK 不构成这些证据。
独立 QA 负责其 frozen-head full CI，implement 不因此请求 full CI、派发 QA 或 ship。

按 529 路书保存前后生产快照及 slot ledger；boot isolation 不等于全部宿主零写。
测量完成后请拥有该房的受监督载体执行标准 teardown 并保存归档回执。实际采样目录、
owner、完整 SHA、角色 session 列表与每项 PASS/FAIL/未测由执行者填入单独结果文件，
不修改本套件把缺失结果改成 PASS。
