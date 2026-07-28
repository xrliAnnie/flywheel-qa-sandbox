# FLY-1501 聚合告警+重启风暴上限+注入垫片 — 调研
Issue: FLY-1501 (https://linear.app/geoforge3d/issue/FLY-1501/v2批次2-聚合告警-重启风暴上限-注入垫片vendor-neutral)
日期: 2026-07-27
基于: exploration.md

本文把 exploration 的事实 + brainstorm gate 裁决(Tadashi 2026-07-27,全条批准+台账1 scope 裁决)落成技术方案。设计机制本身不重开(R13 已批);本文只做**工程落点、接口合同、格式定义、数字校准**四类裁决。

## 0. 设计勘误留痕(D14 范式)

**勘误 E-1:终版 §3.1 与 §1.1 不一致——obligations 缺 payload 列。**
- 证据:design-v6.md:99 "payload={count,oldest_age},数字变化就地更新"、design-v7.md:80 四步事务"③payload 更新";而 §1.1 各版 obligations 列清单从未声明 payload,批次1 的 0002 迁移忠实实现了 §1.1。
- 裁决(Tadashi 预批):**以 §3.1 行为要求为准**,新迁移 `0005-obligations-payload` 幂等 `ALTER TABLE obligations ADD COLUMN payload TEXT`(只加不改;tombstone 触发器/episode 唯一索引/CHECK 全部不动),迁移测试入验收(重放容忍 duplicate column、旧行 payload=NULL 合法、加列后 0002 全部约束仍生效)。
- 归档设计原文不改。

## 1. 聚合告警引擎(§3.1/§3.2)工程落点

### 1.1 模块归属(gate 已批)
全部落 `packages/v2-kernel` 新模块族(纯函数 over WriteTx,FENCE 同风格,不新建包、不动 schema 除 0005):

```
packages/v2-kernel/src/alerts/
├── tiers.ts          # tier 定义与推导(30min→2h→8h),纯函数
├── mailbox-age.ts    # detector tick:枚举收件人 + 四步单事务
├── suppression.ts    # 静态抑制规则常量 + claim 谓词 + parent-clear 清债 + receipt 钩子
└── restart-storm-reconcile.ts  # §2.11 spool → obligation 投影(kernel 侧唯一职责)
```

### 1.2 detector tick(§3.1 四步事务)

调用形态:`runMailboxAgeTick(kernel, {nowIso})` 可直接调用的纯函数(单实例互斥由未来 kernel 服务进程保证,batch 3 接线;本单验收=直接调用)。收件人枚举=读 meta `consumer_registry:%` 键空间(fence.ts 既有约定)。

每收件人一个 `kernel.write('mailbox_age_tick:'+agent, tx => {...})` immediate 事务,内部四步(全部以库内为准,不信外部计数):

```
① row = tx.get(DETECTOR_SQL, {agent, cutoff: now-30min})   // 已锁定原文,不改写
② episodeKey = 'mailbox_backlog:'+agent
   open = SELECT * FROM obligations WHERE episode_key=:ek AND state='open'
   count==0 → open 存在则:CAS tombstone + cancel 该 obligation 的 pending notify command
              (UPDATE commands SET state='canceled' WHERE state='pending'
               AND effect_key LIKE 'notify:'+obligationId+':%')  → return(自动销账)
③ tier = tierFor(now - oldest)   // 1:≥30min 2:≥2h 3:≥8h
   recipient = deriveNotifyRecipient(tx, agent)   // 见 §1.5 接口合同
   open 不存在 → INSERT obligation(kind='mailbox_backlog', target_kind='agent',
     target_agent_id=agent(=subject), notify_recipient_agent_id=recipient,
     episode_key, payload=json({count,oldest_age}), depth=0, state='open')
   open 存在 → UPDATE payload 就地更新 + notify_recipient 重推导(owner 换代重路由)
④ tier > last_enqueued_tier 时:
   hasOpenParent(tx, 'mailbox_backlog', agent)?   // §1.4 抑制规则
     是 → UPDATE suppressed_tier=tier(记债),不插 command、不推进 last_enqueued_tier
     否 → INSERT commands(kind='notify', state='pending',
            effect_key='notify:'+obligationId+':t'+tier,
            payload=json({obligation_id, child_kind:'mailbox_backlog', subject:agent,
                          recipient, tier, count, oldest_age}))
          + UPDATE last_enqueued_tier=tier(单调,CAS 带 WHERE last_enqueued_tier<:tier)
```

要点:
- effect_key=`notify:<obligation行id>:t<tier>`(设计原文"obligation 行 id+tier";不复用 episode_key→历史 episode 旧 command 不会错误去重;UNIQUE(effect_key) 防重放双发)。
- open 行 ≤1/收件人由 `obligations_episode_open` partial UNIQUE(已落库)结构性保证;历史 tombstoned 行保留审计。
- 四道闸对照:聚合=唯一告警产物即本 episode 行(单条消息独立告警路径在代码里不存在);episode 唯一键=已落库索引;depth≤1=已落库 CHECK(本引擎恒插 depth=0,验收含"试图给告警 obligation 挂子告警被 DB 拒");自动销账=②的 count==0 分支。
- N=1 也发:①的 count≥1 即走 ③④,无数量阈值。

### 1.3 通知 command 生命周期与三 tier 计数

| 事件 | 谁写 | 字段变化 |
|---|---|---|
| tick 判定应通知 | 本引擎(1501) | INSERT notify command + last_enqueued_tier↑ |
| tick 判定被抑制 | 本引擎 | suppressed_tier=tier(债),另两者不动 |
| dispatcher claim | **1500**(调我的谓词) | 谓词假→不可 claim(command 恒 pending,方案A) |
| effect receipt(Discord 发送确认) | **1500**(调我的钩子) | `onNotifyCommandReceipt(tx, commandId)`:解析 effect_key 的 tier,CAS `last_notified_tier<tier` 才推进 |
| parent-clear | 关父方事务(调我的清债函数)+reconcile 兜底 | 见 §1.4 |
| 清账(backlog 归零) | 本引擎 | tombstone + cancel pending notify command |

### 1.4 父抑制子(§3.2 方案A)

**静态抑制规则常量**(设计常量,非 DB 表;反 over-reaction:只 ship 设计枚举的一条):
```ts
export const SUPPRESSION_RULES = [
  { parentKind: 'agent_down', childKind: 'mailbox_backlog' },  // 同 subject(target_agent_id)匹配
] as const;
```

**claim 谓词**(导出给 1500 dispatcher,在其 claim 事务内调用):
```ts
canClaimNotifyCommand(tx, command): boolean
  // command.kind !== 'notify' → true(不归本谓词管)
  // 从 command payload 取 child_kind + subject;查规则表得 parentKinds
  // NOT EXISTS(SELECT 1 FROM obligations WHERE state='open'
  //            AND kind IN parentKinds AND target_agent_id=:subject)
```
claim 先赢仲裁(设计已定):已被 claim 的在途一条允许送达;谓词只拦 pending→claim 转换。

**parent-clear 原子清债**(导出 `releaseSuppressedChildren(tx, {parentKind, subject})`,合同=关父方在**同一事务**内调用;另提供幂等 `reconcileSuppressionDebt(kernel)` 全表扫债兜底):
```
对每个匹配子 obligation(open,kind=childKind,target_agent_id=subject,suppressed_tier NOT NULL):
  仍有其他 open parent → 跳过(债保留)
  ① suppressed_tier > last_enqueued_tier → INSERT notify command(effect_key=notify:<id>:t<suppressed_tier>,
     UNIQUE 占用即幂等跳过)+ last_enqueued_tier=suppressed_tier
  ② cancel 更旧 tier 的 pending notify command(同 LIKE 模式,tier < 最新)
  ③ suppressed_tier←NULL(同事务)
```
重放幂等:effect_key 占用+债已清(suppressed_tier IS NULL 谓词)。

**关父方是谁**:agent_down 类 parent 由 1500 的探针模块关(其 resolve 事务调本函数——接口合同 §5);reconcileSuppressionDebt 作为兜底在 tick 里顺带跑(债不依赖对方记得调用,防漏)。

### 1.5 recipient 推导(接口缺口,提给 Tadashi 转 1499)

设计:runner→owning Lead,Lead→founder,事务内按当前 registry 实时推导。**现状缺口**:fence.ts 的 runner registry 值形 `{agentId, instanceId, generation, activationId}` **不含 owning lead**——推导无数据源。
- **提案(需 1499 收口)**:runner 注册值增加 `ownerLeadId` 字段(注册事务本来就知道派发它的 Lead);lead 的 recipient=常量 'founder'。
- **fail-safe**:registry 无该字段/查不到 → recipient='founder'(向上兜底,宁可打扰 founder 不可静默丢)。本引擎按此实现,字段就绪前行为=全部通知 founder。

## 2. 重启风暴上限(§2.11)工程落点

> **规范性声明(R6-2)**:本章 §2.1-§2.4 是初稿演进史;Codex design review R1-R6 对磁盘协议/锁桥/quarantine/告警腿映射做了多轮收紧,**最终合同以 plan.md W3 与 W2-reconcile 条目为唯一权威**,冲突处以 plan 为准。已知被取代要点:spool 发布 O_EXCL 直写→tmp+fsync+no-clobber link;"两腿 best-effort"→Discord 腿 durable-receipt 状态机(sent/queued_transient 才推进 attempted);三/四子命令→五子命令(+quarantine,两类锁+digest 复验);wrapper 4 个→5 个 supervised 入口(+cmux-autostart supervised 分支)。

### 2.1 形态(gate 已批)
独立 Python 脚本 `scripts/restart-storm-gate.py`(stdlib only:fcntl/json/os/time),集成进各 wrapper **exec 之前**(现 bp_launcher_preflight 同位)。**单一 authority**:只有 wrapper 级(=launchd respawn)事件入账;claude-lead.sh 进程内循环不计数(不改动它);Runner 无 OS supervisor,不进本机制。

CLI(**以 plan.md W3 为准**——Codex design review R3/R4 增补 mark-applied 子命令与 --root 绑定,本节保留初稿供演进追溯):
```
restart-storm-gate.py gate <child_key>    # 启动 gate:exit 0=放行 exec;exit 3=held(不 exec);exit 2=锁竞争 fail-closed;exit 4=状态损坏 fail-closed
restart-storm-gate.py resume <child_key>  # 授权恢复:锁内条件 CAS held_*→resumed;幂等 no-op 返回 0
restart-storm-gate.py status <child_key>  # 只读,不取写锁语义(仍取锁防撕裂读,LOCK_SH 或短 EX)
restart-storm-gate.py mark-applied --root <abs> <child_key> <episode_key>  # (R4)reconciler 专用锁桥
```

wrapper 集成(每个一行,exec 前):
```bash
"$FLYWHEEL_DIR/scripts/restart-storm-gate.py" gate "$CHILD_KEY" || exit 0   # 非 0 一律不 exec;launchd KeepAlive 每 30s 重试,held 稳态下 gate 快速退出
```
覆盖 wrapper(4 个文件):flywheel-bridge-wrapper.sh(child_key=bridge)、flywheel-voice-bridge-wrapper.sh(voice-bridge)、flywheel-lead-wrapper.sh(lead.<project>-<lead>,从 manifest 推)、flywheel-quota-monitor-wrapper.sh(quota-monitor)。cmux-watcher 启动链 implement 时核实后同款接入。

### 2.2 磁盘工件格式

```
~/.flywheel/restart-ledger/
├── <child_key>.jsonl    # append-only ledger:每行 {"seq":N,"ts":"ISO"};append 后 fsync(fd)
├── <child_key>.state    # {"state":"active|held_alert_pending|held_alert_attempted|resumed",
│                        #  "episode_key":str?, "window_start":"ISO"?, "last_resumed_seq":N}
│                        # 写=<tmp>+fsync+rename+目录 fsync;文件不存在=active+last_resumed_seq=0(v13 缺失语义)
├── <child_key>.lock     # fcntl LOCK_EX|LOCK_NB 有界重试(复用 flywheel-config-lock.py 模式);
│                        # 全部写者(gate/resume/恢复工具)同一锁;取不到=fail-closed
└── spool/
    ├── <episode_key>.json         # 发布协议以 plan.md W3 为准(R2-3 修订):tmp 完整写+fsync→no-clobber link→fsync 目录
    └── applied/<episode_key>.json # kernel reconcile 经 mark-applied 子命令(同一 child lock)移入;
                                   # 投影幂等键=obligation id 由 episode_key 确定性派生(R4-1)
```
seq 分配:锁内读 ledger 末行 seq+1(文件小,10min 窗口裁剪不做——append-only 保留全史,按天归档留 batch 4)。episode_key=`<child_key>:<window_start ISO>`。

### 2.3 启动分支(v13 穷举,逐条映射到实现)

```
取锁失败(有界重试后) → exit 2,不 exec                       [fail-closed]
读 state 文件:
  损坏/不可解析 → meta-alert(reason=restart_gate_state_corrupt)+ exit 4,不 exec   [见 §2.6 保护性清单]
  held_alert_attempted → exit 3,不 exec(不 append)
  held_alert_pending   → 恢复分支:ensure-spool(O_EXCL 幂等)→ meta-alert(episode_key)
                          → CAS→attempted(rename)→ exit 3,不 exec
  resumed → 锁内立即 CAS→active(保留 last_resumed_seq)→ 落入 active 分支
  active  → append {seq,ts}+fsync
            → 谓词:count(ts∈[now-10min] AND seq>last_resumed_seq) ≥ 6 AND state==active
              真 → 原子 claim(写 {held_alert_pending, episode_key=child_key+':'+window_start,
                    window_start=窗口内最早事件 ts})→ ensure-spool → meta-alert
                    → CAS→attempted → exit 3,不 exec
              假 → exit 0,exec child
```
resume:锁内重读,仅 held_* 才写 `{state:resumed, last_resumed_seq=当前 ledger 最大 seq}`;见 resumed/active→幂等 no-op 成功返回(不刷新计数下界)。

### 2.4 meta-alert(kernel-independent,零新通道,gate 已批)
双腿复用:
1. `scripts/meta-alert.sh restart_storm_<child_key> <title> <body>`(桌面+marker;sink debounce=marker mtime 10min——设计 v9 "现有 meta-alert.sh 的 marker debounce 即此" 的字面兑现);
2. `scripts/lead-alert.sh --project flywheel --lead <child_key> --kind restart_storm_hold --severity severe --signature <episode_key> --strict-delivery`(Bridge 挂了也直 POST Discord;claims.db 以 episode_key 去重=at-least-once+stable key+debounce)。
lead-alert.sh 的 kind 白名单加 `restart_storm_hold` 一项(白名单是 shell 常量,一行)。
两腿都 best-effort 不 fail gate 自身;失败下次启动重发(held_alert_pending 分支)。

### 2.5 kernel 投影(**以 plan.md W2 reconcile 条目为准**——Codex R3-R5 修订后终态,本节同步)
`reconcileRestartStormSpool(kernel, {ledgerRoot, gateHelperPath})`(v2-kernel `alerts/restart-storm-reconcile.ts`):枚举 <root>/spool/*.json → **pre-validation 在 kernel 事务前**(invalid→恰一条 restart_spool_invalid 事件+helper quarantine 子命令,零 obligation)→ 合法者 `kernel.write` 幂等投影(**id=`restorm:<episode_key>` 确定性派生=全历史 exactly-once**;kind='restart_storm_hold', target_kind='agent', target_agent_id=child_key, notify_recipient='founder', payload={window_start,count};重放命中既有 id 校验 immutable 字段后 no-op,绝不 reopen)→ DB commit 后经 **helper mark-applied 子命令**(同一 child lock)移 applied/——TS 永不自己 rename/加锁。外部 supervisor 永不写 flywheel-v2.db。调用时机=kernel 服务启动 reconcile(batch 3 接线;本单验收=直接调用)。

### 2.6 数字与保护性机制清单(供 founder 砍)
- 窗口 10min/阈值第 6 次/健康语义=v13 原文,不动。可 env 覆盖:`FLYWHEEL_RESTART_STORM_WINDOW_SEC=600`、`FLYWHEEL_RESTART_STORM_MAX=5`(谓词 count≥MAX+1)。
- **保护性(可砍)**:①状态文件损坏 fail-closed(exit 4)——替代=当 active 处理(风险:损坏丢 hold);②status 子命令;③ledger 按天归档(本单不做,只声明)。
- 场景依据(反 over-reaction 硬回答):N32(supervisor 崩跨窗计数不丢=ledger 持久)、N33(kernel 死时告警照发=双腿独立)、N38/N41/N42(crash 点重放=穷举分支+可重放谓词)、N43(resume 后再风暴=cursor 下界)、审计实证"重启额度散在 5 层互不知情+bridge_crash_loop.txt 真实事故"=单一 authority 的存在理由。

## 3. 注入垫片 vendor 实现(接口归 1499)

### 3.1 对 1499 接口的需求(提给 Tadashi 转收口)
1. `deliver(sessionRef, {messageUid, payload}) → {ok:true} | {ok:false, error}`(注入成败,非消费成败);**允许重复调用**(消费幂等兜底,设计 v8 §1.2b 已声明)。
2. `hint(sessionRef) → void` best-effort,允许实现为 no-op。
3. `sessionRef` vendor-opaque(discriminated union:claude={teamName,agentName} / codex={teamsDir 身份或 threadId});由 activation/session_ref 派生的规则归 1499。
4. 无 ack 方法(设计 v7 已删)。

### 3.2 Claude 实现(薄封装既有资产)
deliver=`ClaudeMailboxCodec.writeMailboxEntry`(信箱路径由 path-helpers 既有函数;flywheelId=message_uid → sidecar 幂等,重复 deliver 收敛 accepted_duplicate);文本体=payload+`[kernel-message <uid>]` 前缀(与 send.ts 的 `[lead-instruction <id>]` 同范式)。hint=**no-op**(builtin useInboxPoller 1s 使 deliver 本身即低延迟;文档写明理由)。零持久化:锁/去重全在介质侧(proper-lockfile+sidecar)。

### 3.3 Codex 实现(方案A:teams inbox 通路)
deliver=写 Codex teams 信箱文件(`CodexAdapter` 既有原子写+O_EXCL 锁;message id=message_uid 供 dedupeKey)→ 既有 `CodexMailboxWatcher`→phase-lifecycle→`turn/start` 全链白拿。hint=no-op(watcher fs.watch+1s poll 同理)。
- 弃选方案B(直连 daemon `turn/start` RPC):需要 driver 进程拿到 per-runner daemon 连接,跨进程连接管理=新状态,违背垫片无状态;方案A 即设计原文"Codex=走它的 turn/inbox 通路"。
- 已知残留:watcher→turn 链上的 `enqueueRunnerPhaseWake` 落 CommDB(v1 账本)——batch 3 切换时该链是否改写归 1499/批次3,垫片不受影响(只写信箱文件)。

### 3.4 落包位置(open question,plan 列出)
倾向 `packages/v2-engine/src/injection/{claude-shim,codex-shim}.ts`(1499 建包后落);若 1499 scaffold 晚于我的 implement 节点,备选=先落 `packages/agent-team-transport/src/v2-shim/`(类型 import 1499 接口)后迁。请 Tadashi 排布。

### 3.5 验收(设计原文)
①零持久化:kill -9 垫片宿主后重启即好,无恢复步骤(N11);②可插拔回归:新增 fake backend 只实现接口、不改 kernel/schema,测试驱动全流程(N23 兜底不依赖 hint 归 1499 驱动侧)。

## 4. 台账三项(按 gate 裁决收窄)

### 4.1 台账1(v2 侧 only,Tadashi 拍板 v1 不动)
1. **清死旋钮**:`FLYWHEEL_SWAP_PRESSURE_HIGH_PCT`/`_LOW_PCT` 从 truth.ts 移入 retired tombstone(FLY-1456 范式;全仓零读取方已实证,零行为变化)。
2. **48G 校准模型(设计条款,供 v2 传感器与 env override 用)**:
   - 病根:swapoutMinPages=0(任何一页 swapout/tick 即 danger)+纯百分比在 48G 语义漂移。
   - 新模型:阈值必须**随机器规格推导**——启动时读 hw.memsize;`swapout_min_pages_per_tick = max(2048, RAM×0.1%/pagesize)`(48G/16384B 页 ≈ 3072 页/tick ≈ 48MB/10min tick,噪声与真 thrash 分界);free 触发线=`max(8%, 2GB 绝对下限)` 双条件取严;恢复线=`max(15%, 4GB)`。
   - 落点:设计条款+默认值表(本单交付);v2 传感器实现属批次4 之后(v1 machine-watermark.ts 不改,若真卡派发 Tadashi 按约定单独 env override)。
3. 新聚合告警侧:swap_pressure 类告警未来进 obligation episode 体系(kind 预留 'machine_pressure'),本单不实现传感器。

### 4.2 台账2(软窗预约制,gate 已批)
- 现状:30min(run-infra.ts:637 legacy)/60min(workflow-engine-dispatcher.ts:1668 engine)硬编码;`renewWorkflowDecisionCapability` 已实现零调用方(**记录:不走续期心跳路——预约制少一整套活动部件;该函数保留不动**)。
- 设计:workflow 节点模板增可选字段 `submissionWindowMinutes`(默认 60,上限=absolute deadline 派生值);dispatcher admission/rotation/repair 各处从模板读(真机长观测 QA 模板声明 180);absolute deadline(24h)不动。legacy run-infra 路径 30min 不改(被 engine 替代中,注明)。
- 验收:模板声明 180 的节点,admission 后 expires_at=now+180min;未声明=60min 现状字节兼容;声明值超 absolute deadline 派生上限被钳(mint 不变式已有,新增边界测试)。

### 4.3 台账3(CLI footgun,gate 已批)
- `runCodexReviewResult`(index.ts:1383):`--exec-id`+`--pr-head` 必填——缺任一 → stderr usage+exit 1,**不落 env/git 兜底**(emitter 的 `?? process.env.FLYWHEEL_EXEC_ID` 与 `deriveHeadSha()` 兜底从 CLI 路径移除);40-hex 校验保留。
- emitter 程序化 API(`emitCodexReviewResult`)保留 env/derive 兜底**仅供 await-codex-gate**(唯一合法调用方)——实现=CLI 层先行校验后显式传参,emitter 增 `requireExplicit` 开关或拆内部函数,await-codex-gate 行为零变化。
- 变异验证:裸跑 CLI(带满 env 的 runner 环境模拟)断言退非 0 且零 HTTP 调用;把守卫拿掉断言测试转红。

## 5. 与 1499/1500 的接口合同(汇总,plan 附录用)

| # | 合同 | 方向 | 形态 |
|---|---|---|---|
| C1 | notify command claim 谓词 | 1501 导出→1500 claim 事务调用 | `canClaimNotifyCommand(tx, command)` |
| C2 | notify receipt 钩子 | 1501 导出→1500 receipt 事务调用 | `onNotifyCommandReceipt(tx, commandId)` |
| C3 | parent-clear 清债 | 1501 导出→1500 关父事务调用+1501 reconcile 兜底 | `releaseSuppressedChildren(tx,{parentKind,subject})` |
| C4 | runner registry 增 ownerLeadId | 1499 注册事务写→1501 推导读 | fail-safe:缺失→通知 founder |
| C5 | InjectionShim 接口 | 1499 定义→1501 实现两份 | §3.1 需求清单 |
| C6 | tick 单实例互斥 | batch 3 接线共用 | 本单 tick=可调用函数+互斥要求声明 |
| C7 | 垫片落包位置 | Tadashi 排布 | §3.4 |

## 6. 验收与测试策略(plan 细化)
- 告警:N10/N19/N20/N21/N28/N34/N39/N40/N44 全覆盖;四道闸各配**变异验证**(把闸拿掉断言转红:如去掉 episode 唯一索引断言双 open 行、去掉 depth CHECK 断言子告警可插);crash replay=四步事务任意点重放幂等。
- 风暴:N32/N33/N38/N41/N42/N43(两子例)+并发 resume 交错+锁竞争 fail-closed;shell 级测试(scripts/__tests__/restart-storm-gate.test.sh,真 fcntl 真 fsync 真 rename);变异=拿掉锁断言双 exec 可复现、拿掉 seq 下界断言 resume 前旧事件被误计。
- 垫片:零持久化(kill -9 重启)+可插拔回归+重复 deliver 幂等(Claude sidecar accepted_duplicate/Codex dedupeKey)。
- 台账:4.2 三条边界+4.3 变异验证。
- 全部守卫/拒绝/兜底类断言按 Lead 纪律做范围覆盖+变异验证。
