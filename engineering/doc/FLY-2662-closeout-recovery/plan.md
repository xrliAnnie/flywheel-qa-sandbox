# FLY-2662 收尾恢复 — 实施计划
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662/land收尾死结-已合入的卡收尾永远停在半路thread-不归档linear-不-doneworktree-不清window)
日期: 2026-09-17
基于: research.md

状态: APPROVED revision 4 — round3有效reviewVerdict=APPROVED；批准回执与3条非阻塞Follow-ups见 approval-handoff.md。此状态行更新不改变送审设计合同；实施与上线验收尚未执行。

## 1. 给 founder 的说明
一次正式“重收尾”会重新核实旧任务的身份和目录清单，再沿原顺序做完。窗口名字仍是 pending（还没绑定）不再永久卡住：系统查真实窗口和进程，确实没有才清；活着或查不清就停下并说明原因。旧作业缺清单时从可靠历史来源补回，不用人工改数据库。
修复上线后，由 Lead 逐张执行正门并记录最终 thread 与 Linear 的实读结果。设计节点不操作现网收尾。合入与部署分开，只有独立 updater 在窗口内部署。

## 2. 不变条件与完成定义
1. 精确 merged tuple = project + persisted issue key + runId/null + operationId + PR + approvedHead + mergeSha；外部 issue label 只用于显示，旧字符串持久键不在此迁移。
2. 原顺序：all execution gone → all worktree targets settled → records closed → thread archived → Linear completed → op/run completed。每阶段的观察/内部准备可先收集，宣布完成和后继副作用不能越序。现有每执行的 CommDB finalization 可能早于 worktree；实施须把“证明/预留”与“记录关闭”拆成两个阶段，真正删除通信行与关闭记录统一放在所有目录 settled 后，保留原有 evidence/CAS，不用删除行来充当 gone 证据。
3. 任意活进程、活窗口、daemon、fresh heartbeat、有效 launch 反证、founder wake、活跃 TURN/park guard 变化 → 不做后续清理。已由正式 shipped shutdown 授权解除的旧 parked 声明沿用 FLY-2616 trusted gone 规则，不能把所有 parked 字符串都当永不退出的阻塞。
4. reclose 无 merge/ensureShip 权限，无新 successor 启动；未知外部结果先 reconcile，不重复发送/归档。
5. 恢复接受回执≠完成：最终必须读回 op/run、目录、CommDB closure receipt、Discord archived 和 Linear state.type=completed。live/unknown 控制组零 archive/Done。

## 3. 一条恢复正门，补证与恢复同一次请求
### 3.1 CLI / 身份 / 幂等
保留 `land reclose --operation <full-id> --expected-generation <resume-generation> --expected-head <40hex> --reason <text> [--request-id <uuid>]`。不新增手工 DB 命令，不要求先 hold resume 再 reclose。可增加只读 `land status --operation` 显示 current op、缺项与可复制命令；不能由 CLI 自动挑 sibling op。
`commands/land.ts` 保持用户命令参数不变，按服务端registry真实backend走不同传输，最终调用同一窄reclose service。**公开Claude lease tuple只证明Lead存在，不能证明来电者是Lead；禁止把它作为HTTP鉴权**。遵循Lead question `36ccc8fc-46c5-4044-9a0d-92758b15094b` 的A裁定，不新增per-instance secret，不复制codex-only router的role/profile/bundle门：
- Claude Lead（本项目backend未设置，默认claude-code）：CLI通过Bridge拥有的窄Unix socket发请求。Unix socket是仅本机进程连接的入口；本设计还必须由内核辨认连接方，因为文件0600本身挡不住同UID Runner。消息仅带操作参数和lead/project selector，所有PID/start/leaseKey/generation来自Bridge自己读取，消息自称身份无效。HTTP入口对Claude始终返回 `claude_reclose_peer_transport_required`，不接受public tuple或master token降级。
- Codex Lead：保留已有HTTP secret carrier路径，proof为projectName/leadId/identityDigest + carrierClaim及其现有绑定的activation。Bridge调用validateLeadCarrierAuthorization，valid且非processIndeterminate并核对当前绑定；secret不入日志/receipt。本单不改变该carrier发行、注入、轮换或权限。
Claude peer验证的必需步骤：
1. Bridge native adapter自己持有listen/accepted FD，由内核读取 `LOCAL_PEERPID` 与 `LOCAL_PEERTOKEN`；不把客户端JSON、HTTP转发头、同UID、环境变量、进程命令名当peer来源。用audit token的pidversion与内核进程唯一标识信息相互核验，再读取精确到微秒的process start、PPID及parent unique identity；消除连接方退出后PID被复用的替身。只有PID/start而无socket绑定的incarnation校验仍不够。任何字段或系统能力缺失，返回 `peer_identity_unavailable`，不fallback。
2. 服务端读取当前registry、Claude lease/history、holder PID/start/generation，仍调用现有validateClaudeLeadLeaseAuthorization检查lease有效性；这是第二条件，不能替代peer证明。从peer到当前holder逐层读取进程链，每一层以PID+start+unique identity绑定、parent关系前后复读稳定。必须确实抵达同一holder incarnation；不是任意共同祖先、不是“同用户就算Lead”。holder lease start目前字符串表示时保留原比较，再附加native精确start/unique identity，不从秒级字符串伪造微秒。
3. 同时排除已注册Runner及其launcher/daemon进程树：从StateStore/session/launch registry取得执行体root incarnation并与peer链交叉检查，包含Lead启动的Runner后代。未能完整读取root清单、未知链、重父化、PID/start或parent unique identity变化均 `peer_ancestry_indeterminate`；发现Runner root为 `runner_peer_forbidden`。仅检查FLYWHEEL_EXEC_ID环境或CLI脚本路径不算排除。既有root缺精确incarnation时重新观测并核对既有绑定；仍无法确定则拒绝，不把缺记录等于非Runner。
4. 请求准备前和同步提交前重验同一个仍连接的peer incarnation、祖先链、lease与scope；断链/退出/lease变动为 `peer_authority_changed`，零恢复提交。CLI在accepted回执前保持连接、不把FD传给子进程；listener/accepted FD设置close-on-exec。durable acceptance后dispatcher沿授权回执接续，不要求短命CLI在整个收尾期间存活。历史request replay也先验证新当前caller，不能靠旧receipt绕过。
两条路径均核对负责project/issue的Lead scope，生成不可由请求直接构造的 `verifiedActor{leadKey,backend,identityDigest,claimKind,claimGenerationOrInstance,holderPid,holderStart,peerIncarnation?}`，其service参数只能由内部认证闭包创建。Claude claimKind=kernel_peer_with_lease，Codex=secret_carrier。registry/lease/carrier DB和socket路径由Bridge配置，request不能指定；master token、公开lease tuple或自由actor不足以授权。身份不可用/错Lead/Runner/撤销lease或carrier均typed拒绝，零恢复状态写。
lease mode的off/audit_allowed/unprotected等disposition从此不参与caller证明。Claude CLI无需authorizeLeadWrite返回lease_validated来提取claim；server直接读取当前bound lease并与kernel peer联合校验。在任何mode无有效bound lease仍拒绝；不能以mode=off放行，也不能因off而把真实有效peer误判为缺carrier。full resume既有ship authority不放宽。内部Bridge入口也须经过同一认证service，不能接收从请求反序列化的verifiedActor或“trusted=true”。

**Darwin适配器与发布合同（属于主PR）**：新增 `packages/teamlead/native/reclose-peer/` 的窄Node-API模块及构建文件，由native侧owns listener/accept、有限帧读取与connection handle；`src/bridge/land-reclose-peer.ts`只收到native创建的不透明连接句柄，不能接受JSON提供的FD/peer对象，也不依赖Node私有socket._handle。`getPeerSnapshot(handle)`/`revalidatePeer(handle)`返回内核事实，JS授权层处理registry/lease/scope。复用既有broker的有限JSON思路（64KiB上限、超时、连接数上限、单请求响应），不把原broker只有chmod的socket当已具备peer认证。未知method、重复frame、超限先拒绝，无任意命令/通用RPC能力。
启动时验证配置绝对路径及全部父路径无symlink，私有父目录owner=Bridge UID且0700，socket0600、owner一致；bind后再lstat确认socket类型/identity；既有socket不盲删，仅在可信owner shutdown证明与同inode检查后清理。模块负责FD生命周期，调用失败不残留半启用HTTP旁路。构建/pack/release-manifest同步携带目标Darwin架构Node-API二进制；安装自检加载模块、创建临时私有socket并验证peer，不在生产DB写测试。unsupported平台或ABI/权限不符返回 `peer_adapter_unavailable`，只禁Claude reclose，普通ship与Codex不受影响。
Apple公开XNU源码定义LOCAL_PEERPID/LOCAL_PEERTOKEN及proc唯一身份；部分proc结构位于private header，不能假称所有SDK公开稳定可用。实施需固定所用ABI声明及结构长度校验，限定已验证macOS版本/架构并记录构建SDK；目标主机真机自检是放开入口的门。若不支持，fail-closed并报告Lead，不改用公开tuple/新secret。本节点未实现native模块、不声称OS验证已通过。

请求回执绑定：operationId/project/issue/run/PR/head/mergeSha、expectedResumeGeneration、mode、verified lead identity digest+claimKind+generation/instance（activation仅后端具备时）、reason 的 canonical digest、requestId、target revision/digest。相同 requestId 只有完整 tuple 一致才 read-only replay；mergeSha 或 actor/reason/head 等变化 409 request_id_conflict。replay 必须先认证当前 caller；历史成功只读返回，不重新 kick 不当前的作业。CLI 在网络异常前输出 requestId，重试复用它，不重新造号。

### 3.2 只给 reclose 启用身份映射，普通 ship 不新增在线依赖
历史persisted issue key与canonical lifecycle UUID是两个字段。点名8卡的旧 `FLY-xxxx` 字符串必须保留，不能把fixture issue_id替换为UUID来绕过缺口。新增 `lifecycle_issue_identity(project_name,persisted_issue_key,canonical_issue_uuid,identifier,source_updated_at,identity_revision,source_receipt_json)`，PK(project_name,persisted_issue_key)，同一key只能映射一个UUID；同UUID可以有合法历史alias。**强制UUID补证限定为authenticated reclose请求及其后续带reclose receipt的作业**；普通ship、legacy sweep、非land park/cancel不全局切换root，也不新增Linear在线前置。既有identifierShip可用性不因本单改变。
先检查既有mutationEnabled/流程权限开关，关闭时保持零元数据写。reclose使用Bridge已有Linear client按exact identifier查询，核对response.id为UUID、identifier完全一致、项目/team归属与配置一致。将verified mapping参数化SQL持久化，保留旧op/run/session主键；已有映射不自动改绑。该映射是可重试身份准备，不是恢复/清理副作用。缓存可信映射可用于查本地guard与路由，不据其声称远端当前状态；reclose接受前仍须fresh provider状态证明未取消/重开。
分档行为：
- 无LINEAR_API_KEY：普通ship按原有deferred/not-configured契约继续；reclose返回明确 `reclose_provider_unconfigured`（配置补齐可重试），不修改op/run、不创建永久hold、不消耗9次预算，给出缺provider动作。
- Linear超时/429/5xx：reclose返回typed retryable/Retry-After；已接受作业保留durable generation与next_attempt，不重新造op/丢恢复权。不能把临时身份查询失败升级成不可恢复without-operation hold。
- identity冲突/错project/删除issue：拒绝这一指定reclose，给出来源与正门修正所需证据；不阻断其它卡普通ship。provider返回canceled/reopened时阻止清理，必须由既有明确founder决策处理。
- 本地已有active park/canceled/wake veto时直接拒绝，不等待外部provider。即使离线，founder也可以通过下面本地legacy veto叫停。
新增窄 `lifecycle_legacy_veto(project_name,persisted_issue_key,revision,kind,founder_receipt_id,created_at,resolved_at)`，只接受既有founder park/unpark认证过的动作、并要求key属于该project现存run/op/session。它允许 `parkIssue` 收到legacy key且尚无UUID映射时先在本地落“禁止再收尾”记录；不授权kill、删目录、archive或Linear写入，也不弱化founder-only权限。只有匹配的显式unpark receipt能解除（递增revision）；新reclose不是解除park。普通无关联卡行为不变，已有此veto的卡各路径都必须尊重这个否决。
reclose专用 `ensureLifecycleIdentity` 读取映射与alias closure，输出 `{persistedKey,canonicalUuid,aliases,mappingRevision,legacyVetoRevision}`；plugin preArbitrate、StateStore resume、land-executor authorize、postship callback和Linear done在**reclose mode**消费该对象。只有该模式缺映射才unresolved；普通mode不得意外继承hard prerequisite。park、reclose共享legacy-key锁；有UUID映射时再包含canonical锁。
锁顺序：异步取得identity proposal（无锁）→对project+legacy alias+canonical UUID锁键排序统一获取→重读mapping/closure/legacy veto无变化（变化则释放重试）→持久化verified map→repo lock。park legacy没有映射也用同一legacy锁，先写veto；reclose随后拿锁必读到。已知UUID调用共用canonical锁。提交前及每个破坏性effect前重读两侧guard revisions、读取fresh缓存过期则重取远端state；canceled、reopened或identity drift拒绝，已发远端effect走readback/补偿。

逐表读取/迁移合同（不全库改rootKey）：
| 表/状态 | reclose怎么读 | 写入/升级 |
|---|---|---|
| land_operation、workflow_run、sessions及worktree绑定 | 保留persisted key，按verified alias集合查完整执行闭包 | 不改旧主键，不造UUID session |
| disposition_receipts | 沿原receipt_id/target_key/episode查询；issue路由匹配legacy+UUID alias，不能只查UUID | 历史476条（review观察）不改、不重复发；新receipt沿原键，附identity引用即可 |
| linear_state_observations | canonical UUID读取，同时对已有alias记录取更保守的canceled/reopened veto；冲突拒绝 | 不把UUID观察镜像成legacy第二真源；已有UUID canceled必须能阻断legacy op |
| issue_disposition_intents | 对verified alias集合查询active，canonical为正常写键；任何一侧active即否决 | 旧intent不搬；同UUID不同alias不能双重授权 |
| lifecycle_legacy_veto | 用project+persisted/known aliases查询，任一active即否决 | additive本地否决表，显式founder unpark才解除 |
| lifecycle_apply_claims | 检查alias两侧同approvedHash及其原始snapshot身份；不因key换形重放apply | 历史claim不改；不同root/snapshot按既有authority拒绝，不自动重签 |
| CommDB rows、TURN、founder wakes、launch reservation | executionId集合不变，issue lookup用alias闭包；保留原receipt身份 | 不搬execution记录；guards都在真实写事务中重验 |

灰度/backfill：schema阶段只建表，零全表网络backfill、零旧key重写。对审阅观察的432个land op/1340个distinct issue key做只读清单统计并保存分类；不把全量补齐设为上线门。先对点名8卡逐个reclose lazy写verified mapping，再由Lead按显式指定op逐步扩大；每次并发上限1、停止条件为alias冲突/拒绝率或普通ship回归异常。已有mapping可复用；取消灰度只停新reclose，不删除已保存guard或让旧作业绕过veto。
强制测试：fixture保留issue_id='FLY-xxxx'、初始alias无UUID；reclose真实mapping provider后完成；legacy park在无key/Linear离线时仍落本地veto并阻断重收尾；canonical canceled observation能挡legacy op；旧disposition receipt仍可查询/投递且不重发；同key/UUID并发与映射冲突；无LINEAR_API_KEY环境普通ship行为与baseline一致、reclose typed拒绝且零恢复写；429后同request恢复完成。

### 3.2.1 准备阶段（异步，无清理副作用）
新增 `bridge/land-reclose-preparation.ts`，由 resume service 调用。按当前项目/issue 生命周期 mutex → repo mutation lock 的固定顺序进行；沿已有锁 helper，禁止逆序。先读当前 operation/generation/resumeGeneration、run/node/dispatch/hold event、disposition、merge receipt，再远端 inspect PR 确认 MERGED/head/mergeSha 同一 tuple。
只接受 operation held/partial（completed 只读返回）；run 为 active 或 held 且 current node 是其 pinned terminal land、当前 dispatch/attempt/PR binding 与 operation 一致。held 原因必须属于该 operation 的 land closeout episode；其他 founder/operator hold 不隐式解除。取消、superseded、terminated、reopened、不同当前 op、不同 node、冲突 PR、存活 owner/reservation 均拒绝且保留旧状态；返回确切 current operationId 作诊断，不替用户换目标。
对过去误记 `land_held_without_operation` 的事件：按该事件的 run/node/attempt/head/PR 联结持久 op，要求唯一且就是当前 op，并核对 merge receipt；生成 `legacy_hold_reassociated` 审计附注，原始 event 不改写。零/多候选拒绝。新的 dispatcher 拒绝始终携带 existing operationId，with/without 分类由真实存在性决定。
提取 `land-intent-targets.ts` 的验证器用于两条入口：新 prepare intent 与旧 reclose。旧 NULL 不先变 runnable、不建 replacement op，不调用新 ensureLandOperation 去掩盖旧身份。

### 3.3 目标补证与版本
保留原 v1 target payload 解析并新增 v2，schema version 与 snapshot revision 分开。给 land_operation 加 `closeout_targets_revision INTEGER NOT NULL DEFAULT 0`（0=未捕获）、`closeout_targets_source`（intent/reclose_migration/attribution_refresh）。已存在 v1 有内容的记录迁移 revision=1，NULL 保留0；不在 schema migration 时访问文件系统、不批量填假目标。
采用 append-only `land_closeout_target_revision(operation_id, revision, schema_version, canonical_json, digest, attribution_digest, source, source_receipts_json, observed_at, request_id)`，PK(operation_id,revision)。land_operation 只保存当前指针与既有兼容字段，同事务更新；revision ledger 是历史证据，不是第二个权威目标集合。所有消费者读取当前 pointer，旧版本用于审计。
目标来源覆盖完整 run attribution（历史 attempts、activations、side effects；排除仅物化 mat identity），再用 session binding、durable worktree binding/launch dispatch receipt 与 Git registration/generation/parent identity 验证。没有 StateStore session 也不能漏掉 exec。engine target 只有 pinned execution=engine 且没有 conflicting runner launch/session 才可 not_applicable。
- 目录存在：真实路径、相邻受管 parent、repo registration、branch、generation 全一致，输出 bound_worktree。
- 目录已被删：v2 `verified_absent_worktree` 支持两种来源。已有可信旧parent/path/generation receipt走历史绑定校验；旧NULL op无历史parent inode时允许 `evidenceMode=legacy_absence_observation`，严格只证明“持久精确绑定指向的路径当前不存在”，不声称历史inode未变。来源必须是sessions专用 worktree_binding_path/branch/generation（getWorktreeBinding）或同等durable dispatch/binding receipt；普通worktree_path显示值不是授权。
- legacy absence路径：可信配置projectRoot与Git common-dir/repository identity一致；source binding是同一canonical parent下的受管兄弟路径，parent可访问且dev/ino与projectRoot父目录一致；每层无symlink、path traversal、mount/设备异常，完整Git inventory无此target，连续lstat精确ENOENT。保存source receipt、当前parent identity、observedAt及reclose来源版本。完整run归属、所有体gone、有效launch reservation是前提。此种target只签absence receipt，绝不调用rm/prune或local/remote branch delete。提交前、records close和archive前重验上述事实；路径复建或parent变化使receipt失效，必须转正常bound验证，不能借旧absence删除新目录。
- 当前只读实证已确认2598/2616为“绑定仍在、path=ENOENT、Git未登记”，没有历史parent inode仍可由同一次reclose安全收口。若Git残留registration且无历史parent证明，不能套legacy absence；保留拒绝与具体缺项，不假称registration已清（此控制形状不是当前两例）。若完全无durable binding来源，仍source_proof_missing；必须补充受验证的正门来源，不能按issue名猜目录。
- 无目录的 engine 用 not_applicable；空 targets 不代表完成。缺来源/权限错误/部分枚举一律 typed refusal，列出 executionId 和 source。
完整 attribution digest 绑定排序后的 execution identities + run/node/activation/dispatch provenance + binding generations（不仅 execId 集合）。计数器明确位于新表 `closeout_attribution_epoch(project_name,scope_kind,scope_id,epoch)`，PK前三列，scope_kind=run时scope_id=runId，legacy无run时scope_kind=issue、scope_id=persisted issue key。epoch初始1，tombstone保留；同run多个op共享这个源epoch，各op的目标snapshot revision仍独立。
`workflow_run_node`、`workflow_side_effect_ledger`、`workflow_execution_binding`以及被collector实际消费的activation identity记录的insert/delete、影响run/node/attempt/execution/dispatch identity及receipt的update，和sessions专用worktree_binding_path/branch/generation更新，在同一StateStore事务内增加受影响scope的epoch；归属转移同时增加old/new scope。仅heartbeat/last_activity/不参与canonical输入的统计列不递增。统一mutation helper/SQL触发器覆盖direct SQL与全部mutators，禁止异步后补epoch。session binding更新通过上述持久执行归属联结找到所有run；无run对应legacy issue scope。迁移为现有scope建1，删除源行不删除epoch行。
在提交事务内先读当前epoch与captured epoch比较，再从同一事务视图重算完整canonical digest并比较captured digest，二者都相等才commit target pointer；digest相同但epoch增加的ABA仍拒绝。追加 revision 的异步探测前后必须相同；若变动重采，不接受子集/静默丢旧目标。
目标版本刷新：new execution/binding/revision 变化阻止清理，保留已经 settled 的旧目标 receipt，合并新增目标并完整重采。只能由同一有权 reclose 请求准备/提交，或运行中 current owner 在安全 reservation 内完成 refresh；刷新同样升 revision 并作废旧 gone evidence/reservation，不能边用旧集合清边补。

### 3.4 同步原子提交与运行
异步准备完成后重读 verifiedActor/disposition 与所有 observed revisions。一个 StateStore 同步 transaction（无 await）CAS expected op generation/resumeGeneration/state、current run/node/attempt/dispatch、hold episode、attribution digest/revision、merge tuple，完成：
1. 插入 target revision ledger、更新 current target pointer/兼容字段；
2. 清理旧 closeout reservation，generation 递增以 fence 旧 owner，resume_generation+1，retry_count=0；不增加 ship_attempt；
3. held/partial op→partial，关联的 land-specific held run/node/dispatch 恢复到 dispatcher 能消费的 active/ready 对应状态；active run 保持原 state；不得重置其它节点或历史已成功 steps；
4. 保存 `closeout_only_authorized:<resumeGeneration>:<requestId>`、`hold_resumed`/reassociated receipts 和持久 kick 意图。任意 CAS 失败全部回滚。
Crash before commit→无变化；commit 后未 kick→dispatcher/启动 reconcile 从 durable intent 接回。dispatcher 看到 current reclose receipt 与有效 target pointer 直接续收尾，不再要求 pre-merge holder 重建 intent；但每次执行仍验证 current run/node/disposition/target attribution。切勿仅让 reclose 返回200而下个 tick再次误归 without-operation。
完成 receipt 同事务或现有 fenced completion API 将正确 terminal land node/run 标 completed；中途 error 保存本次 episode 原因并按既有 retry/outbox 行为等待。旧历史非current作业不伪标 completed。每张验收卡以绑定该 merge 的 current op 完成为准，历史残留单列，不从名称推断。

### 3.5 解除记录关闭与目录清理的循环依赖
仅 `landManaged = resumable && opts.landOperation` 使用新的显式阶段结果：`physicalReady`（所有体gone+guards/reservation有效）、`worktreesSettled`、`recordsClosed`、`archiveReady`。不能再让目录阶段依赖旧 `cleanup.commDbFinalized`。
1. `issueCloseout`/husk physical pass只观察/正式shutdown/预留，不finalize/delete Comm行；返回每exec的proof与physicalReady。缺row仍走相同proof/guard。
2. `if (physicalReady) settleLandOperationWorktrees(..., physicalReady)`；该函数不读CommDB finalized作为前置。失败保留proof/receipt并停住，不关闭记录。
3. `if (physicalReady && worktreesSettled)` 重新核验/过期重采proof，再调用单独 `finalizeProvenGoneRecords`；真实Comm finalize、StateStore terminal closure和跨库ack在此阶段。任何失败保持recordsClosed=false，重试从settled receipts接回。
4. `archiveReady = physicalReady && worktreesSettled && recordsClosed && currentAuthority`；thread archive仅用archiveReady，Linear Done还需thread archive confirmed，最终op/run complete还需Linear readback。原postship `closeoutBlocked` 在land分支改为 `!archiveReady` 仅用于最终归档/Done，不再用来开关步骤2。
5. 非land shipped/canceled/founder_parked沿原disposition分支和原record-close触发，无需不存在的land worktree阶段；仍不能通过runIds新增无session的裸finalize节点。共享API要求显式mode，缺mode保持原非land行为，不把非land path默认升级成land两阶段。
测试effect trace之外要断言：Comm未关闭但physicalReady=true时目录步骤会执行；目录失败Comm finalize为0；目录成功后Comm CAS冲突可重试；nonland park/cancel本身可完成且不等待land worktree。所有claim instance与canonical lifecycle身份穿过新结果对象，不从最新owner补字段。

## 4. pending 的物理补证
新增 closeout 专用 `resolveExecutionWindowEvidence`，不修改 attach/kill 的 lookupTmuxTarget fail-closed 默认。任何 DB target（missing/pending/stale/found）都调用 `listTmuxWindowsByExecutionId` 全窗枚举，以 @windowId 去重 linked sessions，并探测全部匹配窗。已知 DB window 也检查，不能只挑一个 dead window。
补齐 launch 时已有 `@flywheel_exec_id` 标记保证；为部署前只在 env 的 pane，使用只读 bounded pane/process inventory，提取白名单 `FLYWHEEL_EXEC_ID`/既有等价 execution marker，核对精确 ID 和 process start/host identity。进程环境原文不得入日志、receipt、HTML或 fixture；不把 issue 标题或子串匹配当执行身份。枚举无法完整读取时 unknown，不用 pgrep 空结果证明 env-only TUI 不存在。
`generalized-launch-recovery.ts` 新增 closeout 使用的三态 `probeHostProcessByExecutionId`，返回 live/absent/unknown+source/reason；旧 boolean wrapper 保留给原调用者，既有含糊时的保守行为不改变。超时、权限、命令失败为 unknown；精确进程活着为 live。
no-server 路径：只有确认探测的是本机配置的正确 tmux socket、服务不存在（明确 ENOENT/ECONNREFUSED，且重新枚举/launch fence 没变化）才构成 window absent；任意 CLI stderr/exit1 不直接等价 absent。tmux access denied、截断、身份歧义均 unknown。
pending row 本身只是未绑定身份。完整窗口 inventory=absent、host=absent、daemon=absent/not_applicable、heartbeat stale/not_applicable、launch settled，且没有 guard 变化，才构成 gone。保留 pending 字段不重绑；所有 live/unknown 保守拒绝。
收集前占用 issue closeout reservation 以 fence 新 launch；探测 TTL=30s 沿用，任何 cleanup/delete 之前重验 reservation、owner instance、generation、Comm epoch、StateStore lifecycle/attribution revision 和 guard，过期重采。所有目标 gone 后才执行目录步骤，再以各库 CAS 关闭记录；目录操作超过proof TTL时，保留已settled目录receipt，重新收集执行体proof后再关记录，不能延长旧proof有效期；CommDB receipt 与 StateStore acknowledgement 分段可恢复，不能宣称跨库原子。

## 5. 身份和 effect fence 收口
CommDB 新增 `session_identity_epoch(execution_id PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=1))`。migration 在数据库 exclusive schema transaction 内安装触发器：sessions 与 runner_declared_states 的INSERT/DELETE每次递增；UPDATE仅当以下任一列OLD与NEW以SQLite `IS NOT`（NULL-safe）不同才递增：sessions的 `tmux_window,project_name,issue_id,status,ended_at`；runner_declared_states的 `kind,reason,created_at,expires_at,updated_at`。execution_id变更作为旧exec delete+新exec insert处理，两侧epoch都递增。非身份列如sessions.started_at/vendor/phase_keep_alive修改不得增加此epoch，适用guard仍由各自校验负责；不存在 epoch 的旧 exec 首次变更创建1，旧有行 backfill1。epoch tombstone 不因 finalize 删除，delete/reinsert 继续增加；A→B→A 也不同。
对 closeout guard 的 TURN/wake/controls 等变化保留现有各自 revision/事务查询，不能把 session epoch 当全局授权。getSessionCloseoutIdentity 返回 `revision='epoch:<n>'` 与可选 contentDigest；absence 没有 epoch 用显式 `epoch:0`，首次创建变1，旧 evidence version1/hash 拒绝重新采集。新增 evidence version2，生产读旧证据只能审计，不能执行 destructive finalize。把新 epoch/target ledger 纳入 retention protectedCurrentOrReference 与 schema closure 测试。
claim 必须由真实 executor 原样传递 `{operationId,ownerId,ownerInstanceId,generation}` 到 land-finalization-context → PostShipOpts → husk → closeout → nested effect。不得从“最新 owner”补缺字段。`recordLandOperationStep` 同样增加 ownerInstanceId 并更新所有调用者。
每个 mutation 先校验 current running owner/generation/instance/lease/disposition，再判断是否 replay。已完成历史 step 的只读读取可返回成功；一旦携带 threadArchive 修复写必须 fresh fence；相同 receipt 不授权覆盖 founder reopen。record archive 同时核对 thread 属于 exact issue/project/op、没有新 reopen epoch。
notify 不准“先发再看 recordStep”。新 `land_notification_intent` 或现有 durable effect outbox 的等价 land 类型绑定 owner/generation/instance/episode，真实 send worker 在发送前再次核验；旧 owner catch lease_lost 直接退出，零 retry通知、零 release、零计数。已交给外部服务的请求无法撤回，标 ambiguous 并 readback，不自动重复；不能宣称网络 await 全程可撤销。

## 6. owner health 与时间合同
保留当前有效常量 heartbeat=10s、watchdog=2s、lease deadline=5min；本计划显式 supersede 2616 文档20s deadline 文句（不改变该单独立物理死亡检测≤10s的验收目标）。用 fake clock 测时，不引入 CI wall-clock 门限。操作者可见后果：进程仍活但停止心跳时，lane最多按5min deadline保留，期间reclose返回busy；不能按旧20s预期接管。实施在2616原目录新增 design-correction-FLY-2662.md 指向本计划§6并在2662里程碑记录supersede，不改写2616已批准原文或冒称其已被回滚。
新增持久 `owner_last_progress_at` / `owner_progress_step`，仅有效业务 step/checkpoint 推进；owner heartbeat、aux health receipt、重复 replay 不刷新。pending 远端 await 超过5min且没有有效进展，记录 owner_health outbox，一次 episode = operationId+ownerInstanceId+generation+lastProgressAt；Bridge 重启与重复 watchdog 不重复提醒。检测到 deadline expiry/反复 lease loss 同样进入既有 health episode。
活进程卡住只告警，不伪判 dead、不自动交给另一 owner 重放不确定 effect；真实死亡或现有 lease CAS reclaim 沿 FLY-2616。恢复推进后记录 episode resolved，下次新 hang可新报。owner health/lease loss 不消耗 closeout 9次 retry预算。需要新的 outbox table/字段时使用现有 durable alert routing/receipt convention；不能在 worker 内直接发 founder thread。

## 7. 15个 findingKey 的明确处置
以下全部为本单实施要求，设计批准不等于已修复。
| findingKey | 文件/具体行为 | 必测反例 |
|---|---|---|
| legacy-closeout-runid-inventory-bare-finalize | plugin.ts:7377、lifecycle-closeout.ts:226/1031仅 landManaged 传/展开 runIds；非land新增无session节点不得裸finalize | 非land + runId + 无State row + Comm parked/TURN/unread wake，各自不被关闭 |
| shipped-husk-claim-missing-owner-instance | land-finalization-context.ts、post-ship-finalization.ts:1125 传真实完整 claim | modern instance成功，missing/旧instance在任何kill/清记录前拒绝 |
| closeout-window-probe-skips-marker-discovery | tmux-lookup.ts、execution-closeout-evidence.ts，全窗+env-only覆盖 | missing/pending + pgrep无结果 + 其它session活pane；多窗一活；linked去重；枚举失败 |
| commdb-identity-revision-is-content-hash | flywheel-comm/src/db.ts epoch+triggers，含所有session/declared写入口 | A→B→A、delete/reinsert、park/unpark，旧proof均失效 |
| land-owner-heartbeat-renews-hung-owner | land-owner-liveness.ts、land-executor.ts、StateStore.ts health进度 | heartbeat不断但await永不返回，重启后仍单次outbox；恢复后新episode |
| fenced-owner-still-announces | land-executor.ts announce/catch、真实outbox send边界 | await中被接管后throw，notify=0，新owner不受影响 |
| land-step-replay-archives-before-fence | StateStore.recordLandOperationStep 先fence；completed只读replay | archive后founder reopen，旧相同receipt不改archived_at/reopen标志 |
| closeout-targets-not-rechecked-against-attribution | StateStore reservation、intent provider、post-ship-finalization targets consumer | 采集后新增exec/binding ABA/新attempt，旧目标不得清；refresh包含新增 |
| existing-operation-refusal-held-as-without-operation | dispatcher、hold registry/writers、reclose preparation/state transaction | 部署前NULL op + wrong-shape hold + legacy issue string，经单次reclose最终completed；无重复op |
| finalization-context-borrows-sibling-session | land-source-session.ts postmerge缺gate owner直接operation context | sibling其它head/PR/project不能借；原owner row删除仍保留exact exec |
| closeout-only-resume-no-lead-identity | comm land CLI、lifecycle routes、plugin wiring，§3.1身份 | 真实Claude kernel peer+lease与Codex carrier分别成功；复制公开tuple的同UID Runner/无关进程、HTTP Claude、错Lead、PID复用、失效lease/carrier零恢复副作用 |
| closeout-only-request-replay-ignores-merge-sha | StateStore.resumeHeldLandOperation，完整request tuple compare | same id不同mergeSha/actor/reason冲突，原状态不变 |
| host-process-probe-error-maps-live | generalized-launch-recovery.ts三态closeout probe | sensor error=unknown，无误称live/absent；旧boolean consumer回归 |
| land-intent-bare-throw-realpath-stat | land-intent-targets.ts所有FS/Git边界统一typed refusal | registered.path realpath/stat EACCES/ENOENT返回缺项，durable hold+outbox不log-only |
| land-owner-deadline-diverges-from-plan | §6统一5min source constant+plan+fake-clock | 旧20s已失效；lease renewal/reclaim所有consumer用同一常量 |

## 8. 实施任务（仅后继 implement 执行）
每项按 RED→最小实现→GREEN→独立 commit；先保存失败输出，不能以 stub替代核心guard/StateStore函数。
主次与可拆分交付：主问题两种形状及 closeout_only_run_not_active 优先。PR1可独立包含 A/C/D 及其必要的epoch/attribution/claim/权限依赖；其安全必需项不为赶进度拆走。PR2收余下health、非land隔离等advisory。两PR仍逐项对应§7，不减少本单15项；如不拆则按同样优先级实现。拆分由Lead/后继流程安排，本节点不派发。

### A. 冻结部署前 fixture 与结构化红测
创建 `src/bridge/__tests__/fixtures/fly2662-predeploy/` 及 `scripts/qa-fly2662-closeout-replay.mjs`。受管快照命令只读来源：`node scripts/flywheel-snapshot-control.mjs runner --source <configured-db> --kind teamlead`，Comm同命令 `--kind comm --project flywheel`。输出必须在工具返回的 `/tmp/flywheel-snapshots/<exec>/`，总≤2GB，关闭handles并release。工具不可用不阻塞主问题：按 Lead 在 question 604259b8-b1f3-4428-b02c-953b56cd6ee8 的裁定，允许对照只读查询逐字段脱敏重建；明确标注“非受管快照、形状来源=只读查询”。NULL/空串/字段缺失逐项保持；禁止 cp。
从原快照提取最小闭包：op/run/pinned snapshot/node/attempt/activation/dispatch、merge/other steps、holds、attribution、session/launch/binding、Comm rows/declarations/controls/TURN/wakes。生产exec/run/个人标识按映射脱敏；legacy issue_id/issue_identifier保持同一FLY-xxxx字符串形状且初始不增UUID映射（如替换卡号也保持字符串类型），raw secret字段完全移除；manifest记source time/hash、逐字段映射与缺失来源。必须原样保留旧 NULL targets 与 pending tmux_window，不能调用新代码prepare工厂预补。
先在 baseline head 回放完整 reclose入口→dispatcher→executor→finalization，断言能重现原held/unknown；随后跑修复头相同fixture。Lead 已授权形状重建；当前查询原值和重建值的逐字段映射是验收依据，不再要求额外受管快照。NULL/空串/缺失必须一致；为隔离环境改的身份/路径只按映射替换，不能先经新 prepare 工厂补齐。若当前事故已被人工改过，采用本次保存的只读原值并标明时间；不得把重建实例冒充原始快照。
核心新增类型约定（实现名可随目录拆分，语义不可省略）：
```ts
type LegacyAbsentTarget = {
  kind: 'verified_absent_worktree';
  evidenceMode: 'legacy_absence_observation';
  path: string; branch: string; generation: string; projectRoot: string;
  parentIdentity: { path: string; dev: number; ino: number };
  sourceExecutionIds: string[]; sourceRunId: string | null;
  sourceReceipt: string; observedAt: string;
  // 无删除权限；消费者只能fresh-check ENOENT并记录absent
};
type ReclosePreparation =
  | { ok: true; observed: RecloseObservedTuple; targets: VerifiedTargetRevision }
  | { ok: false; reason: string; missing: string[]; retryable: boolean };
```
`RecloseObservedTuple` 包含§3.4所有CAS键（op/run/node/dispatch/hold/disposition/attribution/merge tuple）；`VerifiedTargetRevision` 包含§3.3 ledger全部字段与目标集合。不可把verifiedActor降成自由字符串，不可用untyped成功对象跳过任一键。

主回归断言伪码，须在隔离fixture适配器上落实：
```ts
const original = loadReadOnlyShapeFixture('old-null-pending');
expect(original.operation.closeout_targets_json).toBeNull();
expect(original.commSession.tmux_window).toBe('runner-flywheel:pending');
const accepted = await authenticatedReclose(original.currentTuple);
expect(accepted.operationId).toBe(original.operation.operation_id);
await driveDispatcherUntilSettled();
expect(effectTrace).toEqual([
  'all_gone', 'all_worktrees_settled', 'records_closed',
  'thread_archived', 'linear_completed', 'operation_and_run_completed',
]);
expect(mergeCalls).toBe(0); expect(ensureShipCalls).toBe(0);
```
另以同一2598/2616 shape令path=ENOENT、historical parent不存在、Git inventory无target，必须到completed且remove/prune/branchDelete调用数为0；把lstat改为EACCES或在commit前创建新目录，则archive/Done均为0。不能在fixture加载器默认补非NULLtarget或parent历史证据。

### B. epoch、目标版本和 guarded replay
修改 `flywheel-comm/src/db.ts`、`teamlead/src/StateStore.ts`，新增retention fragments；补 `CommDB` identity tests、`StateStore.land-lifecycle.test.ts`。先写ABA/stale archive/epoch迁移及非身份列不改变epoch的 red，再实现触发器、ledger/current pointer、claim instance fence。消费者 sweep `rg 'getSessionCloseoutIdentity|commIdentityRevision|recordLandOperationStep|closeout_targets' packages` 逐项改类型、保留只读兼容。测试 schema migrate旧DB两次幂等、crash rollback和retention保护。
### C. 窗口/host补证与分阶段关闭记录
修改 `tmux-lookup.ts`、`execution-closeout-evidence.ts`、`generalized-launch-recovery.ts`、`lifecycle-closeout.ts`、`plugin.ts`、`land-finalization-context.ts`、`post-ship-finalization.ts`、`land-source-session.ts`。补 existing tests 和新 `fly2662-pending-closeout.test.ts`。先pending+env-only活pane red，分别验证全absent可gone、unknown拒绝；用真实CommDB finalizer与current claim验证husk，不能mock authority=true。显式断言effect顺序与nonland不扩runIds。
### D. authenticated reclose + old-operation migration
新增 `land-reclose-preparation.ts` 与 `lifecycle-issue-identity.ts` / tests，按§3.2限定reclose身份映射与guard alias双读、补local legacy veto；新增§3.1 native peer adapter、Bridge窄socket与CLI backend分流及两后端鉴权测试，再修改 `land-intent-targets.ts`、`land-executor.ts`、StateStore resume、`workflow-engine-dispatcher.ts`、hold registry/writers、`lifecycle-routes.ts`、`plugin.ts`、comm `commands/land.ts` / tests。RED从NULL op+错误without-operation hold开始，经过真实事务与下个dispatcher tick仍能继续；然后实现§3。
Darwin真机QA必须使用实际打包native模块和隔离lease/DB：真实Claude Lead工具子进程执行原CLI成功；同UID独立进程复制全部公开tuple仍拒绝；真实注册Runner（含Lead子孙）拒绝；连接peer退出/进程重父化/旧start绑定拒绝；audit pidversion与当前proc身份不匹配拒绝；缺peer权限/能力、symlink/错误目录属主/非0600socket拒绝；HTTP提交Claude public tuple拒绝。记录macOS build、架构、SDK、模块hash、实际peer与holder的脱敏incarnation、exit与零写证据。真实内核正反例不可只mock；PID复用难稳定制造时另加确定性错incarnation注入控制，但不能用它冒充真机socket测试。mode=off且有效bound lease/peer的正向和无lease拒绝分别测；Codex carrier回归。发布前在目标主机由授权QA/Lead运行只读/临时资源自检，Runner不操作生产DB。
分阶段race tests：probe后attribution变化、founder park/wake、owner claim、身份撤销、run换node、目标复建；每案零写或完整回滚。commit后kick丢失可重启接续。重复请求与old op拒绝不影响current；新preparetyped错误写durable hold/alert，有op绝不丢ID。
### E. health与通知
修改 `land-owner-liveness.ts`、land executor announce/catch、StateStore health/outbox、plugin实际通知投递接线；补fake-clock hang/恢复/重启/失权并发tests。告警dedupe基于持久episode，不能靠内存Set。新table加入schema/retention与完整ordered fragment digest校验。常量5min只一份，文档/测试一致。
### F. 完整隔离验收与QA交接
执行manifest中至少两种真实部署前fixture（NULL op 与pending，可重叠），并覆盖点名8卡的不同old/current形状；8卡逐张归属/fixture或Lead实测条目，不要求伪造八次相同绿。每案全链留下receipt sequence：gone→worktree settled→records closed→thread archived→Linear completed→current op/run completed。
先local doubles验证顺序/安全，再sandbox真实Discord/Linear验证幂等与readback。sandbox专用凭据、资源allowlist，脚本拒绝生产 issue/thread/db写路径。doubles结果不能替代远端证据。每种fixture加入活体/unknown控制组，archive/Done调用数为0。分段crash/retry、generation takeover、重复request/不同mergeSha、归档响应丢失readback均覆盖。
生产旧卡只由Lead在修复部署后逐张正门重收尾，在本单记录operationId、generation、command requestId、before/after、目录/Comm/Discord/Linear readbacks与最终result。Runner不能代执行。这是发布后验收待办，不属于design已完成声明。

## 9. 命令与证据要求
以下新增测试/脚本由实施创建；列命令不表示已执行。每条保存head、exit code、Tests实际条数、fixture digest、关键receipt；每批<=6个位置过滤器，No test files found不算运行过；质量门按repo实际脚本完成。
```sh
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/execution-closeout-evidence.test.ts src/__tests__/tmux-lookup.exec-identity.test.ts src/__tests__/tmux-lookup.runner-liveness.test.ts src/bridge/__tests__/lifecycle-closeout.test.ts src/bridge/__tests__/fly2662-pending-closeout.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/land-reclose-preparation.test.ts src/bridge/__tests__/land-intent-targets.test.ts src/bridge/__tests__/land-source-session.test.ts src/bridge/__tests__/land-executor.test.ts src/bridge/__tests__/land-owner-liveness.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/lifecycle-routes.test.ts src/__tests__/post-ship-finalization.test.ts src/__tests__/StateStore.land-lifecycle.test.ts src/__tests__/workflow-engine-dispatcher.test.ts
pnpm --filter flywheel-comm test
pnpm --filter flywheel-teamlead test:stub-hygiene
pnpm --filter flywheel-teamlead typecheck
node scripts/qa-fly2662-closeout-replay.mjs --manifest engineering/doc/FLY-2662-closeout-recovery/evidence/replay-manifest.json --sandbox-only
```
另运行 `fly-2006-database-retention-sweep`、`fly-2413-retention-registry`、`fly-2563-retention-protection`、`customer-release-store`、close-runner/parked-veto/founder-wake/TURN、land-finalize-wiring、shipped-husk tests。新字段/表必须进入ordered migration fragment证据两侧，不能仅改JSON清单。CI exact pushed head绿，QA独立验收，设计不代签。

## 10. 升级、回滚与交接
顺序：additive schema+triggers（含canonical identity map）→ Darwin native包/目标机peer自检与两后端CLI/Bridge proof + reclose范围的canonical/legacy guard双读 + 全consumer双读但只签v2新proof → 正门启用。CLI原可复制命令保持不变，Claude自动走本机peer socket、Codex附现有carrier；同步修改workflow-engine-dispatcher.ts的land reclose告警模板与StateStore held告警的裸POST提示，统一指向可执行CLI；从真实alert/outbox读回文案并在Claude/Codex环境分别解析执行测试。历史已持久化旧文案不覆盖，当前status/hold view生成新指引并保留原episode。
实施PR必须附带带时间戳的消费者sweep：主仓scripts/、packages/；`xrliAnnie/claude-plugins-official`的external_plugins/；本机`~/.claude/plugins/cache/*/`。逐个列出land reclose及lifecycle resume direct HTTP调用点和处置（自动proof、新调用、只读、废弃/阻断），任何root缺失明确写“未检查”，不能当零引用。无master-only后门；full resume行为另测保持。旧hash evidence失效重采；old op NULL保持直到正门补证。新旧worker混跑时旧实例没有新fence权限，不能执行新版closeout；startup capability/schema version guard拒绝旧写者。回滚只停新恢复/清理执行并保留tables/receipts，不降epoch、不删历史、不恢复已经删的目录/已归档thread、不让旧二进制用v2数据库继续破坏性清理。健康正常的其它流程不做全局重构。
验收矩阵：主问题A→§4/C/F；主问题B→§3/D/F；15 findings→§7逐项；design交接→三文档+有效reviewVerdict APPROVED+commit/push+mandatory HTML/托管验证+Lead报告+phase_design_complete+park。
本阶段未做生产收尾、功能测试、真实进程死亡验证或远端Done验收。仅当设计审阅及artifact门通过后交接，不以设计完成替代主问题上线验收。
