# FLY-2391 自动发布 — 运行与回退手册
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-15
基于: plan.md、activation-evidence.md

## 当前交付状态

本手册描述批准计划的操作顺序，不是已执行的生产收据。A0–A7 真实环境验收、founder 启用、生产 flag 写入均未执行。记账 transport、activation 目标映射和独立后台投影均已有源代码与替身测试；最终全仓门禁与真实环境验证尚未完成。完成最终门禁后才能把本手册用于授权的环境演练。

## 部署与首次验收顺序

1. 先验证 B0 shared contract 与旧客户端兼容，再部署支持严格 release decision policy 的 endpoint。保持该 policy 启用；B4 关闭不等于放开旧的无 decision 写入路径。
2. 在同一 endpoint 完成 B1+B2 的不可变对象上传/独立读取、CI 版本断言、CAS、entitlement 和 cleanup E2E。保留真实对象、manifest ETag、SHA、环境及执行人证据。
3. 完成 B3 的真实部署 subject/Actions receipt/本机 deployed SHA 一致性，验证 green、hold 和来源失效后的 unknown。再完成 B5 同一 manifest 的 install/update/即时 rollback、previous-good 及 quarantine 验证。
4. 部署 Bridge、固定工作流和专用 Discord Gateway 身份。配置与凭据通过部署系统提供，详细字段见 activation-evidence.md；凭据不进入计划、mapping、证据文件或日志。自动发布 flag 仍为 false，founderEnableReceiptId 可为明确空字符串。
5. A4 observe 使用隔离 ID 空间，验证 green/hold/unknown/veto/投递失败的模拟判定；不得消费生产周周期、投递默认发布卡或产生真实 permit/commit。
6. A5 在明确授权的测试环境使用真实 beta 和 intake.json；其原始周期带 manual_intake 并取消，不开自动窗口。后续 prepare/rebind 固定新 releaseId 和 artifact，新卡要求 canonical founder 的独立 go。按真实 notice/action/decision、窄 executor、CAS、客户读取和三个账本的独立回读逐一验收，再执行 veto/fence/withdraw 演练。
7. A0–A5 全部具备同环境、同代码/策略/身份的有效证据后，Annie/HL 决定 A6 的实际时刻。操作人准备 enable 控制卡，只有 canonical founder 新点击生成授权收据。部署系统填入该真实 receipt ID；自动发布还要求受保护 flag 与当前证据、epoch 和候选 gate 同时满足。
8. A7 最后 canary：真实周期内一次 veto 可阻止未 claim 发布并留账；另一个到期 green 无动作周期成功；hold/unknown 均零自动 commit。失败时立即按下节停止新 claim 并处理未决提交。

## 停止与回退顺序

1. 使用当前身份绑定的 disable 控制卡；canonical founder 点击后耐久撤销新 claim。确认当前 activation 不再 enabled。移除/关闭自动发布配置也必须保持既有未决 decision 的恢复路径。身份、证据或配置失效不会把旧 permit 自动变成已撤销。
2. 枚举所有 committing/commit_unknown 的精确 decision/attempt。保留原 endpoint、epoch、audience 与凭据上下文进行 reconcile；不把新身份的空信箱当作旧请求不存在。
3. 根据原信箱 intent、manifest 精确 tuple/ETag 和执行结果确认 published、no_write 或 fenced。需要 fence 时走原 decision 对应的窄 fence 操作，再独立读回证明。工作流 success、超时、进程退出或本地状态改变均不足以关闭 unknown。
4. 若已 published，按 B5 的独立 withdraw/quarantine/rollback 路径处理客户实际状态；不要把 post_claim_intervention 显示成“已拦下”。若仍 unknown，保持未决并停止新的冲突 claim，不重发 release commit。
5. 确认没有 in-flight 写入且 manifest 实态与证据一致后，停止 B4 scheduler/Gateway，再回退应用字节。保留 additive SQLite 审计表及未完成投影；记账网络失败不影响既有 publication 事实，也不授权再次提交。
6. endpoint strict decision policy 在正常应用回退中继续启用。若必须降级到不认识该 policy 的 endpoint，先单独授权维护：撤销窄 executor/decision 凭据、证明无 in-flight 写、保持人工发布环境硬 gate。该操作不是本 implement 节点的权限。

## 记账故障与只读日报

日报的客户发布审计区是生成时的当前快照；它不增加“今日上线”计数。Bridge 源事件尚未投影时同样计入 pending。只有 Linear 和 GitHub 对每个已有源事件都完成独立回读，才显示三本账一致；commit_unknown 始终保留原义。

Lead 在 question 7e2f1cc4-daf6-46e0-a673-89dfc3ddb0c0 裁定：部署文件按 activation 绑定一条既有 Linear issue UUID 与一条既有 GitHub issue number，repository 固定为项目。所有周期/取消/manual_intake/no_candidate/unknown 事件带固定 marker 与候选 tuple 投影到这两条记录；GitHub PR 目标必须拒绝。缺失或非法映射保持 accounting_pending，不创建 issue、不写 PR approval。映射文件格式及持久绑定规则见下节；本节点未配置真实目标。

- POST 返回不明：保留发送意图，完整查找同 marker；发现原记录后回读，不能盲目再次创建。
- marker 重复、分页不完整、目标或 writer 不匹配：保持 pending，保留原 external ID 及证据供有权操作人核查。
- 已知 ID 内容不符：仅在目标/写入者与 marker 均匹配后更新该记录，再独立回读；更新响应本身不算 delivered。
- 原始回执或 transport 可按批准保留策略清理前，必须先满足 terminal、无 in-flight CAS 且审计投影完整；active/unknown 不受按年龄删除策略支配。没有新增 active R2 age-only lifecycle。

## 交接证据

发布阶段需分别保留最终代码 review、精确 head CI、全仓 gates、真实环境 A0–A7 收据与 founder A6 授权。专项测试和本文均不能替代这些证据。记录 hold/unknown 误发、重复窗口/commit、未证实送达却 claim 均为零，以及 accounting_pending 时长和 post_claim_intervention 处置时延。

## 部署侧记账映射

`FW_CUSTOMER_RELEASE_ACCOUNTING_JSON` 是独立于自动发布开关的可信部署 JSON；缺省时只采集本地账，不进行网络请求。必须且仅含六个字段：

- directory：canonical 绝对目录；其中固定文件名为 accounting.json。
- repositoryId：项目 GitHub repository 的正整数 ID；repository 路径只从 flywheel 项目配置读取，不能在 mapping 中重定向。
- githubWriterId：记账凭据对应的 GitHub 用户正整数 ID。
- linearWriterId：记账凭据对应的 Linear viewer UUID。
- githubTokenEnv、linearTokenEnv：凭据所在环境变量名；不能填凭据值。

accounting.json 必须是普通文件、不经过 symlink、大小至多 16 KiB，读取中变化则拒绝。结构为 schemaVersion=1 与 activations 对象；每个键 `flywheel:epoch:<正整数>` 标识该数据库内持久单调递增的客户发布 activation epoch，**不是 runner execution/workflow activation ID**。每个值必须且仅含 linearIssueId（既有 UUID）、githubIssueNumber（既有正整数 issue 编号）、linearTeamId 与 linearProjectId（该发布线的 canonical Linear team/project UUID）；最多 100 个 activation 映射。旧 activation 的待补事件需要保留其映射。

首次为某个 epoch 投影前，既有 activation journal 会原子追加 accounting_target_bound，固定目标、repository 数字身份及两侧 writer 身份；不保存凭据。后续事件必须匹配该固定绑定。不能通过编辑 mapping 把同一 activation 的事件迁往新目标；不匹配会保持 pending，避免发送响应丢失后在另一条记录重复创建。缺失 mapping 也不会自动创建 Linear/GitHub issue。

后台每批读取既有事件并投影，每侧最多十条，到期重试间隔 30 秒。它独立于发布 supervisor，网络等待不阻塞发布判定；停机中止原请求并等待其退出后才允许数据库关闭。默认 off 仍可在明确配置记账后补齐历史事件。实际目标授权与凭据部署属于后续受权环境操作，本实现测试没有发出真实评论。


## R2 修复：发现索引与 Bug-source 探针

- 端点创建 attempt 后才写 `control/customer-release-ready/flywheel/<epoch>/<5秒分区>/<attemptId>/ready.json`。pending 仅查看与原有 ±5 秒新鲜度相交的至多三个分区，每次最多处理调用者原 limit 个条目；cursor 离开当前分区代际后自动重置。历史 `control/customer-release/...` 授权、started 与 result 记录不删除、不迁移。索引不是授权来源；pending 仍回读并验证原 immutable attempt、epoch、audience、新鲜度和 permit/started 状态。索引写入失败不返回 ready 成功。
- 专用 Bug-source health 探针使用同一个 deployment-owned accounting.json 的当前 activation 映射。首次请求前将 team/project 与既有 issue/writer 目标一并固定到 activation journal；只查询该既有 issue 的 team/project 归属及 canonical team 的 Bug 标签。普通建单、Bug 建单及任意团队的标签解析均不再写全局 health。实际 Bug intent 的独立记录语义保留。
- 缺失/非法 team/project 映射保持 accounting_pending，不发起探针、不写 health。已有映射下 canonical 源的错误、null、归属不符或标签缺失写失败健康信号，仍锁住自动发布周期。响应返回时 activation/映射/凭据/label 必须仍一致；旧响应不写入新 activation。停止 worker 会 abort 原请求，不写迟到健康结果。
- 这只是源码与夹具验证；真实 mapping、凭据与 activation 仍由受权部署流程配置，本节点不创建 Linear/GitHub 目标、不启用发布。
