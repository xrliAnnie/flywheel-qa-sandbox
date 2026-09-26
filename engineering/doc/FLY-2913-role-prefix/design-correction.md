# FLY-2913 前缀随 DAG 模板版本 — 实施计划
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913/token8-给-claude-runner-评审-qa-各配精简固定前缀逐角色只加载真正用到的工具插件mcp-与规则)
日期: 2026-09-26
基于: research.md、plan.md

## 给 founder 的说明

每个任务起跑时领一份固定的节点说明。发布新版只影响以后新任务；发现回归时，一条受管命令把模板指回旧版，在跑任务继续按自己的版本做完。DAG 是任务各步骤及先后关系；模板版本是这份流程和节点说明的不可变存档。

已有精简内容与能力不改：隐藏部分非插件技能描述、排除不适用规则，技能仍能调用。保留角色能力清单、0600 私有配置文件、安全限制和既有测量。Lead 提供的 QA@2 结论为 implement -11.3%、QA -10.1%，属于前缀内容的历史验收，本次版本切换尚待实现与验收。

## 版本与边界

本节替代旧 FlagStore / env / 每启动重新选择全局 mode 的合同。revision 是模板内递增的版本号；profile 是节点指定的说明配置，只有 legacy（原配置）与 role-v1（已验精简内容）。当前 revision 指针可后退，revision 行和 run snapshot 不可修改。snapshot 是 run 起跑时保存的完整流程与说明；digest 是内容校验值。

不增加生产全局开关、payload 字段、Lead 规则、第二份 profile registry 或可热变的共享节点 Markdown 设置。不修改已验 profile 列表/工具能力/原 settings 合并顺序。现有 tpl_code / tpl_simple_code 是本次 rollout 唯二模板；其他模板保持原样。后续扩大范围需另外授权。

## C1 — 节点字段与不可变来源

修改 `packages/teamlead/src/workflow-template.ts` 的 WorkflowManifestNode、v1 validator、v2/v3 exact-key validator 及所有节点重建分支；增加两个 optional 字段：

```ts
prefix_profile?: "legacy" | "role-v1";
review_prefix_profile?: "legacy" | "role-v1";
```

- `prefix_profile` 控制本节点的 Claude runner；仅 design/implement/qa 类型可声明。
- `review_prefix_profile` 控制服务本节点的跨家族 Claude reviewer（design/code），允许 Codex 作者节点声明；不传到 Codex runner adapter。reviewType 仍由持久 review job 决定，不能用配置更改评审路由或权限。
- 两字段为独立选择，缺失逐个按 legacy 解释。null、未知字符串、非字符串拒绝。gate/land/generic/review 等当前不支持类型拒绝带字段，勿把配置误作能力授权。
- v1/v2/v3 同时支持这两个 optional 字段；缺失时 validator 输出必须仍缺失，禁止为旧 manifest 补 legacy。既有 manifest/snapshot digest 保持字节兼容。
- `workflow-menu.ts` / `workflow-template.ts` 的 model/effort override 不能接受 profile；模型路由换 vendor 后保留节点原意图，只有最终 Claude consumer 应用。Codex→Claude 时不能漏掉配置，Claude→Codex 时不能触及 Codex settings。
- 新候选工程模板的 design/implement/qa 节点均声明 prefix_profile=role-v1（含目前默认 Codex 的节点，仅 Claude 分支消费），design/implement 节点声明 review_prefix_profile=role-v1，qa 如可触发既有 code review 也声明该值。这样模型覆盖不改变版本意图。非工程模板不推断。

`workflow-run-snapshot.ts` 两 materialization 分支保留新增 manifest 字段，继续纳入 manifest_digest/snapshot_digest。不向 resolved.nodes 或顶层镜像 profile，避免两处不一致。parser 必须通过更新后的 pinned manifest validator；沿旧版本 strict digest 验证。`workflow-prefix-context.ts` 在已核验 execution runtime/run/template/revision/snapshotDigest/nodeId 后，从 snapshot.manifest.nodes 精确 nodeId 读取字段；返回 workflow.templateRevision 与声明值。禁止查询 template.current_published_revision 来决定已有 run 的配置。

兼容：历史 run 缺字段的新 launch 为 legacy，不受遗留 FlagStore 行影响。不回填或重钉旧 snapshot。已有活会话不热改；升级前已经以 role-v1 启动的会话保留已写 launch stamp/对应 settings 直至会话结束，同 session resume 优先复用可核验的既存 settings，不以缺字段改写它。旧 stamp 没有 revision 时用 runtime→run 补充审计关联，不反写历史文件；绑定不匹配或文件 hash 不一致时不得声称延续成功，使用既有恢复失败渠道，不能默默改配置接着声称同版本。新 session/后续节点仍按历史 snapshot 缺字段=legacy；这是一条明确的迁移边界，不把 pre-contract 的全局开关决定虚构成 run 钉版本。

## C2 — 普通 runner 与所有评审消费

改 `packages/config/src/runner-prefix-profile.ts`：mode 输入改为服务端已封存的节点枚举；保留 Lead/non-Claude/unknown/full-mcp guard、工程模板范围与角色识别。删 `{hasOverride,raw}` 输入，不能保留 env/store fallback。`RunnerPrefixWorkflow` 增 `templateRevision: number`（正整数）。请求仍不能从 runs/start body 声明 prefix。

改 `packages/teamlead/src/bridge/run-dispatcher.ts`、`run-infra.ts`：去掉 runnerPrefixProfileControl，Claude launcher 在已持久绑定后调用统一 workflowPrefixLookup。核查 entry、workflow-engine-dispatcher、actions、DirectEventSink、retry/admission replay、resident resume 都最终走该 lookup；不把同一个字段逐入口抄进请求。先做 backend guard，Codex/Lead 不查询 prefix。

改 `bridge/review-prefix-profile.ts`、`plugin.ts`、`review-request-coordinator.ts`、`land-content-review.ts`：移除 store mode 参数。以 job.execution_id 或 land review 传入的提交 executionId 查 runtime→run→作者节点，使用 review_prefix_profile，独立于作者 vendor。评审角色只来自持久 reviewType；普通 runner 的 prefix_profile 不代替 review_prefix_profile。初轮、同 session reround、新 session fallback、land content review 均使用作者 run 的 revision。无绑定/不支持角色保持 legacy，记录原因；校验失败不绕过实际 review、更不伪造 APPROVED。

复审不应因当前模板发布改变 mode。role-v1 配置内容/编译器保持本轮基线；新增 revision 元数据可改变 profileDigest，但生成的有效 settings 必须与旧实现对同一输入逐字节相同。现有下层 settings/user rules 本来是启动时读取；本单钉住的是 profile 选择，不承诺把整个 Claude 安装、插件目录或外部规则历史归档。未来若改 role-v1 内容必须引入新 profile 版本，不原地改变 role-v1 含义。

## C3 — 移除 FlagStore 切换与启动意外启用

逐项移除生产 `runner_prefix_profile` registry、store codec、storeRunnerPrefixProfile wrapper、run-infra/plugin read-site；更新 `packages/config/src/feature-flags/{registry,store-policy}.ts`、`packages/teamlead/src/bridge/flag-store-runtime.ts`，对应 registry/drift/store/dispatcher/review 测试同步修改。旧 DB 行与审计历史保留但无消费者，feature-flags set 此名应报未知 flag；不要删除 DB 数据、不增加 exemption。删除 env metadata 与初始化种子路径，遗留 env/DB 值不能影响选择。

`packages/qa-framework/suites/fly-2913-role-prefix.md` 及本单脚本中“seed-project-flags 启用”步骤改用模板发布；全仓搜索并逐条处置旧入口，区分错误标签 `runner_prefix_profile:` 与真正开关消费者，不盲改诊断字符串。

不通过 boot seed 自动给既有系统启用。为 tpl_code/tpl_simple_code 导出当前 manifest 成完整候选文件，只增加上述字段，保留已有模型、节点、handbook、edge、loop、tier preset。由实施/QA 在授权环境发布文件候选；不要用 `--from seed` 覆盖 founder 已编辑模板。本单可交付一个窄的候选生成器 `scripts/prepare-2913-prefix-revisions.mjs`：输入两份现有模板 GET 结果，验证 template ID / current revision / digest，输出每模板完整 manifest 与 before metadata；只读输入与写输出，不接 DB、不执行发布。默认 bundled seed 保持 legacy，未来初始化环境要启用也显式发布，避免安装/重启即变更现有行为。

## C4 — 发布与真正的指针回退

新发布沿现有 workflow-template publish→stage/apply→createAndPublishWorkflowTemplateRevision，run 起跑采用当时 current revision。复用 loopback/same-origin、bounded JSON、确认令牌、source digest、模型 registry/build generation、migration guard、事务 CAS、operationId receipt；不新增并行发布系统。

现有 rollback 会 clone 旧 manifest 为新 revision，必须改为指回历史 revision：`workflow-template-publication.ts` 的 apply 按 sourceKind=rollback 分支调用 StateStore 中扩展的受管历史发布事务（可命名 publishHistoricalWorkflowTemplateRevision）。它不能直接调用缺少完整守卫的旧 publishWorkflowTemplate。

事务必须：

1. 同 operationId + 同 requestDigest 返回原 receipt；异内容冲突。校验目标 template/revision 存在且不可变 digest 等于 stage 冻结的 sourceDigest；目标与 canonical manifest 一致，不能改历史 bytes。
2. 检查 template 未 retired、expectedRevision + expectedDigest 同时相符、当前 registry 未变、历史模型仍可运行。保留 active/held run 全部安全 dispatchPinned 检查；异常明确拒绝，不重钉 run。
3. 同事务插 publication、audit、publish_receipt 并 CAS current_published_revision 为目标历史 revision；设 seed_owner=founder，保留 managed publication 识别使旧启动迁移无法覆盖。SQL 全部参数绑定。
4. receipt.published_revision=目标 revision，source_kind=rollback；before/after/source digest、actor/reason/operationId 与 sourceRevision 的可查询关联完整。若现有 receipt 没有 sourceRevision 列，audit.detail 保存 sourceRevision，receipt 的 published_revision 就是它。不能先改指针后补审计。
5. 不新增 workflow_template_revision 行，不更新任何 run/template revision 原文。失败回滚整个事务。相同目标可形成一次明确 no-op 审计，但不能重复插入同 operation receipt。

CLI 保持现有参数形状；更新 help/测试/既有文档对 clone 语义的描述。查所有调用 rollback 的脚本、测试、文档；旧其他模板调用的变化必须覆盖兼容测试。发布不同模板是两个独立事务，不能谎称跨模板原子切换；每个模板各有 before 与回退 receipt。

### 可执行操作配方（实施/QA 使用，本 design 不执行）

先 GET `/api/workflow/templates/tpl_code` 与 `tpl_simple_code`，保存完整响应、current revision/digest。候选工具产出 `tpl_code.role-v1.json`、`tpl_simple_code.role-v1.json`。以下变量来自保存响应与房间 room-info，绝不能凭空填 revision；`FLYWHEEL_BRIDGE_URL` 必须指目标房间，生产发布由有授权的操作方执行。

```sh
node "$FLYWHEEL_COMM_CLI" workflow-template publish --template tpl_code --from file --file "$PREFIX_CODE_MANIFEST" --expected-revision "$PREFIX_CODE_BEFORE_REV" --expected-digest "$PREFIX_CODE_BEFORE_DIGEST" --operation-id "$PREFIX_CODE_PUBLISH_OP" --reason 'FLY-2913 node prefix role-v1'
node "$FLYWHEEL_COMM_CLI" workflow-template publish --template tpl_simple_code --from file --file "$PREFIX_SIMPLE_MANIFEST" --expected-revision "$PREFIX_SIMPLE_BEFORE_REV" --expected-digest "$PREFIX_SIMPLE_BEFORE_DIGEST" --operation-id "$PREFIX_SIMPLE_PUBLISH_OP" --reason 'FLY-2913 node prefix role-v1'
node "$FLYWHEEL_COMM_CLI" workflow-template rollback --template tpl_code --revision "$PREFIX_CODE_BEFORE_REV" --expected-revision "$PREFIX_CODE_ROLE_REV" --expected-digest "$PREFIX_CODE_ROLE_DIGEST" --operation-id "$PREFIX_CODE_ROLLBACK_OP" --reason 'FLY-2913 regression rollback'
node "$FLYWHEEL_COMM_CLI" workflow-template rollback --template tpl_simple_code --revision "$PREFIX_SIMPLE_BEFORE_REV" --expected-revision "$PREFIX_SIMPLE_ROLE_REV" --expected-digest "$PREFIX_SIMPLE_ROLE_DIGEST" --operation-id "$PREFIX_SIMPLE_ROLLBACK_OP" --reason 'FLY-2913 regression rollback'
node "$FLYWHEEL_COMM_CLI" workflow-template status --operation-id "$PREFIX_CODE_ROLLBACK_OP"
```

UUID 使用新生成的唯一 operation ID；丢失响应先 status 同 ID，不盲目重发新操作。409 则重新读取、比较差异后作新的决定，不自动重基并覆盖并发编辑。回退先核目标 manifest 两字段缺失/legacy；不是任意“上一号”都等于 legacy。回退当前指针不迁移任何既有 run；role-v1 run 继续 role-v1。二进制回滚是另一个操作，旧 parser 可能读不懂新字段，不属于此一步回退保证。

## C5 — 查到的是实际配置，而非期望值

拓展 `packages/config/src/runner-prefix-profiles.ts` 的 stamp 及 TmuxAdapter / claude-review-runner 现有 per-session 私有 stamp：templateId、templateRevision、snapshotDigest、runId、nodeId、executionId、session/request identity、selectionSource（prefix_profile/review_prefix_profile/historical-session）、requestedProfile、effectiveProfile、fallbackReason、settingsSha256。继承现有 profileDigest 与编译器版本，不记录 credential/prompt 正文。

有效 legacy（缺字段/full-mcp/compile error）也要可查：在已有 launch receipt 或独立 metadata 文件记同样身份与 legacy 原因，不能为了 stamp 让 legacy argv/settings 改字节。role-v1 私有文件写失败的既有 legacy fallback 保留，但必须把 effectiveProfile=legacy 写入已存在的结构化启动日志/receipt；不能保留一条 role-v1 成功 stamp 误报应用成功。身份无法验证时相应字段 null + provenance-error，不编造 revision。审计落盘失败明确可观测，不假装通过验收。

查证顺序：模板 GET 返回 current revision；run 的持久 snapshot 返回 pinned revision + 节点配置；execution runtime 确认 node 绑定；session stamp/启动 receipt 对照有效 settings hash。只读这四项即可区分“当前模板”“这个 run 固定版本”“这次实际加载”。不要以模板配置存在代替最终 consumer 证据。

## C6 — 顺序实施与验收矩阵

C1 红测试→最小校验/快照实现→单文件绿→提交；C2 持久绑定测试先红，再接 consumer；C3 删除开关并让 drift/registry 转绿；C4 pointer rollback 事务测试先红，再实现；C5 stamp/fallback 测试先红；最后在 Lead 管的 529 房跑 C6。每步仅跑改动有关文件，零测试命中算失败，不跑整包测试。

| 验收 | 必须观察到的证据 |
|---|---|
| 旧模板 R0 起跑 A，发布 R1 后起跑 B | A 的 snapshot/revision 不变；B 为 R1；B Claude design/implement/qa 实际 settings=role-v1 |
| 发布 R1 后，A 后续节点、retry/resume 与关联评审 | 全部沿 A 的 R0=legacy；不能只验证已经运行的进程没变化 |
| R1 run B 活跃时回退指针到 R0，再起跑 C | 模板 pointer=R0；revision 行数/旧 bytes 不变；B 后续 Claude 节点与评审仍 role-v1；C legacy 与基线 settings 字节相同 |
| Codex 作者触发 Claude review-design/code，land content review | reviewer 根据 review_prefix_profile 与作者 revision；初轮/同 session reround/新 session fallback 均一致；Codex 作者 argv/settings 无变化 |
| 独立字段、最终 vendor 覆盖 | runner=legacy/review=role-v1 与反向 fixture；Codex→Claude 生效，Claude→Codex 不消费；Lead 与 Codex 有读取 spy=0、argv/settings byte-equal |
| 新旧 schema / 不可信输入 | v1/v2/v3 缺字段历史 digest 保持；两字段非法/错误节点拒绝；payload/override 不能注入；绑定错位拒绝/legacy 原因可见 |
| 529 五角色任务 | 复用已验代表任务定义；每角色至少一次真实必要工具调用成功；版本字段已进入实际 settings/stamp；不靠一句 OK 或单元 mock |
| 旧历史会话迁移 | 旧 role-v1 settings+hash 同 session 恢复；hash 不符不能报同版；新 session 使用无字段 snapshot=legacy 的边界有明确 receipt |
| rollback 负控 | 过期 token、digest/registry/CAS 冲突、retired、丢失目标、不安全 active run：无半提交；断响应 status 恢复、同操作幂等；重启 seed/migration 不覆盖 pointer |
| 去开关与节省复用 | 遗留 DB/env 无影响；漂移测试绿；role-v1 实际 settings 对旧实现字节相同。关联 QA@2 原始 receipt+SHA（implement -11.3%、QA -10.1%），不重测省量、不冒称新版本链已通过 |

相关测试命令（已核实文件名；新测试放同文件）：

```sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template.test.ts src/__tests__/workflow-menu-snapshot.test.ts src/__tests__/workflow-prefix-context.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template-publication-service.test.ts src/__tests__/workflow-template-publication.test.ts src/__tests__/workflow-template-publication-routes.test.ts src/__tests__/StateStore.workflow-templates.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/run-dispatcher-prefix.test.ts src/bridge/__tests__/review-prefix-profile.test.ts src/bridge/__tests__/claude-review-runner.test.ts src/bridge/__tests__/review-request-coordinator.test.ts src/bridge/__tests__/land-content-review.test.ts
pnpm --filter flywheel-config exec vitest run src/__tests__/runner-prefix-profile.test.ts src/__tests__/runner-prefix-profiles.test.ts src/__tests__/feature-flags-registry.test.ts src/__tests__/feature-flags-drift.test.ts src/__tests__/feature-flags-store-policy.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/workflow-template-cli.test.ts
pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts
```

上述 filter 已按 package.json 核实；新 candidate generator 加只读 fixture 测试，改动的 flag-store-runtime/Blueprint 单文件测试也执行。不需要 design 节点跑上述实现测试。

房间：先核房位；申请给 Lead 冻结完整 SHA 和按 scripts/test-deploy.sh 真实参数生成的完整命令；不在 Codex 沙箱起拆房。拆房前导出房内相关 DB 行集再 ask Lead；不能 cp 活 DB。PR body 重写为最终 DAG revision 切换方案，保留旧内容 QA 的准确来源，列新 C6 回执与旧 QA@2 复用范围。交卷先 push 再 complete。

## 设计交付证据

本轮仅文档修改：exploration/research/plan 修订 + 本 appendix + founder report 与评论层；通过新显式 design review 后提交/推送、静默发布、验 hosted/CSP/source 并 report Lead，最后 phase_design_complete + park。旧 R2 APPROVED 不算本轮通过；本轮 gate receipt 记 validation-revision.md。无实现/生产发布/529 结果冒称。
