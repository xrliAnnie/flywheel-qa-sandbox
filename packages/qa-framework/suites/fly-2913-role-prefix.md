# FLY-2913 逐角色固定前缀 — 529 验收套件
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: ../../../engineering/doc/FLY-2913-role-prefix/plan.md

本套件落实已批准计划及 plan §六的 Lead 裁定，不是执行回执。五角色为
`design`、`implement`、`qa`、`review-design`、`review-code`。当前专项真实模型
driver 尚未完成；已有 inventory/weekly/context-probe 工具不能代替它。

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

engineering 身份只从 parsed pinned run 的 `tpl_code` / `tpl_simple_code` 推导。
不新增 `prefixTaskSet` payload，不以角色名、标题、标签或 prompt 文本推断。非工程
及无 template 的现有来源必须留在 legacy。Lead 配置、模型、effort、认证、权限、
HOME、Codex 配置和 skill arm 均保持，不能用换 home 或 bare 模式降低测量值。

## 每角色三组配对测量

先采真实 legacy 基线和加载清单，再确定移除项；每角色至少三个独立新 session 的
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
被拒绝都不能代替任务成功。缺工具/技能后修补配置，重跑该角色全部配对及任务。

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
- `FLYWHEEL_RUNNER_PREFIX_PROFILE=legacy` 在新 session 恢复原 inventory。运行中的
  slim session 不热变；实际回退通过既有受监督恢复流程保留进度并取得新 session
  receipt。只改 env 不能称回退成功，超时/启动失败不能造 PASS。

## 退出条件与证据

五角色三组配对和逐项 keep/remove 清单齐全、真实任务与全部控制通过后，才可进入
T6 默认启用。PR 附 before/after 表、各角色任务 receipt、回退实证、原始证据摘要和
局限。任何角色缺项都不交付；本套件文本、局部测试和 CI Scope OK 不构成这些证据。
独立 QA 负责其 frozen-head full CI，implement 不因此请求 full CI、派发 QA 或 ship。

按 529 路书保存前后生产快照及 slot ledger；boot isolation 不等于全部宿主零写。
测量完成后请拥有该房的受监督载体执行标准 teardown 并保存归档回执。实际采样目录、
owner、完整 SHA、角色 session 列表与每项 PASS/FAIL/未测由执行者填入单独结果文件，
不修改本套件把缺失结果改成 PASS。
