# FLY-2533 快照阶段协议 — 调研
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: exploration.md

## 结论

B‴ 可在现有 schema 2/3 物化处实现，且能在创建运行记录前拒绝缺协议。必须同时处理二次截断、旧节点文件的直接读取，以及打包资产。单改 `readAgent` 后拼字符串不能证明领域内容、旧入口与客户安装包兼容。

研究基线 `26ebc4931`。当前任务已授权按裁定推进设计，不额外设研究人工审批；本文不是正式 design-review APPROVED 的替代。研究仅使用工作树一手源码；没有外部技术选型，没有访问生产数据库或运行 529。

## 入口与根因证据

| 源码 | 事实 | 设计含义 |
| --- | --- | --- |
| `packages/teamlead/src/workflow-template-selection.ts:109–169` | 分类 `input.taskCategory?.trim() || "*"`；没有 templateId 返回 null | 保持显式绑定；补提示，不增加默认 `*` |
| `packages/teamlead/src/bridge/runs-route.ts:1418–1430` | authKind 由 bearer 与服务器配置比较产生 master/scoped/tokenless | 回显这一结果，不相信 body.authKind，不回显凭据 |
| `runs-route.ts:2600–2605,2881–2903` | freshLegacyEntry 跳过候选选择；非 work-kind 只透传 string 分类 | scoped + category 依然不能新建主流程；不能用提示暗示权限升级 |
| `runs-route.ts:3097–3107` | 409 DAG_ENTRY_NOT_MATERIALIZED 带 silent:false，当前不提示分类 | 响应兼容性要求保留 code/status/silent |
| `packages/teamlead/src/bridge/pipeline-config-source.ts:47` | 默认绑定来自 workflowMenuBindings | `pipeline-config-source.test.ts` 已断言不生成 `*`；保留 |

## 物化、状态和恢复

1. `workflow-menu.ts:505–532` 读取 legacy roster，验证相对路径、文件存在、realpath 在项目根内；目前不比较 qa 与 implement。`projectUsesAgentRegistry:498` 保留非 Flywheel 不建 registry 的通道。
2. `workflow-run-snapshot.ts:276–297` 的 readAgent 限定项目内文件，UTF-8 读取、40,000 JS 字符截断、拒空，然后生成 `canonicalSubmissionDigest(content)`。
3. `buildGeneralizedWorkflowRunSnapshot:406–525` 同时服务 V2/V3。显式 agent_file 与 role/bundled resolution 是两条分支；gate/land 在 462 行提前返回，没有模型执行字段。
4. 正式节点类型由 `packages/config/src/node-type-registry.ts` 声明：design、implement、qa、generic、review、gate、land。`.flywheel/agents/registry.yaml` 把 eng_design 映射为 design，general/pm/product_design/proto 映射为 generic。协议按 type；display label、role、node id 都不是类型或授权依据。
5. `StateStore.ts:28905–29028` 先构建完整 snapshot，再开启写事务；异常可阻止 run/reservation/effect 与 shadow supersession 写入。`workflow-template-selection.ts:449` 返回前 materialize。随后 route 统一返回 409 GENERALIZED_WORKFLOW_REJECTED。
6. `workflow-run-snapshot.ts:592–974` 的 parser 按已固定内容验证 agent digest 和 snapshot digest，明确不查 live registry；不能加入协议必备检测，否则旧运行不能恢复。
7. selection 的 prior reservation 分支（317 附近）和 `recoverWorkflowStartSelection:515` 都使用已固定快照。协议改版不能改写旧 snapshot 或幂等 replay。
8. `manifest_digest` 只覆盖 manifest；agent.digest 覆盖最终 agent.content，snapshot_digest 覆盖 resolved 节点。无需 protocolDigest、schema 版本升级或数据库迁移。

## 消费者完整链

| 消费者 | 当前行为 | 本单处置 |
| --- | --- | --- |
| `workflowNodeAgentContent` / `runs-route.ts:3334,3656` | 从解析后的固定节点获取内容 | 继续只传固定内容 |
| `bridge/run-dispatcher.ts:1079,1805` | 转为 workflowAgentContent，覆盖新启动与恢复 | 不读取实时协议 |
| `Blueprint.ts:2796–2802` | 对 workflowAgentContent 再 slice(0,40_000) | 不改 Blueprint；物化最终长度 <=40,000，协议完整在前 |
| `TmuxAdapter.ts:1220–1246` | appendSystemPrompt 写私有文件，CLI 使用 --append-system-prompt-file | 现有通道回归即可 |
| `CodexTmuxAdapter.ts:1043–1077`；`codex-daemon-adapter-helpers.ts:63` | systemLayer 随 buildGoalKickText 进入首轮文本 | 保持此通道，验证实际发送字节 |
| `codex-home.ts:1988–1999` | AGENTS.md 物化固定 codex-runner-contract | 动态 snapshot 文本当前不写此文件；不按 issue 旧行号误述为已写入 |
| `Blueprint.ts:2812,3406–3457` | legacy 路径直接读取节点 Markdown；支持 matt/bare 文件 | 不能直接删旧节点里的协议而不提供等价兼容产物 |
| `runs-route.ts:2894–2900,4166` | no-three-stage 等路径仍可抵达 legacy dispatcher | 保留旧角色文件可直接消费 |
| `workflow-menu.test.ts:630–641`、shell role-contract tests | 对节点文件字节/段落有直接断言 | 改成源与投影一致性、语义与长度断言，不能简单删测试 |

Codex 通道差异已通过 ask --report 报 Lead；它不改变“用既有通道”这一目标。本文区分源码事实与派发实测：本次没有观察任何真实 Claude/Codex 新启动。

## 协议来源与不重复策略

采用仓内 `packages/teamlead/phase-protocols/{design,implement,qa,generic,review}.md` 作为唯一人工维护的协议源。它不是项目配置，不影响 `.flywheel/config.yaml` schema。

为保留 raw-file legacy 消费者，现有 `.flywheel/agents/nodes/*.md` 中被抽取的协议段作为**生成投影**保留：固定 begin/end 标记内的内容只能由生成器更新，CI 检查其与唯一源字节相同；其他段落仍为领域手册。不再人工维护两个协议版本。

snapshot 读取领域文件后，移除与本节点类型协议**完全相同**的生成块，再前置一次当前协议。去重只比较精确分隔块及精确内容，不靠关键词、文件名或“看起来像 QA”判定；外部手册不需要任何标记。移除块不能豁免协议加载，也不能提高能力。旧文件直接读取仍收到同一协议；新快照只含一份。

该方案比直接删除旧节点段落多一个生成检查，但保持整个 Blueprint 不变，避免另设派发时注入点。拒绝将完整协议当作另一个人工副本；拒绝运行时重读旧快照来追赶最新内容。

## 长度与来源边界

- 40,000 是现有 JS string 字符预算，不是字节或 token。协议与手册均完整保留；合计超限拒绝；最终内容参与两层摘要，与 Blueprint 实际接收片段一致。
- 协议为空/缺失/超限应拒绝，不能裁掉协议。手册经过精确块移除后必须非空。Lead 对报告 d7ec1b82-6f6d-4637-af6f-7ad52735b2cc 明确要求新物化协议+手册总长超过 40,000 就拒绝，禁止截断。此规则只对新物化生效，旧快照解析不变。
- 协议路径来自 Bridge 安装包 import.meta.url 相对目录；不得从目标项目、cwd、请求或 roster 中指定协议目录。测试通过模块 mock/临时 package fixture 模拟缺失，不增加生产配置开关。
- 兼容文件生成器和 loader 不解释手册中的指令或路径。外部内容仅是 agent 数据；认证、capabilities、claim 接纳仍由服务器现有机制决定。

## 打包证据

`packages/teamlead/package.json` 目前 files=[dist,bin]；新协议目录必须显式加入 package files。`scripts/package-onboard.sh:57,635–655` 独立复制 dist 和 PO_PACKAGE_ASSETS，不会自动遵循新增 files；须加 `teamlead:phase-protocols`。`scripts/package-onboard-files.allow` 加五个确切协议文件或该已审计资产目录。loader 使用 `new URL('../phase-protocols/<type>.md', import.meta.url)`，在 src、dist、打包 node_modules 下同形。生成节点文件已在 PO_AGENT_FILES 中；新增生成器仅开发/CI 使用，不必进入运行包。

## 测试与 529 约束

- 单元入口：`workflow-run-snapshot.test.ts` 有 V2/V3、小型临时领域文件、历史 snapshot fixture、摘要与损坏拒绝测试。
- roster：`workflow-menu-registry.test.ts:201–279` 已有无 registry 的非 Flywheel 项目；扩展同文件、symlink/hardlink、缺少可选角色、合法独立文件与越界。
- route：`runs-route.dag-entry.test.ts:657–705,881–939` 有 master/scoped/tokenless、无 binding、显式 opt-out、recovery；harness 含真实内存 StateStore + 可数 fake dispatcher。
- selection：`workflow-template-selection.test.ts:245,411,639,905` 有无写入、幂等 replay、最终退休/改版竞争；缺协议测试不能削弱这些屏障。
- `test-deploy.sh:1199–1226 --generalized` 会创建 registry、复制完整 Flywheel 节点，仅采用 code/generic；原样运行不能证明 B 的无协议领域 roster + simple_code。
- B 必须用 slot-only 非 registry fixture、不同 implement/qa 文件、simple_code 精确绑定、真实 Claude QA（禁 stub）。用可追溯的 run/node/attempt/activation/exec + snapshot digest + claimId/serverSeq + accepted decision 证明，不拿 running/日志文字代替。
- 529 文档要求独立 slot Bridge/DB/凭据/频道；slot topology 校验与 teardown 由 QA 执行。基线与候选对照有固定观察窗口；没有 claim 只能证明观察窗口内没提交，不能声称永久卡死。

## 已向 Lead 说明的解释

问题 `13da1f44-f11f-4f06-b9fc-029d8506b4ca`：正式类型映射和 review 覆盖。报告 `d7ec1b82-6f6d-4637-af6f-7ad52735b2cc`：二次截断、生成兼容节点、Codex 动态通道事实。报告已持久入队，即时 nudge 曾提示 aborted；不把 nudge 失败当作报告丢失。等待回信不阻断已授权的独立设计工作。

Lead 对上述问题已回复 consistent with B-triple-prime, proceed；确认映射和 review 覆盖，并要求 F 同时证明有效 prompt 等价、协议一次及领域完整。当前计划显式保留这些约束。

Lead 对报告 `d7ec1b82-6f6d-4637-af6f-7ad52735b2cc` 已接受兼容文件单源生成及 Codex 实际通道；另明确收紧总长边界：协议+手册 >40,000 时拒绝派发并点名类型，禁止截尾。计划和 HTML 已同步。
