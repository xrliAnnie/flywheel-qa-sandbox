# FLY-1501 聚合告警+重启风暴上限+注入垫片 — 实施计划
Issue: FLY-1501 (https://linear.app/geoforge3d/issue/FLY-1501/v2批次2-聚合告警-重启风暴上限-注入垫片vendor-neutral)
日期: 2026-07-27
基于: research.md

> 设计权威:doc/engineer/plan/v2/design-FINAL-v2.md(Codex R13 APPROVED)§3.1/§3.2/§2.11/§2.4a + design-chain v7-v13 细节。本 plan 忠实落地已批机制,只裁工程落点;机制级偏离=零。
> brainstorm gate:Tadashi 2026-07-27 全条批准(含台账1 scope 收窄至 v2 侧、软窗预约制、CLI 必填参数)。C5 于 2026-07-27 冻结,W4 已解锁。
> **Codex design review:11 轮 APPROVED(2026-07-27,xhigh)**。R1 5H+2M→R2 3H+2M→R3 1H+2M→R4 1H+1M→R5 2M→R6 1H+1M→R7 1H+1M→R8 2H+2M→R9 1H+1M→R10 1H→R11 零保留 APPROVED;全部 findings 采纳零拒绝(逐轮修订见 git log 与 /tmp round1-11 反馈稿)。implement brainstorm gate 已签 C4/C7;仅 C5 未冻结,W4 vendor shim 继续 blocked(见 §4)。

## 0. 设计勘误留痕(归档原文不改)

**E-1**:终版 §3.1 要求 obligation `payload={count,oldest_age}` 就地更新(design-v6.md:99/design-v7.md:80),但 §1.1 列清单从未声明 payload 列,批次1 0002 迁移忠实实现 §1.1 → 列缺失。**以 §3.1 行为要求为准,补列于迁移 0005**(Tadashi 预批,D14 范式)。

## 1. 交付物总览(6 个工作块)

| # | 块 | 落点 | 新/改 |
|---|---|---|---|
| W1 | 迁移 0005:obligations.payload | packages/v2-kernel/src/migrations/ | 新 |
| W2 | 聚合告警引擎(§3.1+§3.2) | packages/v2-kernel/src/alerts/ | 新 |
| W3 | 重启风暴 gate(§2.11) | scripts/restart-storm-gate.py + **5 个 supervised 入口集成**(bridge/voice-bridge/lead/quota-monitor wrapper + cmux-autostart supervised 分支)+ 告警 kind 五面 parity + v2-kernel spool 投影 | 新+改 |
| W4 | 注入垫片 vendor 实现(§2.4a) | packages/v2-engine/src/injection/(C5/C7 已签) | 新 |
| W5 | 台账2:软窗预约制 | workflow-engine-dispatcher.ts + 节点模板 config | 改 |
| W6 | 台账3:CLI footgun + 台账1:清死旋钮 | flywheel-comm index.ts/codex-review-result.ts + config truth.ts | 改 |

## 2. 工作块明细

### W1 迁移 0005(先行,W2 依赖)
- `packages/v2-kernel/src/migrations/0005-obligations-payload.ts`:`ALTER TABLE obligations ADD COLUMN payload TEXT;` 注册进 migrations/index.ts。
- 重放语义(Codex R1-6 修正):正常二次运行由 schema_migrations 账本跳过——**测试=ledger skip**,不写"duplicate column 容忍"(migrator 无该 seam);漂移态(列在、账缺)按现行为响亮失败,plan 留痕接受。
- 测试(obligations-migration 扩展):旧行 payload=NULL 合法;加列后 0002 全部 CHECK/触发器/episode 唯一索引仍生效(变异:故意双 open episode 断言仍被拒)。

### W2 聚合告警引擎
文件(research §1.1 模块图):
- `alerts/tiers.ts`:`tierFor(ageMs)`(1:≥30min/2:≥2h/3:≥8h)+ 常量;纯函数。
- `alerts/mailbox-age.ts`:`runMailboxAgeTick(kernel,{nowIso})`——枚举 consumer_registry → 每收件人一个 immediate 事务四步(research §1.2 伪代码为准):DETECTOR_SQL 原样(不得改写)→ episode upsert/tombstone+cancel → payload 就地更新+recipient 重推导 → tier 变化插 notify command(先查抑制,被抑制记债)。effect_key=`notify:<obligationId>:t<tier>`。
- `alerts/suppression.ts`:`SUPPRESSION_RULES`(仅 (agent_down, mailbox_backlog) 一条)+ `canClaimNotifyCommand(tx, command)`(C1)+ `onNotifyCommandReceipt(tx, commandId)`(C2,CAS last_notified_tier 单调)+ **`onParentObligationOpened(tx,{parentKind,subject})`(C3a,Codex R1-2 补:1500 在插入 parent obligation 的同一事务调用——对匹配 open 子按规则记 suppressed_tier 债,不动 command state)** + `releaseSuppressedChildren(tx,{parentKind,subject})`(C3b)+ `reconcileSuppressionDebt(kernel)`(兜底,tick 顺带)。
- **NotifyCommandPayloadV1 定型(Codex R1-2)**:`{v:1, obligation_id, child_kind, subject, tier, count, oldest_age}`——**不含权威 recipient**;`cutover_epoch`=读 meta 键 'cutover_epoch'(缺省 0,切换手册批次3 写入);`created_at`=事务内时钟。receipt 成功条件类型化:command CAS `state→'succeeded'`+`result_code='succeeded'` 的同一事务内调 C2。
- **recipient 发送时实时解析(Codex R1-1 + R2-1 修正,结构性消 stale)**:notify command 不携带权威 recipient;`resolveNotifyRecipient(tx, obligationId)` 冻结为**从 obligation 的 subject(target_agent_id)出发、读 live consumer registry 推导**(runner→registry 值 ownerLeadId/缺失→founder;Lead→founder)——**不是返回 obligation 缓存列**;同一事务顺带刷新 obligation.notify_recipient_agent_id 缓存(缓存仅供审计展示)。1500 的唯一调用点=**execute/effect handoff 时**(非 claim)。owner 换代与发送之间无需任何 tick 介入即命中新 owner(A4 按此断言)。
- `alerts/restart-storm-reconcile.ts`:`reconcileRestartStormSpool(kernel, {ledgerRoot, gateHelperPath})`(W3 的 kernel 侧投影;**绝对 ledgerRoot 注入,TS/helper 从它共同派生 spool/applied/lock 路径,不依赖隐含 HOME**,R4-2)。
  - **全历史幂等键(R4-1 修正:episode 唯一索引是 partial WHERE open,只保证同刻一条 open,不保证历史恰一)**:投影 obligation 的 **id 由 episode_key 确定性派生**(`restorm:<episode_key>`,PRIMARY KEY=全历史 exactly-once);重放命中既有 id→校验 immutable projection 字段一致后 no-op——**绝不 reopen、不改已关闭 state、不建第二行**(首条被 resolved/tombstoned 后重放也不再建)。
  - **校验前置(R4-1)**:exact spool schema+filename↔episode_key↔child_key↔window 一致性校验在 **kernel 事务之前**执行;合法才走 ①kernel.write 幂等投影 ②DB commit 后 execFile `restart-storm-gate.py mark-applied --root <ledgerRoot> <child_key> <episode_key>`(helper 校验 child/episode 不得逃逸 root,自己取同一 <child_key>.lock、校验 live/applied、durable move+目录 fsync)。
  - **invalid-spool 可达处置合同(R5-1+R6-1 TOCTOU 修正)**:pre-validation 失败→①记诊断 events 行(冻结,R8-3:**event_uid=`restorm-invalid:<basename>:<digest>`**——digest 入幂等键:同字节重放恰一条,**不同非法字节各得独立审计行**;kind=`restart_spool_invalid`,payload={basename,reason,digest},cutover_epoch=meta 'cutover_epoch' 默认 0;重入上限耗尽另记 kind=`restart_spool_retry_exhausted`,event_uid=`restorm-exhausted:<basename>:<digest>`)②调 helper **`quarantine --root <abs> --file <basename> --digest <fingerprint>`**——**fingerprint=类型化联合(R10-1):`sha256:<hex>` | `nonregular`**(validate 对 symlink/目录经 **lstat(绝不跟随 symlink)** 判非常规时输出 `nonregular`,不再用裸哨兵)。**helper 两类锁(R6-1,消同名换入合法文件被误移的 TOCTOU)**:basename 能安全派生 child/episode→取**同一 `<child_key>.lock`**(与 canonical writer 线性化);不能映射任何合法 gate 目标的 basename→root 级 `_quarantine.lock`。两类都在**锁内按指纹状态机复验(R10-1 冻结,lstat 判型不跟随 symlink)**:①条目已不在→0(幂等);②期望 `sha256:` + 仍 regular 且 digest 匹配→durable rename spool/→quarantine/+fsync 目录→0;③期望 `sha256:` + digest 不匹配→**6**;④期望 `nonregular` + 仍非常规→durable move→0;⑤**期望 `nonregular` + 现为 regular 文件(gate 已换入合法 spool)→6**——绝不移动新文件;⑥lstat/读可重试错→**75**(live 原样留待下轮)。**exit 6=非终态(R7-1)**:同一次 `reconcileRestartStormSpool` 调用收到 6 后**就地重入该 basename**(重新 validate 新字节:合法→投影+mark-applied;仍非法→新 digest 记事件+再 quarantine),**每 basename 每次调用重入上限 3 次**,耗尽后文件留 live 可重试+记 events 行(不依赖 kernel 重启或下次调用才收敛)。退出码:0=已移/已不在;6=指纹不匹配或类型翻转(调用方必须重入);75=可重试 I/O;2=锁竞争(下轮重试,事件已记不重复);4=逃逸或用法错。TS 仍零 rename/零锁。
  - 返回语义:0=已移或 applied 已在(幂等成功);75=锁竞争→本轮跳过下轮重试;非零其他/helper 缺失→spool 留 live 下轮重试(id 幂等,不重复 obligation);内容不匹配→helper 侧 quarantine+非零,reconciler 记 events 行不移。
  - **真实双进程测试**(用与 HOME 默认不同的临时 root,证明双方竞争同一 lock、移动同一文件):Python gate 持锁期间 TS reconcile 不得移动,释放后恰移一次。
- index.ts 导出上述公开面;**public-api 精确守卫测试(`__tests__/public-api.test.ts:27-45` exact 断言)同步更新**(Codex R1-2)。

recipient 推导:runner→registry 值的 `ownerLeadId`;**C4 精确 shape(Codex R1-1,2026-07-27 brainstorm gate 已签)**:runner identity 增**可选** `ownerLeadId`(present 时非空 string),`parseIdentity`/`writeRegistry` 双形接受(additive 向后兼容;fence.ts 属 v2-kernel 共享底座,变更由本单实现、1499 注册事务写入);缺失 fail-safe→'founder'。Lead→'founder' 常量。W2 先落 additive reader+fail-safe;1499 注册写入落地后 live recipient 自动翻转。

### W3 重启风暴 gate
- `scripts/restart-storm-gate.py`(stdlib only):**六子命令,退出码按 subcommand 穷举(R4-2+R5-2+R8-2)**——gate(0=放行 exec/3=held 不 exec/2=锁竞争/4=状态损坏或用法错,均 fail-closed)、resume(0=成功或幂等 no-op/2=锁竞争/**4=state 损坏或用法错——损坏绝不返 0**)、status(只读短 EX;0=输出状态/2=锁竞争/**4=state 损坏或用法错**)、mark-applied --root <abs> <child_key> <episode_key>(reconciler 专用:0=已移或已 applied 幂等/75=锁竞争/5=内容不匹配已 quarantine/4=参数逃逸 root、损坏或用法错)、**quarantine --root <abs> --file <basename> --digest <fingerprint:sha256:<hex>|nonregular>**(R5-1+R6-1+R7-1+R10-1:两类锁+锁内指纹状态机(lstat 不跟随 symlink);0=已移/已不在、**6=指纹不匹配或 nonregular→regular 翻转(非终态,调用方同调用内重入)**、75=可重试 I/O、2=锁竞争、4=逃逸或用法错)、**validate --root <abs> --file <basename>**(R8-2+R9+R10:只读无锁;0=合法+stdout JSON **{child_key,episode_key,window_start,seq,count,digest}**/5=可读但非法(含非常规条目,fingerprint=`nonregular`)/**7=已不在(幂等跳过)**/**75=可重试 I/O**/4=逃逸或用法错)。**用法/root 校验统一合同**:任何子命令收到非绝对 root、缺参、未知参→exit 4(fail-closed 家族),绝不静默成功。全部子命令可选 `--root <abs>` 覆盖默认 `~/.flywheel/restart-ledger`(TS/helper 共同派生 spool/applied/quarantine/lock 子路径)。**锁竞争码不对称留痕**:gate/resume/status=2(wrapper 语境"非 0 即不 exec"),mark-applied/quarantine=75/2 按上表(75 沿 config-lock EX_TEMPFAIL 惯例供程序化重试)。工件格式+启动分支穷举:**本 plan W3 各条为唯一规范合同**(R6-2;research §2.2/§2.3 仅作背景与演进史,冲突处以 plan 为准),v13 终态要素=单调 seq、last_resumed_seq 下界、resumed 立即 CAS、可重放谓词 count≥6、spool no-clobber link 发布 exactly-once、meta-alert at-least-once。
- 锁:fcntl LOCK_EX|LOCK_NB 有界重试(flywheel-config-lock.py 模式);**全部写者同一锁**。
- **episode/文件名跨语言文法(R7-2 冻结,R8-1/R8-4 修订)**:child_key 文法=**`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`(对齐现有 ProjectConfig SAFE_ID 域:大小写保留、允许 `__`、上限 128)**;**解码=从右侧按固定结构剥离**(末段=window seq(纯数字),倒数第二段=UTC 紧凑时间戳 `YYYYMMDDTHHMMSSZ`,其余前缀=child_key 原样——child_key 含 `__` 也能无歧义 round-trip);**episode_key=`<child_key>__<YYYYMMDDTHHMMSSZ>__<seq>`**(seq=窗口首事件的 ledger seq,R8-4:同秒 resume 后再风暴也绝不碰撞——seq 单调,v13 本就以 seq 为序权威);state 文件/spool 文件名 `<episode_key>.json`/lead-alert signature/obligation id 后缀全部用此唯一形。**上游合同封口(R8-1,不在 wrapper 侧改写/截断/小写化——那会造成双权威别名)**:gate CLI 对超长/非法 child_key exit 4;同时在 **ProjectConfig/manifest 物化点加派生 restart child_key 不变量校验**(W3 触点清单列入 ProjectConfig.ts 相应校验函数)——config 边界先拒,杜绝"上游合法、gate 永拒"的服务性中断;部署前兼容性检查=枚举现有 fleet 全部 child_key 过 round-trip。encoder/decoder=gate 脚本内**单一 Python 函数**,ensure-spool 与 quarantine 分类都调它。round-trip/拒绝测试入验收(大写/含 `__`/超 128 在 config 边界各一例+证明无上游合法值会被 gate 拒)。
- **TS 事务前校验经 helper(R8-2+R9 收口)**:helper 增第六子命令 **`validate --root <abs> --file <basename>`**(只读、无锁——digest 锚定使后续 quarantine 决策免疫替换竞态):解码文件名+校验 exact spool schema+filename↔payload 一致性。**成功 stdout=完整类型化投影记录(R9-1)**:`{child_key, episode_key, window_start, seq, count, digest}` + 未来任何投影不可变字段——**TS 只准从这份 stdout 记录建事务,绝不重开 spool 文件**(重开=第二解析器+字节漂移);类型界冻结:count/seq=正整数(count=窗口内事件数,schema 必含)。**退出码穷举(R9-2,竞态是本协议自身并发模型的预期路径,不折叠进用法错)**:0=合法+JSON;5=可读但非法(reason+digest;非常规条目(symlink/目录,lstat 判型)同走 5,fingerprint=`nonregular`,quarantine 锁内状态机处置(见 invalid-spool 合同⑤:翻转为 regular→6 重入);**7=文件已不在/已被移走(幂等跳过,零 DB 行,干净完成)**;**75=可重试 I/O 错(live 条目原样留待下轮 reconcile)**;4=逃逸或用法错。TS 行为绑定:7→跳过该文件不记事件;75→跳过并留待下轮;5→事件+quarantine;0→投影。"合法 JSON 但非规范 episode 文件名"→5→零 obligation+quarantine(DB commit 前拦截)。
- **磁盘协议 crash-safe 收口(Codex R1-5)**:
  - spool 发布(R2-3:POSIX rename 会覆盖终址,不产生 EEXIST)=同目录 tmp 完整写+fsync(fd)→**no-clobber 原子发布:link(tmp→终址)**(终址已存在则 EEXIST 失败;仓内先例=v2-kernel backup.ts:76-92 linkSync)→unlink tmp→fsync 目录;EEXIST→读终址校验 episode_key 一致=幂等成功,不一致/不可解析→quarantine 子目录+meta-alert,fail-closed 不 exec;**ensure-spool 同时查 live 与 applied/ 两处**(applied/<episode> 存在=已投影成功的 receipt,幂等成功);
  - **reconciler 的 live→applied 移动必须持同一 <child_key>.lock**(R2-3+R3-1):锁桥=gate 脚本新增 **`mark-applied` 子命令**(取锁+校验+移动+fsync 一体),TS reconciler 只 execFile 调它(见 W2 reconcile 条目返回语义)——否则 Discord 腿还 pending 时 reconciler 移走 live 文件,下次 gate 重复发布同一 episode;
  - ledger append 的 partial-tail 恢复规则(唯一,R2-3):锁内先定位最后完整换行、**truncate 掉残尾+fsync**,再分配 seq(=最后完整行 seq+1)、append、fsync——不截断直接 append 会把新行拼进残尾变中部损坏;中部损坏→quarantine+exit 4;
  - 告警腿→状态转移映射(唯一定义,R2-2 修正):桌面腿(meta-alert.sh)纯 best-effort 不参与判定;Discord 腿 `lead-alert.sh --strict-delivery` stdout 结果 **∈ {sent, queued_transient}(真 durable receipt)→允许 CAS pending→attempted**;**duplicate→保持 pending**(它只证明另一进程暂持 lease,不证明落下 durable receipt——若持 lease 者在 POST 前崩,attempted 即静默漏报;lease 到期后下次启动重试收敛);{dead_lettered, config_error}→保持 pending,下次启动(launchd KeepAlive 30s 节奏)重试重发——at-least-once 的重试通道。
- 告警双腿(零新通道):meta-alert.sh(marker mtime debounce)+ lead-alert.sh `--kind restart_storm_hold --signature <episode_key> --strict-delivery`。**新 kind 全面 parity(Codex R1-4,非"白名单一行")**:`scripts/lead-alert.sh` shell 白名单 + `LeadAlertNotifier.ts` `ALERT_EVENT_TYPES` union + `kind-contract.ts` 穷举 `KIND_CONTRACTS`(owner/arc/remediationRef)+ `infra-event-router.ts` 路由分类 + 既有 parity 测试(`kind-contract.test.ts:341-349` 会拒 shell-only kind)全五处同步。
- wrapper 集成(`|| exit 0`),**插入点=最后一次无副作用校验之后、任何本次-child running marker/PID 写入之前**(Codex R1-4):flywheel-bridge-wrapper.sh(bridge;preflight 判定后、PID 锁写入前)/flywheel-voice-bridge-wrapper.sh(voice-bridge,同位)/flywheel-lead-wrapper.sh(lead.<project>-<lead>,manifest 推;PID 写入前)/flywheel-quota-monitor-wrapper.sh(quota-monitor;**RUN_MARKER 写入前**——否则 held 会被下次启动误判为 child crash)/**flywheel-cmux-autostart.sh supervised exec 分支(cmux-watcher;plist KeepAlive=true 已实证,明确入 scope 非待核实)**。**上游触点(R8-1)**:ProjectConfig/manifest 物化点加"派生 restart child_key 过 gate 文法 round-trip"不变量校验(config 边界先拒)。验收补:held 不制造任何 legacy crash-streak/marker 污染。
- env 旋钮:`FLYWHEEL_RESTART_STORM_WINDOW_SEC=600`/`FLYWHEEL_RESTART_STORM_MAX=5`;`FLYWHEEL_RESTART_STORM_GATE=0` 旁路(字节兼容逃生口:不设=启用;=0 时 gate 直接 exit 0 不记账)。
- 单一 authority:claude-lead.sh 进程内循环**不改不计数**;Runner 不进本机制。

### W4 注入垫片(**C5/C7 已签,已解锁;Codex R1-3 修正投递链事实**)
- 接口=1499 定义并冻结:`hint(sessionRef)` + `deliver(sessionRef,{messageUid,payload,attemptUid})`;deliver 可重复、hint 可 no-op、sessionRef 从 `activations.session_ref` 派生后逐字透传且 vendor-opaque、无 ack。
- `claude-shim`:经 **transport 包公开 API**(`ClaudeCodeAdapter.write`,非内部 subpath `writeMailboxEntry`)写入,`metadata.flywheelId=message_uid`(sidecar 幂等键——**注意持久 message id 是 randomUUID,幂等靠 flywheelId 非 id**);hint=no-op(builtin 1s poller,文档写明)。
- `codex-shim`(**C5 定案候选(a)**):sessionRef 携带 vendor-opaque daemon 连接信息;每次 deliver 自建临时连接→有界 `turn/start` RPC→在 success/error/timeout 三出口的 `finally` 关闭。shim 不保留连接或恢复状态。
- **候选(b) 已删除**:不写 Codex teams mailbox,因为枚举不出 paused-hold 的消费场景;active activation 由候选(a)覆盖,paused/换代由 activation 生命周期和引擎重投收敛。
- **重复语义与 A14 对齐**:重复 deliver **允许产生重复 vendor turn**,不承诺恰一;权威收敛点是消费端以 `messageUid`/`attemptUid` 做幂等结算。Claude 的 `flywheelId=messageUid` 额外提供 vendor mailbox 去重,Codex 不虚构 vendor 级恰一。
- 落包:C7 已签为 `packages/v2-engine/src/injection/`;engine 公开导出白名单禁含 vendor shim 实现,engine 核心禁 import `injection/`,组合装配归批次3。
- A14 扩展:active 会话、宿主重启、重复 deliver 分别断言最终消费结算恰一;重复调用可观察到多次 Codex vendor turn,但 `messageUid`/`attemptUid` 不变。每次 Codex deliver 的 success/error/timeout 三出口都断言 client close 恰一次,调用返回后**零残留连接**。paused mailbox 分支已按反 over-reaction 裁决删除,不伪造对应验收。

### W5 软窗预约制(台账2)
- **共享 expiry 计算函数(Codex R1-7 修正:现有 mint 对 expires>deadline 是拒绝 invalid_expiry 而非钳制,"被钳"假设不成立)**:新建 `computeSubmissionExpiry(nowMs, windowMinutes, absoluteDeadlineMs)`——`min(now+window, absoluteDeadline)`;admission(:1668)/idempotentReplay rotation(:1771)/deliveryRepair(:1804)三处只调它,mint 永不见超限值。
- **非法值策略(R2-4 修正:不静默降级)**:字段 **absent→默认 60**;字段 **present 但非正整数(0/负/小数/非数值)→v1/v2 validator 拒绝**(与 manifest parser 对 max_iterations 的既有拒绝策略一致,workflow-template.ts:499-502)——静默回退会把 180 的拼写错伪装成 60 分钟,恰好掩盖本块要修的病。
- **完整触点清单(R1-7)**:`WorkflowManifestNode` 类型 + workflow-template.ts v1/v2 **exact-key validator**(:321-338/:756-775 各加 `submissionWindowMinutes` 白名单项+正整数校验)+ workflow-run-snapshot.ts pinned snapshot round-trip/digest 测试。
- **scope 强制(R3-3,非仅声明)**:decision family 由 pinned loops+edges 结构推导(workflow-run-snapshot.ts:91-107),非 node type/id——增加 **post-parse invariant**:字段 present 时该 node 经 `resolveWorkflowDecisionContract`(或等价纯函数)必须解出 qa_verdict|review_verdict,否则整 manifest 拒绝(design/implement/generic/gate/land 声明合法值也拒)。
- **dispatcher 读取落点冻结(R3-3)**:字段从 **pinned `snapshot.manifest.nodes`** 读(resolved node builder 不携带该字段;live seed/template 更不作数)——三条路径经一个 helper 读取,无 decision contract 时固定 60。
- **seed 落点(R2-4 钉死,不留到 implement)**:`packages/teamlead/src/workflow-seeds/tpl_eng_heavy.yaml` 与 `tpl_eng_heavy_land_v1.yaml` 的 qa 节点声明 `submissionWindowMinutes: 180`(heavy=真机长观测档,1496/1497 实证撞窗的正是这类);light/trivial 及其 land 变体不声明(=60 默认)。
- 默认 60 = 现状字节兼容;absolute deadline 24h 不动。
- legacy run-infra 30min 路径不改(被 engine 替代中,plan 留痕)。
- **留痕**:`renewWorkflowDecisionCapability` 零生产调用方(审计实证)——不走续期心跳路,预约制少一整套活动部件;函数保留不动。

### W6 CLI footgun(台账3)+ 清死旋钮(台账1 v2 侧)
- `runCodexReviewResult`:`--exec-id`+`--pr-head` 必填,缺任一→stderr usage+exit 1;CLI 路径移除 env/git-derive 兜底;emitter 保留兜底仅供 await-codex-gate(拆内部函数或 requireExplicit 参数,await-codex-gate 行为零变化)。
- truth.ts:`FLYWHEEL_SWAP_PRESSURE_HIGH_PCT`/`_LOW_PCT` 移入 retired tombstone(FLY-1456 范式;零读取方已实证)。
- 48G 校准模型=设计条款交付(research §4.1 数字表:swapout 噪声线 max(2048, RAM×0.1%/pagesize) 页/tick、free 触发 max(8%,2GB)、恢复 max(15%,4GB)、启动读 hw.memsize)——v1 machine-watermark.ts **不改**(Tadashi 拍板:批次4 整删,真卡派发时他单独 env override)。

## 3. 反 over-reaction 清单(Annie 原则,每机制答"哪个已枚举场景需要它")

| 机制 | 场景依据 | 根治为何不够 |
|---|---|---|
| 聚合(N=1 也发) | P5(告警风暴复发史)+N10 | 根治=v2 重建,但积压仍需暴露;聚合行是唯一暴露面 |
| episode 唯一键/depth CHECK/自动销账 | N10/N21(抖动/二次 episode) | schema 已落库(批次1),本单只是用它 |
| subject/recipient 分离 | N28(owner 换代) | 单字段混用=换代后告警发给死人(§1.2b 终局处置反例) |
| 三 tier 计数 | N34/N40(抑制期升档/receipt 迟到) | 单 tier 无法区分"入队/被抑制/已送达",清债与补发会双发或漏发 |
| 父抑制子(方案A) | N34/N39(agent 死时积压告警是噪声) | 不抑制=一个 agent_down 拖出一串 backlog 刷屏(=FLY-220 storm 的 v2 版) |
| 风暴 ledger+hold | N32/N33+审计实证(5 层散账互不知情+bridge_crash_loop.txt 真实事故+现有 preflight 从不阻断) | launchd ThrottleInterval 只降频不封顶;进程内计数重启归零 |
| fcntl 锁 fail-closed | N38 并发裁决双 exec | mkdir 锁无 owner-死亡自动释放;fail-open=风暴期双实例 |
| spool exactly-once+meta-alert at-least-once | N33/N42(kernel 死/告警前后崩) | 告警经 kernel=kernel 死则静默;spool 无 exactly-once=重复 obligation |
| 垫片无状态 | N11(垫片崩) | 有状态=多一个要恢复的真相源(病根①) |

**保护性机制(单列供 founder 砍)**:
1. gate 状态文件损坏 fail-closed(exit 4)+meta-alert——替代=当 active 处理(风险:损坏即丢 hold)。
2. `FLYWHEEL_RESTART_STORM_GATE=0` 旁路逃生口。
3. gate `status` 只读子命令(运维便利,非机制必需)。
4. `reconcileSuppressionDebt` 兜底扫债(C3 合同若被关父方遗忘的保险;可砍=完全信任合同)。
5. recipient 缺失 fail-safe→founder(可砍=改为报错拒绝)。

## 4. 接口合同(C1-C7,research §5 表 + R1 修订)
- →1500:C1 claim 谓词 `canClaimNotifyCommand` / C2 receipt 钩子 `onNotifyCommandReceipt`(state→succeeded 同事务) / **C3a parent-open 钩子 `onParentObligationOpened`(插 parent 的同一事务调用,记债)** / C3b parent-clear `releaseSuppressedChildren` / **C-recipient(R3-2 修正):仅 execute/effect handoff 时调 `resolveNotifyRecipient(tx, obligationId)`;claim 不解析、不缓存权威 recipient**;command payload 无权威 recipient。
- →1499:**C4 已签字(2026-07-27 brainstorm gate)**:registry runner identity 增可选 `ownerLeadId`;`parseIdentity`/`writeRegistry` 双形接受,present 时必须非空 string,缺失 fail-safe→`founder`,present/absent 参与 `identitiesEqual` exact 比较;fence.ts additive 变更由 1501 实现,1499 注册事务写入落地后再翻转 live recipient 推导。**C5 已冻结**:接口四项+Codex 临时连接泵+连接三出口清理+消费端幂等重复语义;C6 tick 互斥。
- →Tadashi:**C7 已签字(2026-07-27 brainstorm gate)**:落包 `packages/v2-engine/src/injection/`;engine 公开导出白名单不得包含 vendor shim 实现,engine 核心不得 import `injection/`(单向依赖;组合装配归批次3)。
- →批次3 手册:**v2 告警接线上线与静默 v1 对应告警必须由同一个 cutover 开关原子完成**;不得先开 v2 后另关 v1,不得存在 V1/V2 双发窗口(founder design-correction,2026-07-27)。
- **open question 状态:零。**C5 已冻结、W4 已解锁;候选(a)=无状态临时连接→有界 `turn/start`→三出口关闭,候选(b)=mailbox 分支已因无枚举场景删除。C1/C2/C3a/C3b/C-recipient/C4/C5/C6/C7 均为已生效合同,1500/1499 的 plan 应引用。

## 5. 实施顺序与并行防撞
1. W1→W2(同 PR 内串行;W2 依赖 payload 列)。
2. W3 独立(纯 scripts+shell 测试+v2-kernel 投影函数)。
3. W6 独立小件。W5 独立(teamlead 包,与 1499/1500 文件不相交——workflow-engine-dispatcher 归本单,已与批次划分核对)。
4. W4 按已冻结 C5 实现;仍**删除临落 agent-team-transport 分支**,只落 `packages/v2-engine/src/injection/`;若 1499 scaffold 尚未合入,先完成不依赖该包的工作块再机械 rebase,不创造第二份接口定义。
5. 冲突面:v2-kernel index.ts 导出行(三单各自追加,rebase 时机械合并)。

## 6. 验收矩阵(implement 节点的 DoD)

| 编号 | 断言 | 类型 |
|---|---|---|
| A1 | 1 条超龄→episode 存在(N=1);99 条→仍唯一 open 行;清空→自动 tombstone+pending notify 被 cancel;再积压=新 episode(总行 2/open 1) | 行为 |
| A2 | 四步事务任意点 crash replay 幂等(同 episode 不双建、command effect_key 不双发) | crash replay |
| A3 | tier 30min→2h→8h 各通知恰一次;last_enqueued 单调;receipt 后 last_notified 才推进(C2) | 行为 |
| A4 | owner 换代→recipient 重推导(N28);registry 无 ownerLeadId→fail-safe founder;**端到端(R1-1+R2-1):command pending 后 owner 换代、换代与发送之间不跑任何 mailbox-age tick→旧 owner 0 条、新 owner 恰 1 条(证明修复来自 resolver 读 live registry 本身,非 tick 巧合);(R3-2 子例)owner 在 claim 后、effect handoff 前换代→仍新 owner 恰 1 条** | 行为 |
| A5 | 父 open→子 command 恒 pending 被谓词拦(C1);claim 先赢=在途一条允许送达;抑制期升档只记债(N34);**parent 在子 command pending 后 open 且 tier 未升(R1-2):C3a 当场记债,债状态即时可断言** | 行为 |
| A6 | parent-clear:按最新 tier 恰一条补发+cancel 旧 tier+债清;前后 crash replay 幂等;reconcile 不重复放行(N44) | crash replay |
| A7 | **变异**:移除 episode 唯一索引→A1 转红;移除 depth CHECK→"给告警挂子告警"测试转红;移除谓词→A5 转红;移除 seq 下界→N43 转红 | 变异 |
| A8 | gate:连续 6 次启动(10min 窗)→第 6 次不 exec+state=held_alert_attempted+spool 恰一+双腿告警发出(N43 正常子例) | 行为 |
| A9 | gate crash 点:claim rename 后崩→state=held_alert_pending;下次启动补 spool/alert→attempted(N42/N43 fault 子例);append 后 claim 前崩→谓词仍真不 exec(N41);**fault injection 扩展(R1-5+R2-2/3):spool tmp create 后/半写后/file fsync 后/link 发布后/dir fsync 前各点崩→重放收敛;ledger partial tail→truncate 残尾后 append,再重启一次仍可读(双重启);告警腿各返回值(sent/queued_transient→attempted;duplicate→保持 pending——另一进程持 lease 后 durable receipt 前崩,lease 过期重试收敛;dead_lettered/config_error→保持 pending 重试)** | crash replay |
| A10 | 计数不清零:第 4/5 次间 gate 宿主崩→ledger 持久(N32);resume 后旧事件不计(seq 下界);并发 resume 恰一次生效、第二次幂等 no-op | 行为 |
| A11 | 锁竞争→exit 2 不 exec(fail-closed);**变异**:去锁后并发 gate 复现双 exec | 变异 |
| A12 | kernel 全程不在→spool+双腿告警照常(N33);kernel 恢复 reconcile→obligation 恰一(id=`restorm:<episode_key>` 幂等)+spool 经 **mark-applied**(同一 child lock,--root 绑定)移 applied;**(R2-3)Discord 腿 pending 期间 reconciler 与 ensure-spool 并发→不重复发布(applied/ 作 receipt);(R3-1)真实双进程(临时 root≠HOME):gate 持锁期间 TS 不移动,释放后恰移一次;helper 缺失/exit 75/commit 后崩→spool 留 live、下轮幂等重试;(R4-1)commit 后 helper 崩→首条 obligation 被 resolved/tombstoned→重放→历史 obligation 总数仍=1 且不 reopen;(R5-1+R8-2/3)invalid JSON / filename↔payload mismatch / unsafe basename / **合法 JSON 但非规范 episode 文件名(validate 子命令 5,DB commit 前拦)** 四子例各:0 条 obligation+按 digest 恰一条 restart_spool_invalid 事件(同 digest 重放不增,**不同 digest 各一条**)+重入耗尽另有 exhausted 事件+文件终态=quarantine/(锁竞争时下轮收敛);**(R8-4)冻结时钟:首 episode resolved→resume→同一秒内再达阈值→新 episode 的 spool/告警签名/obligation 三者均与前一 episode 不同(seq 保证);(R9-1)非默认 count 子例:obligation payload 与 helper 校验字节逐字段一致(TS 未重开文件);(R9-2)双进程:TS 枚举后暂停→gate 隔离该文件→恢复 validate→exit 7→零 obligation、零伪 invalid 事件、干净完成;可重试读错→75→live 条目原样留待下轮;**(R10-1)双进程 nonregular 翻转:validate 判 symlink 为 nonregular 后暂停→gate 在 child lock 下换入同名合法 regular spool→恢复 quarantine→exit 6 不移动新文件→同一次 reconcile 调用重入 validate→投影+mark-applied**;**(R6-1+R7-1)真实双进程 TOCTOU 交错:TS 判坏后暂停→gate 在 child lock 下同 basename 换入合法文件并推进 attempted→恢复 helper→exit 6→同一次 reconcile 调用内重入投影新文件→断言不隔离新文件、obligation 恰一、文件进 applied——全程不重启 kernel、不靠第二次测试调用;(R7-2)invalid-JSON 交错额外断言 helper 实际竞争的是预期 child lock(非仅终态巧合);重入上限 3 耗尽→文件留 live+事件留痕** | 行为 |
| A13 | 旁路 `FLYWHEEL_RESTART_STORM_GATE=0`→gate exit 0 零记账;不设 env=启用 | 反向 |
| A14 | 垫片:kill -9 宿主重启零恢复步骤(N11);重复 deliver→Claude `flywheelId=messageUid` sidecar 收敛;fake backend 只实现接口跑通全流程(可插拔回归);Codex active/宿主重启/重复 deliver 均逐字透传同一 sessionRef/messageUid/attemptUid,**允许重复 vendor turn,最终消费结算按 messageUid/attemptUid 恰一**;每次临时 client 的 success/error/timeout 三出口 close 恰一次,调用后**零残留连接**;无枚举场景的 paused mailbox 分支不实现 | 行为 |
| A15 | 软窗:tpl_eng_heavy(+land_v1)qa 节点 180→expires=+180min;未声明=60min 字节兼容;**(R1-7+R2-4)字段 present 但非正整数(0/负/小数/非数值)→v1/v2 validator 拒绝整个 manifest(非静默降级);>deadline→min 钳制;三条 admission/rotation/repair 路径各验;合法新字段过 snapshot round-trip/digest;(R3-3)v1 implement/gate 与 v2 generic/gate 节点携带合法 180→post-parse invariant 拒;snapshot 创建后改 live seed→既有 run expiry 不变(读 pinned manifest 证明)** | 行为+反向 |
| A16 | CLI:裸跑(满 env 环境)→exit 1+零 HTTP;缺 --pr-head 同;await-codex-gate 程序化路径行为零变化;**变异**:去守卫断言测试转红 | 变异 |
| A17 | truth.ts 死旋钮移除后全仓 build/lint 绿(零读取方) | 回归 |
| A18 | 全仓 pnpm lint + pnpm -r build + v2-kernel 全测绿 | 门 |

## 7. 风险与依赖
- **C4/C5/C7 已签**:W2 已实现 additive `ownerLeadId` reader、exact identity 与缺失→founder fail-safe;W4 按冻结接口和临时连接清理合同实现。1499 scaffold/接口是机械集成依赖,不得在本单复制定义。
- 三单并行 rebase:冲突面已收窄(§5.5);若 1499/1500 先合入且改了 index.ts,机械 rebase。
- gate 行为变更(held 不 exec)首次上线属"重启相关的销毁性动作邻域"——implement 节点部署验证需按纪律留基线+独立 QA(不在 design 节点 scope)。
