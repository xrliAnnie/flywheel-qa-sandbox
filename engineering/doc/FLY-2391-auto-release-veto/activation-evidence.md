# FLY-2391 自动发布 — 灰度证据格式
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-15
基于: plan.md

## 状态与信任边界

本文件定义批准计划 §12 的 A0–A5 收据读取格式，不是生产验收收据。当前实现测试仅使用临时目录、SQLite 和 transport 替身。没有运行 A0–A7 真实环境演练，没有 founder enable，也未开启默认发布。

证据由有权执行真实环境验收的操作人采集和部署；证据目录属于可信部署配置，不接受 runner/master HTTP 参数，不由客户输入决定。读取器验证结构、身份绑定和输出文件完整性，不解释任意命令输出为成功，也不认证某个 URL 的内容。操作人必须检查原始结果后填写 passed；不能把 fixture PASS 或“代码已合入”换成 live。

## 目录与读取

入口为可信目录中的 bundle.json，其余捕获输出均为同一目录中的普通文件。目录必须是 canonical 绝对路径（macOS 的 /tmp、/var 别名应先展开到真实目录），不允许 symlink 根目录或输出文件、路径穿越或子目录。每文件最多 1 MiB，整次读取最多 8 MiB；读取期间文件长度/mtime/ctime 或根目录身份变化则拒绝。不得在输出中保存 token、interaction token、cookie 或凭据。证据 URL 只接受无用户密码和 fragment 的 HTTPS。

调用 readReleaseActivationEvidence(directory, currentIdentity, now) 返回 null 即不可启用。成功返回 bundle.json 原始字节 SHA-256、A0–A5 顺序以及 expiresAt；卡片绑定该 SHA-256。每次启用动作使用重新验证的当前 digest；任何文件篡改、过期、环境/代码/策略/身份不符都会拒绝。不要仅缓存历史成功摘要作为当前授权。

## bundle.json

所有对象严格拒绝未知字段。顶层字段：

- schemaVersion：1；projectId：flywheel。
- environment：部署环境标签。
- endpoint：HTTPS origin，无尾部路径。
- codeSha：运行代码的 40 位小写 Git SHA。
- policyRevision、identityDigest：当前策略和身份的 64 位小写 SHA-256。
- createdAt、expiresAt：Unix 毫秒；createdAt 不得在未来，expiresAt 必须大于当前时间。
- records：恰好按 A0、A1、A2、A3、A4、A5 顺序排列。

每条 record 重复以上五个身份字段（environment/endpoint/codeSha/policyRevision/identityDigest），必须与顶层及当前运行身份完全相同，并包含：

- stage、mode：A4 使用 observe；其他阶段必须 live。
- manifestSha256、subjectCommit、releaseId、payloadSha256：被实际验收的精确对象。
- actor、observedAt：实际操作者和采集时间，不得晚于 bundle.createdAt。
- checks：该阶段的每项检查，顺序与 evidence.ts 中 activationEvidenceChecks 完全一致，不得遗漏、重复或另加替代项。

每项 check 包含 check（固定检查名）、result（仅 passed）、outputFile（同目录安全文件名）、outputSha256（该文件字节摘要）、evidenceUrl（真实可核对的记录链接）。原始证据必须能证明该项主张；仅放一个自报 passed 的文件不构成真实验收。

## 阶段覆盖

- A0：shared_contract_version、old_client_compatibility。
- A1：immutable_upload_readback、ci_version_assertion、commit_cas、download_entitlement、cleanup_safety。
- A2：beta_actions_receipt、published_source_matches_local_subject、fresh_green_and_hold、fault_becomes_unknown。
- A3：install_update_rollback、previous_good_valid、previous_good_expired、first_bad_quarantine_or_pause、no_bad_reinstall。
- A4：green、hold、unknown、veto、delivery_failure、zero_live_card_permit_commit、isolated_cycle_ids。
- A5：founder_notice_action_decision、narrow_executor_same_artifact_cas、customer_readback、three_ledgers_readback、veto、exact_fence、withdraw。

A6 由新的 canonical founder 卡片动作产生独立收据；不得把本格式或 PR/design/ship 审批当作 A6。A7 是后续明确授权的最后 canary。运行时已具备发布与独立记账后台接线；真实环境验证尚未执行。启停/回退顺序见 runbook.md；本文件不提供生产启用命令。

## A6 配置准备（解析规则，非启用命令）

Lead question 486cf1a1-175c-43f7-af1c-175ccbeedac8 批准 canary 配置显式填写 founderEnableReceiptId: "" 作为待启用状态。字段本身仍须存在，不填字段或放入非法值仍拒绝。空值不代表任何授权，不生成占位收据、不写旗标，也不能调度自动周期或生成许可。

后续真实授权流程中，先用最终 canary policy/identity 和合格 A0–A5 digest 创建独立启用卡，canonical founder 点击后得到真实 interaction receipt；操作人把该真实 ID 填入同一配置。policy digest 原本排除 receipt 字段，因此这一步不改变 epoch，也不撤销刚取得的启用收据。真正自动发布仍需要 flag=true、非空且匹配的耐久收据、当前epoch/evidence及所有候选、通知和技术gate。当前已实现控制卡触发和 plugin 接线，但未执行上述生产操作。

## Bridge 运行入口绑定（源代码接线，未配置生产）

startBridge 现创建并启动 createCustomerReleaseHost，关闭路径先停止该host再继续原Bridge关闭。它从 canonical flywheel 项目根的 .flywheel/config.yaml 读取 customer_release；缺省off且无完整连接配置时不构造网络会话。配置/owner变化会同步失效旧授权，并保留原endpoint/epoch/凭据的未决核对路径，未决清除前不创建替代会话。

额外部署绑定由可信环境变量 FW_CUSTOMER_RELEASE_RUNTIME_JSON 提供，严格只接受：

- endpoint、audience：独立窄信箱目标。
- environment、evidenceDirectory：实际环境标签及前述证据目录。
- prepareWorkflowId、reviewedWorkflowSha：数字prepare workflow身份和已review的精确工作流代码SHA；executor数字repo/workflow仍来自项目配置。
- githubTokenEnv、payloadReadTokenEnv：凭据环境变量名称，不在JSON保存凭据值。

部署摘要绑定上述值、实际Bridge build SHA及两个凭据的摘要，再加入activation identity。修改这些输入需要新epoch与新授权。reader仍核对运行codeSha、policy/identity及A0–A5 bundle。host不会写旗标或生成founder收据。人工候选卡片投递及新鲜回读缓存已接入；尚待实现人工候选准备触发与最终线上演练；不要把入口已接线视为完整可启用状态。


fence恢复已接入host：先以原decision-writer确认精确fence intent，再耐久调度一次operation=fence工作流。重启只observe原dispatch；workflow成功不等于no-write，必须继续等真实endpoint结果。旧reviewed workflow绑定不再可执行时保留unknown，不自动选用未经review的新head。

## 控制卡请求文件

可信证据目录可放置 control.json；host只在专用Gateway健康且会话未drain时读取。缺失、非法、超16KiB、symlink或读取中变化的文件不触发投递。文件是请求投递的部署输入，不是founder授权。

严格字段：schemaVersion=1；action为enable或disable；noticeId为新的32位小写hex；epoch为当前代次；identityDigest为当前完整身份摘要；evidenceBundleDigest为卡片所示证据摘要；expiresAt为固定Unix毫秒截止。不得放token或额外字段。请求值由操作人依据当前只读状态/证据准备，不由模型生成授权凭据。

enable仅在canary且当前A0–A5摘要匹配时投递。observe不投递任何控制卡。disable在当前身份/epoch仍一致时可在证据丢失后投递，以便founder停下新claim；它不具备enable权限。连续tick每30秒至多尝试一次同请求，原control_sending耐久记录仍保证最多一次POST；改expiry不能复用nonce重发。需要新卡时显式提供新nonce及当前绑定。实际enable依然必须专用Gateway验证canonical founder点击，不写flag。

本实现未在生产目录创建control.json，也未发真实消息。最终runbook还需只读状态入口与实际环境演练收据，不能据此直接认定已具备A6/A7。


人工waiting卡片现在由host投递并定期独立回读：发送意图先耐久化，lost POST只恢复原nonce；新鲜回读缓存供Gateway go使用。缺失/过期/漂移proof不能确认go。accepted后的executor调度现已接入；人工候选的prepare/rebind请求入口尚待实现，因此仍未完成A5真手动E2E。


accepted manual go现在由host调度窄execute工作流，输入绑定其新的releaseId/完整binding摘要，request+go interaction构成单次调度身份。waiting或当前owner/epoch失配不调度；该工作流仍要向现有decision pump申请permit，启动工作流本身不是发布授权。

## 已有取消周期的人工 prepare/rebind 请求

manual.json 使用同一可信目录及16KiB普通文件读取边界。严格字段为：schemaVersion=1、operation（prepare或rebind）、requestId（新的32位hex）、cycleId（已有flywheel取消周期）、releaseId（不同于原auto release的新ID）、epoch、identityDigest、requestedAt、expiresAt、sourceBindingDigest（prepare为null，rebind为原cycle完整binding的SHA-256）。

host仅非observe处理。prepare使用原冻结beta；rebind核对原binding摘要并使用原releaseId作source。工作流成功后再次读manifest及完整prepared对象hash，再创建独立waiting go卡。每次异步后重新校验请求文件、身份、cycle revision和固定expiry；修改旧请求不能借旧dispatch改候选。新的go仍由founder点击取得，prepare请求本身无发布授权。

首次部署尚无cycle时存在A5前置依赖：该入口目前仅接受已有cancelled cycle。已向Lead提出独立manual intake最小方案（question fb4686b6-f032-4a2e-97eb-1d248ac4b581），尚未实现/获准前，不宣称fresh-deployment A5可执行。

## 首次部署的人工 intake（已批准实现，未执行线上验收）

Lead批准的intake.json现支持无既有cycle的A5入口。字段严格为schemaVersion=1、requestId（新的32位hex）、betaVersion（精确eligible beta）、slotDate（当前配置周的slot）、releaseId（待prepare的新ID）、epoch、identityDigest、requestedAt、expiresAt。真实manifest/当前deployed SHA必须匹配；未知、observe或同周其他请求不预留周期。

预留的周期立即以manual_intake取消，不开窗口、不投递auto通知、不修改auto启用前提。该动作消费本周槽位一次，记账必须分类manual_intake；重放原请求仅恢复处理，同周新requestId不能另建。无显式manual.json时，host把该intake转换成绑定同cycle的prepare请求，最终仍需新的founder go。若存在显式manual.json，该文件优先；操作人需要避免保留过期的覆盖请求。

本节替代前述“fresh deployment方案待答/未实现”的历史状态；A5真实E2E和accounting投影验收依旧未完成，不能当成生产enable依据。
