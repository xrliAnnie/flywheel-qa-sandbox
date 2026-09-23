# FLY-2654 Lead 有条件自决 — 评审处置
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-17
基于: plan.md

首轮 request 733c7186-4e3d-48b4-92c6-cf5c94e30374，effective CHANGES_REQUESTED。以下为设计修订，不声称已实现。

| findingKey | 处置 |
|---|---|
| closeout-same-day-hardcoded-tz | 修复 §5.1：既有 resolver，当前权威时区，producer/consumer 重算与旅行反例 |
| raya-standing-migration-may-reset-unresolved | 修复 §4.2.7：新增 adopt-standing 原地 CAS，仅改 authorization/history；禁止 init/resume 重建；非空证据保留反例 |
| rule-budget-headroom-unbudgeted | I1 先核预算；新操作细节可外置，既有权限正文不动、不降门槛 |
| entry-digest-extraction-undefined | §3 确定 BEGIN/END 与 UTF-8 LF 原始字节提取、extractionVersion |
| requestedby-attribution-unauthenticated | §5.2 回读 bot author 与 registry 映射、播报绑定 decision/scope/intent |
| admission-fence-ordering-unspecified | §5.3 固定 pause lease 后重新枚举完整范围，再允许首次 stop |
| urgent-wave-raya-cutover-not-in-announcement-scope | §5.1 纳入 brain/voice legacy owner 与割接影响，显式播报 |
| no-daily-cap-on-lead-closeout-tickets | §5.3 intent 只能派生一个实际 wave；零副作用重试同 wave revision，持久计数 |
| prestop-retry-flag-not-named-in-refresh | §4.2.4 显式设 prestop_retry，未知发送不可清除 |
| auth-canon-b-governing-sentence-not-listed | §2.3 / I1 点名替换规范原句 only R3 |

本轮曾新增 standing continuity；第二轮指出闭包证明不可兑现，已按下表撤回，不保留为授权路径。

## 第二轮处置
request `45e1665b-3020-4c84-b47f-d17d14ccd2ce`，effective CHANGES_REQUESTED；首轮两个 HIGH 已不再出现。

| findingKey | 处置 |
|---|---|
| continuity-closure-unverifiable | 删除自动 continuity/依赖闭包续签。enforcementDeployedCommit 变化必须独立 confirmer 核验新 manifest revision；条款不变不再找 founder；仅 Raya 业务更新不触发此门 |
| livebundle-source-unnamed | 点名 active.json + check-rules-truth live 进程绑定；不把规则 hash 当 enforcement 证明 |
| adopt-standing-lock-owner-plumbing | 明确 shuttle 白名单、--lock-owner、ppid/pid/start 校验及非班车自获取锁分支 |
| lead-mode-pause-must-not-harden-rollback-site | 必需成功只限主部署 Step 0；rollback 保持 WARNING + best-effort 恢复 |
| entry-marker-budget-not-counted | 全部标记、AUTH-CANON 列举、导语都计入预算 |

## Lead 范围重裁
第三轮 effective APPROVED，三条 advisory 仍存在；完整原文保存在 plan.md Part B 与 review-round3.json。作者未把“每班都等确认”的功能缺口当作已交付，而向 Lead 报告并请求裁定。
- 3262d907-45d1-446c-9fcf-7edc13d3073b：Raya 暂停，原设计原样保留，拒绝新增复杂的依赖闭包机制。
- 4c50f935-1aec-489b-868f-ee050a68ceab：Part A 进一步缩为 AUTH-CANON(A) 条件式单次 founder 指令识别与审计；原三条件 standing 同归 Part B。
- 新 Part A 无 activation 部署循环、无 old/new activation 绑定、无 Claude-only liveBundle 门；保留精确 from/target 与 pre-stop source 收敛边界。
- 有界复审范围：Part A + 证明 Part B 完整隔离。若再有 HIGH，按 Lead 指令返回 ask，不自行重开更多设计。

## 有界复审运输失败与重试
request `23cc8d5f-1552-448d-abfd-d13a8d0ba77b` 以 no_verdict 失败，没有有效判决。Lead 指令 `[lead-instruction ec106d4d-6c4b-4507-a164-73bcef60a2e3]` 要求先自查 stdout 中时间框/时态两项再用同 requestId 重试：A2/A3/A6 已明确自然语言窗口优先、完全无时间框才 24h；样板是条件式 issue_fix_landed，不能凭“了/马上”判 immediate。Part B 按同一指令标记关闭、由 FLY-2679 取代，内部原文保留。

## 有效最终判决
同 request `23cc8d5f-1552-448d-abfd-d13a8d0ba77b` 重试后的 round 4：reviewVerdict=APPROVED，reviewerVerdict=APPROVED，0 HIGH。完整回执 review-final.json。依 Lead 有界指令停止扩展设计，七条 advisories 作为 handoff.md 的 Follow-ups 交 Lead 处理，不再次登记评审。

## QA rework 后代码复审处置

精确头 `d36029959` 的代码复审 request `017940d5-bd35-49b7-b497-90f39c4b3c60`
为 `CHANGES_REQUESTED`。三项 HIGH 处置如下；MEDIUM/LOW 保留为非阻塞 advisory，未在
本轮借机扩 scope。

| findingKey | 处置 |
|---|---|
| restore-premerge-env-never-visible-to-updater | `default_deploy` 在 checkout mutation 前将 conditional ticket 的 target/from/preMerge/trigger/wave/index/CLI 证据导出到父 shell；新增经 `default_deploy` 的 rc82 restore 红绿测试 |
| trigger-evidence-not-bound-to-named-issue | GitHub PR 回读提取 title/body/head ref 的精确 issue ids，固定 repo 为 `xrliAnnie/flywheel`，条件票必须匹配同一 issue |
| immediate-assertion-regex-accepts-a-refusal | 源消息先执行 REVOCATION 筛查；英文 immediate token 使用边界，补否定消息及 `snow`/`knowing` 子串反例 |

修复提交为 `729e570de`；必须在包含后续文档提交的最终精确头上开新 gate/request，旧 verdict
不复用。

### QA rework 代码复审第二轮

request `b5781237-abc3-458c-87e2-e6535ff96e1b` 在精确头 `a9a3cd09b` 上仍为
`CHANGES_REQUESTED`。唯一 HIGH `immediate-assertion-regex-accepts-a-refusal` 指出首轮只
覆盖了已报告的否定字面量，仍可把日常拒绝或完成态问题当成 immediate 授权。

`07ee4a89b` 不再使用“现在/已经”关键词作为充要条件，改为正向即时重启请求语法；重启
附近的否定表达拒绝，含询问标记时仅允许明确 permission request。reviewer 给出的两条
反例均先红后绿，founder 原始请求式问句另有正向测试。其余 5 MEDIUM、2 LOW 按
`policyNote=medium_low_findings_are_non_blocking_v1` 保留为 advisory，不在该 HIGH 修复中
扩展权限或运行机制范围。新最终精确头仍必须重新 review。

### QA rework 代码复审第三轮

request `2519c07a-94fa-4deb-88c7-960b80eac0b7` 在精确头 `cef09ccd8` 上为
`CHANGES_REQUESTED`。唯一 HIGH `immediate-branch-accepts-conditional-instruction` 证明
新增“马上”正向语法会接受 plan.md 的 canonical 条件样板，令 caller 通过改标
`trigger.kind=immediate` 绕过 PR、merge 与 verdict 证据。

`64aafb47f` 增加条件词/完成态联合门：含条件词的 immediate 必须有明确 `已经/已`
或英文 completed-state assertion，否则拒绝。canonical 样板先红后绿，明确完成态正向例
保持通过。其余 MEDIUM/LOW 继续按 policyNote 作为 advisory；新最终头必须重新 review，
不能复用本轮 verdict 或同头尚在运行的 CI。

### QA rework 代码复审第四轮

request `bfa3ff72-03f6-442c-ae72-fce927875202` 在精确头 `e830a92eb` 上为
`CHANGES_REQUESTED`。唯一 HIGH `immediate-branch-accepts-conditional-instruction`
证明第三轮的固定条件词/完成态组合仍可绕过：攻击者可先声称一个对象已经完成，再把真正
等待的另一张 issue/PR 写进同一条 immediate 消息。

`50d92ebf1` 删除完成态字面量例外，改用结构性缺省拒绝：原文只要点名 issue/PR 对象，
或含中英文条件框架，就不能走 immediate，必须回到 conditional v2 的 PR、merge、verdict
核验。reviewer 的五条精确反例全部形成红绿测试；object-free 的 founder 当前直接请求仍
由既有正向测试覆盖。MEDIUM/LOW 继续按 policyNote 作为 advisory；必须在包含本修复与
literal-last milestone 的最终头上取得新 verdict。

### QA rework 代码复审第五轮

request `3ff31337-b0d9-4358-8e70-17171abd79c7` 在精确头 `73c7c5e6e` 上为
`CHANGES_REQUESTED`。唯一 HIGH `immediate-branch-accepts-conditional-instruction`
指出第四轮用结构门替换了旧条件词门，因此以自然语言而非 ID 点名对象的
`Raya 那边修好了马上重启` 等消息重新可以绕过 conditional evidence。

`fa767c99e` 采用 reviewer 指定的并集：命名 issue/PR 或条件框架始终拒绝 immediate；
含 `修好/修复/合入/完成` 等条件动作而无明确完成态断言也拒绝。旧正则的裸 `后` 被移除，
避免误伤 `然后/最后`；五条精确反例先红后绿，并新增普通顺序表达正向回归。MEDIUM/LOW
仍按 policyNote 保留为 advisory；新最终头必须重新 review。

### QA rework 代码复审第六轮与 CI inventory 修复

request `18dce2d7-e3db-4f16-98ee-0fb5387a9c1d` 在精确头 `ff040b691` 为
`APPROVED`，0 HIGH；所有剩余 findings 均为 MEDIUM/LOW advisory，并已结构化报告 Lead。
同头 CI run `35317662046` 随后在 packaged gate④ 发现 `FLYWHEEL_RESTART_REPO` compiled
line 未注册。`efc0f859a` 仅补 exact-line inventory 与 customer-path disposition；smoke
25/25、package-onboard 34/34、forms 12/12、masking 13/13。由于 HEAD 已移动，第六轮
APPROVED 不复用，必须在新 literal-last 头开新 code review 与 CI。

### 主分支同步后代码复审 R1

request `a5910828-d111-4a5f-9b17-018339b10f0c` 在精确头 `49f0e8d4c` 为
`CHANGES_REQUESTED`。本轮只处置两项 HIGH，MEDIUM/LOW advisory 不扩 scope：

| findingKey | 处置 |
|---|---|
| conditional-branch-accepts-restart-refusal | 把 `RESTART_NEGATION` 提升到所有 trigger 的共享 source gate；`issue_fix_landed` 的“不要马上重启”和 `pr_merged` 的“别急着重启”各自先红后绿 |
| founder-direct-v1-target-must-equal-tip | 仅 schema v1 恢复 ancestor-of-main 语义并部署 fresh tip；conditional v2 继续要求 ticket target 精确等于 origin/main，checkout 前二次冻结不变 |

修复提交 `484ab5e28`。TypeScript 59/59、updater source 44/44、触碰文件 Biome/Bash
syntax、根 lint 与 recursive build 均通过。新头必须重新 review；旧判决不复用。

### 主分支同步后代码复审 R2

request `6a68e06d-8050-457c-acac-2fe1699aec1a` 在精确头 `c7528e035` 仍为
`CHANGES_REQUESTED`；唯一 HIGH 仍是
`conditional-branch-accepts-restart-refusal`。共享否定 denylist 已挡住 R1 原句，但
conditional issue/PR 仍未证明 founder 给出了正向重启指令。

`1e4fe2461` 要求 conditional source 含受控正向 directive（马上/立即/立刻/直接/尽快/就
重启，明确“几点前重启”，或英文 immediately/right away/asap/as soon as），拒绝保留
决定权的问我/我来决定/等我确认/check with me/ask me，以及未匹配 permission-request
形式的疑问句。reviewer 五条原样反例和一条 PR question 均先红后绿；既有明确
“今天晚上 11 点前重启”正向用例保持通过。TypeScript 65/65、触碰文件 Biome、根 lint
和 recursive build 均通过。MEDIUM/LOW 继续作为非阻塞 advisory；下一轮是 Lead 指定的
R3 上限，若仍有 HIGH 则 ask Lead 裁决。

### 主分支同步后代码复审 R3 与 Lead 裁定

request `3453053e-420b-4e55-aa23-a3d05bd8ec77` 在精确头 `cf2064b44` 仍为
`CHANGES_REQUESTED`。同一 HIGH `conditional-branch-accepts-restart-refusal` 证明裸
`就` 可把重启转交班车，现有 deferral 清单也漏掉了等待 founder 后续同意的表达。复审
给出的五条原句全部能产生 v2 票，故不是文案 advisory，而是把非授权当授权的阻断风险。

按 Lead 对问题 `485cc07c-a00f-4ef0-8cd5-f768bb4d3aee` 的最终裁定，本轮不再扩充
自然语言 allow/deny 枚举：未来条件、推迟、转交或等待后续同意的消息一律不是授权；只有
消息明确断言点名条件已经完成，并给出当前、无条件、立即重启指令时，才允许走带精确
issue/PR 证据的 v2 路径。五条原样反例先 5/72 红；两条已完成且当前无条件的 issue/PR
正例锁定保留路径。

`1bf0e8db0` 删除宽泛 conditional directive allowlist，并要求 completed-state assertion、
current immediate request、无 conditional framing、无 founder deferral；询问句仍只允许
明确 permission request。修后 TypeScript 72/72、触碰文件 Biome、根 `pnpm lint` 和
recursive build 均通过。若下一轮仍有 HIGH，不再自行改代码，必须把 findingKey 与证据
交 Lead 通过 review-ruling 收口。

### 最终 R4 复审与 Lead 有界收口

request `7a966ea0-7c1a-416c-8226-f516e9907f8c` 在精确头 `142ae03f7` 返回
`CHANGES_REQUESTED`。`conditional-branch-accepts-restart-refusal` 证明“已完成 A”仍可
夹带“等 B 后/QA 以后”的未来从句；`r4-rule-text-contradicts-final-authority-ruling` 证明
R4 权限正文和三份运行指引仍把未来条件消息写成免重复授权。两项均为 HIGH。

按约先在 question `e8151533-edc9-4761-ae44-53f701264e5e` 请求 review-ruling。Lead 未
overrule/follow-up，而给出最后一个有界修复：从拒绝词枚举换成完整正向语法；未来条件只
触发到时再问 founder；同步 R4 与 runbook。`c52f0d607` 因此只接受“精确对象已完成断言、
当前直接命令、可选受控 deadline”的整条消息，额外从句或 caller 自选的时间表达均
拒绝。R3/R4 九条原样反例、三条正例、九个正例拼接性质反例与 time-expression 注入反例
均入库，TypeScript 87/87；规则 receipt 5/5、预算 2/2、根 lint 与 recursive build 通过。
