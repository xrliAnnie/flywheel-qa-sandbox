# FLY-2655 语音收音恢复 — 评审处置
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-17
基于: plan.md

R1 question e2fa5728-8637-4395-9ac2-e2c5c72ddbd3 / request 2d286aa9-863c-4d60-a1bb-e8172c00fa95；有效 CHANGES_REQUESTED，原始结果见 design-review-r1.json。以下修正待新一轮验证，不把作者意见当作过门。

| findingKey | 级别 | 核验与处置 |
|---|---|---|
| voice-ops-populate-missing-operation-ids | HIGH | 已核 runtime-factory.ts:116 硬拒missing；plan §5.1/6C明确off的三项同时从operations和missing排除，不放松其他能力完整性；新增非opt-in v2完整启动测试 |
| voice-rules-in-cos-file-never-loaded-by-dept-lead | HIGH | 已核 rule-sources dept分支；规则改department-lead-rules，dept装配/manifest hash/运行instructions一起验 |
| receive-error-prefix-whitelist-leaves-transport-decrypt-fatal | HIGH | 已核固定版本receiver catch；当前Opus error通道全部degraded，文字只选dave_decrypt/receive_packet；构建、身份、连接等通道仍fatal |
| resubscribe-does-not-reset-dave-session-state | MEDIUM | §3.3写清重订阅不重置DAVE，持续失败仍无恢复、不得验收绿；只认可后续可解密包/SDK协商恢复。纠正评审细节：lastTransitionId falsy也可能已执行transition 0，不能由throw断言从无transition |
| tools-list-three-items-acceptance-is-unmeetable | MEDIUM | 已核proxy实际lead_operation工具；改查oneOf三项operationId与manifest列表，不查三个独立tool |
| card-patch-shares-the-serial-voice-runtime-tick | MEDIUM | 改独立CardProjector timer+in-flight guard，runtime.tick不await；有界扫描，legacy null健康行不追发，stop取消在途 |
| health-400-fallback-must-not-burn-the-missed-counter | MEDIUM | 改renew内部立即一次无body重试，成功外层miss=0，失败一次计数，409仍fence，明确测试 |
| tolerance-36-is-already-the-installed-default | LOW | §3.1明写当前行为不变，只是默认值锁定，不计作解密修复 |
| voice-codex-has-no-direct-davey-dependency | LOW | 明确从voice-bridge glue解析davey，voice-codex禁止直接import，干净pnpm安装解析smoke |

Follow-ups：原场具体加密失败诱因仍未验证，§7.1与original-session-evidence.json保留下一场取证；Raya自主发起按Lead裁定割接后验。这两项是实现/QA验收义务，不是本设计节点已完成的生产证明。


## R2 有效批准与非阻塞 Follow-ups

R2 question 38b9a049-3317-4b72-b096-b8d3fdaa5531 / request 104498bf-bfd8-4f6b-b50b-b3c3c16a865a；reviewVerdict=APPROVED、reviewerVerdict=APPROVED，原始结构化响应见design-review-r2.json。R1阻塞项已解除。以下4项按门禁返回的advisories报告Lead，不重新开设计、不声称已实施或验证：

| findingKey | 级别 | 交接注意点 |
|---|---|---|
| room-has-no-connection-fatal-channel | MEDIUM | 当前DiscordVoiceRoom并无现成connection error/stateChange通道；实现需明确补监听或承认仅presence/text-stop/lease覆盖，QA不能测试一个假设已存在的通道 |
| assert-lease-in-callbacks-can-crash-the-daemon | MEDIUM | stream/timer内assertLease会同步throw，必须转成有序fence/cleanup，不能冒出uncaughtException；中途失权要验证daemon仍可报告 |
| renew-fallback-doubles-worst-case-http-inside-one-lease-cycle | LOW | 非默认超时组合要检查renewMs + 3×httpTimeoutMs < ttlMs；现有单次HTTP约束不覆盖所有双请求组合 |
| null-health-terminal-rows-keep-the-requested-card-forever | LOW | null-health终态行不在新投影扫描范围，旧根卡可能停在已请求；GET sessionBody是状态权威，不能把静态根卡当作存活证明 |

这些是后继实施/QA可见的具体风险，Lead决定跟进方式；不将它们升级为新的设计硬门禁。完整issue仍需原场协议取证与两组真实验收。

## R3 范围追加待审

R2批准后收到founder 19:42Z直令，Lead指令3954adaf-8f3f-4a57-b10d-11067d3c6593要求登记当前设计复审。plan §7.2取代部署后首测，补独立测试bot共存、slot-only配置/凭据边界、现有装房缺口D2、真人等待/证据/恢复与Lead紧急重启票。不是因R2非阻塞建议重开设计。

## R3 有效批准与处置

question 42655ad9-f6c8-4780-925f-8ba2f3b64d9c / request 5e8c836e-6a1e-4d8a-9d89-0b0952692872；reviewVerdict=APPROVED，reviewerVerdict=APPROVED，7项均为非阻塞advisories，无HIGH。原始响应见design-review-r3.json。新增3项按源码核实后作实施说明勘误，不扩大已批准设计范围：

| findingKey | 处置 |
|---|---|
| test-deploy-expect-head-requires-generalized | plan §7.2选择generalized + mode slot +真实Lead；补--generalized，保留expected-head及built health fence，不能删flag绕过。已有源码test-deploy.sh:254-295、2332-2340核实 |
| qa-voice-channel-allowlist-has-no-enforcement | plan §7.2 D2明确由新launcher在prepare/start断言已审allowlist成员关系、QA分类/类型与实际session tuple；目前Bridge不执行该allowlist。新增错房负向测试要求 |
| slot-bridge-founder-id-not-in-prepare-checks | fixture必填founderUserId，显式投影DISCORD_OWNER_USER_ID；prepare核slot Bridge实际载入的非空owner与登记founder相等，再请Lead邀请 |

R2四项重复advisories继续保留上表Follow-ups：connection fatal listener、callback lease throw、有fallback时超时不等式、null-health根卡限制。后继不能把这些未实施事项当现成能力；不因非阻塞建议另开评审。全部7项会通过ask --report报告Lead。


## 2026-09-18 重起执行的有效复审

Question `29c5e902-978d-497c-8878-96c1fd2fe193`，request `3e7a6844-26c1-4acd-b503-a07b19025545`：effective reviewVerdict=APPROVED，reviewerVerdict=APPROVED，6 MEDIUM + 1 LOW；原始回执见resumption-design-review.json。以下均为非阻断advisory，交Lead裁定follow-up，不扩展本节点到实现、不把观察写成已修复。

- `meeting-mode-default-open-under-voice-opt-in` (MEDIUM): Plan asserts "显式 opt-in，不得默认放开" but the meeting mode it builds on is opt-OUT。处置：保留为Follow-up并报告Lead；未在本节点实施。
- `start-resolver-binds-to-meeting-owner-not-caller` (MEDIUM): §5.1 claims "start 只为自身 project/lead 解析", but a model-supplied meetingId resolves the project/lead from the meeting record before any ownership check。处置：保留为Follow-up并报告Lead；未在本节点实施。
- `d-evidence-commands-silently-skip-most-changed-teamlead-suites` (MEDIUM): §6 D's teamlead command names a test file that does not exist and vitest exits 0 without running it; the named command set also omits most C-group suites。处置：保留为Follow-up并报告Lead；未在本节点实施。
- `bounded-resubscribe-is-inert-against-a-wedged-dave-session` (MEDIUM): The chosen recovery lever provably cannot recover the exact failure class that produced FLY-2655, and the one lever that could (bounded connection re-establish) is excluded without analysis。处置：保留为Follow-up并报告Lead；未在本节点实施。
- `dave-diagnostic-allowlist-cannot-separate-the-7-1-hypotheses` (MEDIUM): §7.1 mandates a four-row verified/disproved matrix that its own debug allowlist cannot produce。处置：保留为Follow-up并报告Lead；未在本节点实施。
- `sdk-debug-carries-the-voice-identify-token-and-is-not-declared-default-off` (MEDIUM): §7.1 enables SDK `debug:true` without declaring it default-off or time-boxed, and that stream carries the voice gateway token。处置：保留为Follow-up并报告Lead；未在本节点实施。
- `identity-digest-does-not-bind-codex-voice-actions` (LOW): §5.1's claim that 编译身份摘要 reads the same raw codexVoiceActions value is not true of the v1 identity digest。处置：保留为Follow-up并报告Lead；未在本节点实施。

解释边界：持续DAVE状态异常时重订阅未必恢复，仍须真人QA失败处理；不从评审推定原场已经确诊为该状态。新的诊断建议不授权输出原始debug/令牌。模型meeting默认、meetingId预检归属及身份digest的观察保留为权限Follow-up，不以本次APPROVED声称这些实现契约已成立。测试命令中的voice.test.ts实际对应bridge-voice.test.ts；后继执行前必须逐个核实路径存在、收集数量与测试覆盖，退出码0不证明所有指定文件被执行。

## 2026-09-18 implement follow-through

Lead 指令 `199fbc72-49a8-465d-8993-c0ff8f1115b9` 将上面三项收进本次实现范围，未重开架构：§6 D 已改为真实 `bridge-voice.test.ts` 并分组枚举 C 套件；DAVE 诊断白名单增加 downgrade/upgrade、invalid transition、pending transition 与 session init/reinit 的锚定脱敏投影；`codexVoiceActions=true` 已纳入 v1 identity digest，false/缺省保持旧 digest 字节。对应实现仍须以本轮代码复审与测试回执为准。

其余四项由 Lead 记入 FLY-2742，不在本单扩展：meeting 默认开放、meetingId owner 绑定、wedged DAVE connection 的有界重建、SDK debug 默认关闭/限时与 token 风险。PR Follow-ups 必须逐项列出。


## 2026-09-18 23Z 接续复审 — 有效 APPROVED

question 237a872c-918f-41cb-8fe7-86e6c2ed6e81 / request 6ea79df4-c7a1-48d7-9db0-a0a701c2cf8b；reviewVerdict=APPROVED，reviewerVerdict=APPROVED。以下全部为服务器判定非阻断MEDIUM/LOW；没有自行建立治理overrule，也没有由design修实现。原始17项完整detail保存在continuation-design-review.json。新项交Lead裁定实现内处置或独立follow-up，不声称已经建单。

| findingKey | 等级 | 发现 | 处置与证明边界 |
|---|---|---|---|
| capability-start-post-reserve-failure-reported-as-rejected | MEDIUM | reserve 之后的 provisioning 失败被报成 rejected/voice_scope_denied，违背 plan §5.2 的 unknown 语义 | 实现已按持久状态投影：provisioning=unknown、failed=rejected(reason)、其余succeeded；operation与receipt focused 5/5。最终代码复审仍待本轮gate。 |
| qa-voice-channel-allowlist-has-no-enforcement | MEDIUM | R3 advisory 仍未闭合：QA 房 allowlist 与 QA Testing 分类检查都是同源自证 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| voice-room-loadslot-rejects-migrated-registry | MEDIUM | loadSlot 对真实 --voice-fixture slot 恒 fail-closed，§7.2 真人硬门禁无法执行 | 源码交叉确认pretty/compact比较和迁移前digest差异；实现优先经真实迁移slot复现并处置，12/12不能替代。 |
| dept-rule-forbids-shell-voice-for-all-dept-leads | MEDIUM | 新增的 dept 规则无条件禁止 shell 和 voice master API，会波及 Claude dept Lead 的运维路径 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| startup-dave-version-diagnostic-missing | MEDIUM | plan §3.1 承诺的启动 DAVE 版本/策略诊断没有实现，§7.1 第 4 行与 §7.2 证据行缺少产出来源 | glue实际加载入口现记录voice/davey版本、Node/arch与策略；wrapper/slot绑定build SHA；每场evidence及QA verify fail-closed校验。bridge 17/17、codex 27/27、harness 13/13。 |
| a-group-red-green-matrix-not-met | MEDIUM | §6 A 组「断言语义不可减少」的清单大部分没有对应测试 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| implementation-changes-outside-plan-scope | MEDIUM | 实现包含 plan 未登记的生产路径改动，其中一项放宽了 fail-closed 安全门 | plan §6/§8已登记与回滚；workspace仅放行macOS固定tmp别名并拒任意symlink，空summary home修正，直接meeting精确输出测试保留。三组focused共46/46。 |
| voice-room-harness-plan-d2-gaps | MEDIUM | QA launcher 未兑现 D2 第 3、4、6 项和收尾合同的多项证明 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| bounded-resubscribe-is-inert-against-a-wedged-dave-session | MEDIUM | （沿用上轮 advisory，仍然成立）有界重订阅对 wedged DAVE 状态无效 | 沿用FLY-2742既有跟进；本轮新增细节一并报告，未宣称已解决。 |
| start-resolver-binds-to-meeting-owner-not-caller | MEDIUM | （沿用上轮 advisory，仍然成立）模型传入 meetingId 时，会先用会议 owner 身份跑 preflight 再比对调用方 | 沿用FLY-2742既有跟进；本轮新增细节一并报告，未宣称已解决。 |
| meeting-mode-default-open-under-voice-opt-in | MEDIUM | （沿用上轮 advisory，并且被本实现进一步放宽）meeting 模式默认开放 | 沿用FLY-2742既有跟进；本轮新增细节一并报告，未宣称已解决。 |
| sdk-debug-carries-the-voice-identify-token-and-is-not-declared-default-off | LOW | 生产所有会话硬开 debug:true（plan 写的是「可启」）；脱敏已核实，但诊断量没有上限 | 沿用FLY-2742既有跟进；本轮新增细节一并报告，未宣称已解决。 |
| stale-health-card-renders-awaiting-not-unknown | LOW | 健康状态过期时卡片显示「等待你说话」，而不是 plan §4.3 要求的「未知」 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| receiving-threshold-counts-frames-across-captures | LOW | 判定 receiving 的 10 帧跨 capture 累计 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| voice-comm-db-override-uses-generic-env-name | LOW | voice daemon 用通用的 FLYWHEEL_COMM_DB 作为全项目覆盖 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| d-commands-omit-voice-core-and-harness-suites | LOW | §6 D 的命令集漏掉了部分已改动的测试套件 | 报告Lead；交实现/QA核实并按范围处理，尚未修复或独立运行验证。 |
| plan-header-status-self-asserts-approval | LOW | 文件头 Status 仍写 APPROVED（R3），但正文在 R3 之后又追加了 §9、§10 | 已将Status绑定当前有效question/request，保留R3沿革。 |


### 最新Lead处置（本轮答复优先；2026-09-18）

权威答复：6249efda-b616-43ff-9a55-8ca3b5124833、682a9bff-9f5b-409c-aad2-615e057cbe0b，原文含「托管仍停用：发布最多试一次，失败记publish-failed，照常phase_design_complete并park」「不再重试」。这不是设计节点自行豁免。

1. voice-room-loadslot-rejects-migrated-registry 纳入本单实现，最高优先，先用经过真实迁移器的slot复现，再修；它直接阻挡语音验收。
2. post-reserve误报rejected、DAVE启动版本证据缺失、生产路径改动未登记：若在本单改动面内随本单处理，否则PR Follow-ups。
3. 其余QA allowlist同源、dept运维规则、A组测试矩阵/D2清理等不新建issue，登记PR Follow-ups。保留既有FLY-2742关联；不自行认定已解决。
4. HTML已提交推送，唯一一次publish-only返回502 report publishing failed，url=null；已报告publish-failed。未执行托管HTTP/CSP/source验证，也不复用旧URL当本轮交付。按Lead最新明确授权完成design并park，后续托管恢复由Lead协调。
