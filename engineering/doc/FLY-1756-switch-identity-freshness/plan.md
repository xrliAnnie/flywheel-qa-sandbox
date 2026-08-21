# FLY-1756 Lead 代 founder 切号自愈 — 实施计划

Issue: FLY-1756 (https://linear.app/geoforge3d/issue/FLY-1756/bug-lead-无法代-founder-切号她只能手工切-切号只认-active-标记不认活凭据身份-池快照会过期双因)
日期: 2026-08-21(R8,Founder 终裁覆盖保活撤项;已折入 Codex design review R1×10 + R2×8 + R3×7 + R4×6 + R5×5 + R6×3)
基于: research.md(含其「R1 更正」节)

## 0. 摘要

| Fix | 治什么 | 落点 |
|---|---|---|
| **A. `use`/`next` live-identity 权威化 + 真 no-op + tagged-preimage 协议** | 因一(切号只认标记不认活身份);8-13 实测两方向的直接解;并发手工登录的 Keychain 安全 | bash `flywheel-claude-profile` + quota-guard strict store + `switch-executor.ts`/report 通道(PR-1) |
| **B. `reconcile` 子命令 + 引擎每 tick digest 触发的 capture/repair** | 因二 a(手工登录/家族轮换后池与台账不自动跟上;引擎 conflict 卡死等人);pos-1「切走的号仍可切回」的成立机制 | bash 新子命令(PR-1)+ quota-monitor 接线(PR-2) |
| **C. 非活跃槽定期保鲜 + 老化报告** | 因二 b:久坐号不能因无人切入而全柜腐烂 | quota-monitor(PR-2) |

核心不变量:**任何 Keychain 写入前,「当前 active 是谁」必须来自活凭据 probe 身份(映射唯一 anchor 槽),绝不来自 `.active`/display/ledger 标记;证据不可得 ⇒ fail-closed 零 mutation(身份判定的唯一例外 = `FLYWHEEL_PROFILE_IDENTITY_BYPASS`,见 §1.4 的正交边界)。**自愈/capture 类 mutation** 方向永远 pool ← Keychain(正常换号的 `kc_write` 当然是 pool → Keychain——经 freshness + identity assert 验证后);后台 OAuth refresh 只允许作用于经当轮活 `oauth/profile` 证明为**非活跃**的槽,活跃槽绝不碰。Keychain 的每次写入/回滚——**含 BYPASS 路径——无条件**受 tagged-preimage 双 fence 与三态分类器约束(§1.3):非「我读到的那个值」绝不覆盖、非「我写下的那个值」绝不回滚。**

### 0.1 Founder 终裁差异记录(2026-08-21)

Founder 终裁推翻 R1–R7 评审中「撤下后台定期 refresh」的取舍:几周不碰的号无人能保证不烂,烂一个就会回到全手动。PR-2 因此必须恢复安全化定期保鲜:每轮先用活 Keychain 凭据调 `oauth/profile` 直证当前活跃身份,只对确认非活跃的槽执行 refresh 并原子写回;活跃槽不刷;无法直证活身份时整轮零 refresh;某槽 refresh 被拒则保留 fail-closed 并走老化点名。此变更不扩大 PR-1 范围。

另确认 PR-1 的切号往返合同:`freshness_check` 在 `use B` 写 Keychain 前已将 refresh 轮换后的 B 新凭据原子回写到 B 池槽;后续切回 B 用的必须是该新钥匙,不是 refresh 前副本。

## 1. Fix A — `use` / `next` 入口(PR-1)

### 1.1 live-identity 权威化(probe 结果 = 整条命令的 active 权威)

新共享步骤 `establish_live_active`(`IDENTITY_BYPASS=0` 时 `use`/`next`/`reconcile` 都强制,拿锁后运行):

1. `kc_read`:rc 44 → `PREIMAGE=absent`、`LIVE_ACTIVE=""`,**显式跳过 identity_probe**(R4#6),直达 bootstrap 语义(`use`/`next`:后续切换以 active=空 ⇒ 任何 target 必过 freshness;`reconcile`:outcome `no_credential`);其他非 0 / `credential_value_ok` 失败 → fail-closed(`live_identity_unavailable` 类,§1.5)零 mutation;成功 → `PREIMAGE=present`、记 `LIVE_BYTES`/`LIVE_DIGEST`(进程内)。
2. `identity_probe` 失败 → `live_identity_unavailable`;`find_anchor_slot_by_identity` 归不了唯一槽(0/>1)→ 同类 fail-closed 零 mutation;唯一槽 `L`。
3. **live-slot 收敛**(§1.2 事务):`L`==marker 且 store 一致 → 仅 strict capture 保鲜;不一致 → manual 修复 / delegated `exit 46`(FLY-1201 字面)。`LIVE_ACTIVE=L`。
4. **display 快路径整体退役**:probe-first 内核是 `use`/`next`/`reconcile` **唯一**肯定性判定;`reconcile_stale_active_locked` 及 display-equals-anchor 分支从三条主链移出并删除/重写(display 仅存投影用途,§1.2-5)。

之后:`use <name>`:`name == LIVE_ACTIVE` → no-op 成功(`FLYWHEEL_USE_NOOP`,零 `kc_write`,pos-2 mtime 不变);否则切换链以 `active=LIVE_ACTIVE` 传入 prepare/commit(每个 ≠L 的 target 必过 freshness;R2#1 regression = 测试 4)。`next`:以 `LIVE_ACTIVE` 为基准选后继。

### 1.2 收敛/no-op 事务合同

顺序:**(fence §1.3)→ capture → strict store(readback)→ marker → display 投影**:

1. capture 前 fence:重读 `kc_read` 比对 `LIVE_DIGEST`,不等 → `keychain_preimage_conflict`(§1.5)零 mutation;**以 re-read 相等的字节为 capture payload** → `capture_live_credential_strict L`(失败 47;39 透传)。
2. `active_sync_store_strict L --freshened …`(§2.2;失败 47)。
3. marker:`write_active_from_reconcile L <old|"">`(0/1/2 rc 合同;uncertain 47)。
4. 每步前缀失败 → 47 且已完成前缀可重跑收敛;`audit_append` + stderr 机器标记。
5. **display 投影**(R4#2):公共 `sync_identity` **保持永返 0 的现状合同不动**(现有成功切换路径在 `set -e` 下未加 guard 地调它,改返回值会把已提交的切换打成失败并悬置 journal);新增 guarded helper `sync_identity_reporting`(内部调用 sync_identity 的实现,经 out-变量 `DISPLAY_SYNCED=0/1` 报告成败,自身仍返 0)供新路径(no-op / 收敛 / reconcile)使用。postcondition:凭据/store/marker 修复 durable 即使 display 失败;`DISPLAY_SYNCED` 进 reconcile JSON(`displaySynced`)并进 daemon episode-clear 正式谓词(§3.2)。regression:commit 全成功 + display 投影失败 → 命令仍成功 + journal 已清。
6. delegated 纯 no-op 例外:`L`==marker==store → 允许 capture 保鲜 + 短路成功;任何 marker/store 修复需要 → 46。

### 1.3 tagged-preimage 双 fence 协议(R3#1 + R4#1 BLOCKER)

`PREIMAGE ∈ {present{digest}, absent}` 携带整条命令;规则:

- **fence-1(pre-journal)**:所有网络工作(reconcile probe、target freshness POST 前另有一次、commit 的 `identity_assert_value` GET)完成后、`write_transition_journal` 前,重读并比对 preimage(present:字节==`LIVE_BYTES`;absent:仍 rc 44)。不符 → `keychain_preimage_conflict` 零覆盖。
- **fence-2(post-journal, pre-write)**(R4#1):journal 创建后、`kc_write` 前**再读一次**。不符 → **按本操作 `opId` 用 `clear_transition_journal` 清掉刚写的 journal**(绝不留一个两侧 digest 都早于外部登录的 journal)+ `keychain_preimage_conflict`,零 `kc_write`。测试:journal 后注入登录 → target 未写、founder 字节存活、该 journal 已被安全移除。
- **compare-before-restore,三路统一**(R5#1):现源码有**三条** post-write 错误路径——(a) `kc_write` 返回非零后无条件 restore(:1993-1998,现有 partial-write 测试证明 `security -i` 可先装上 target 再返非零)、(b) 写成功但 readback 不匹配(:2002-2018)、(c) marker-commit 失败(:2022-2028)。三路全部收口到**一个三态分类器**:当前字节 == 工具写入 target → 条件 restore/delete;当前字节 == tagged 原 preimage(含 absent:rc 44)→ 不写、按 checked `opId` 清 journal、报原始操作失败;不可读或两端都不等(第三值)→ **绝不 restore**、保留 journal 供收敛、`FLYWHEEL_KEYCHAIN_PREIMAGE_CONFLICT` terminal。注入测试:partial-write 非零后、restore 前注入 founder 写入 → founder 字节存活。
- **journal 携带 old-state tag**(R5#2):现 journal 只记 `oldDigest`/`targetDigest`,`reconcile_transition_journal` 把一切 `kc_read` 失败(含 rc 44)当 `keychain_unreadable`——bootstrap 在 journal 创建后 crash 会留下无法识别「原状态本就 absent」的永久冲突。journal schema 扩显式 old-state tag(**保留 v1 必填的 `oldDigest` 字段于两种 old-state,新增 `oldState` 并列**——PR-1 回滚后旧代码仍可解析新 journal,仅退化到既有保守行为;R7 note),recovery 规则:rc 44 只匹配 `absent` 端点。**v1 迁移规则显式化(R6#2)**:既有 v1 journal 无 tag,`absent` **仅**从 legacy 空 preimage 编码推断(空串的已知 digest——现有 `credential_value_ok` 校验器保证真凭据不可能是空串,故该值无歧义);其余一律推断 `present`(绝不把任意 rc 44 弱化为 absent 匹配)。crash-recovery 测试(6b):absent preimage 在 journal 创建后 / target 写入后 / 条件 delete 后 cleanup 前三处 crash 各自收敛或安全清除;**v1-absent journal(空串 digest)可清 vs v1-present journal + Keychain item 缺失不可清**两例对照。
- **窗口如实声明**(R4#6 措辞):refresh 写回、capture rename、`kc_write`、条件 rollback 四处各存在 **primitive 级 read→write 非原子窗口**(未测量,不给「毫秒」数量级);fence 消除的是「含 ≤10s 网络等待的整命令窗口」这一大头。

### 1.4 BYPASS 的正交边界(R6#1 BLOCKER:身份逃生舱 ≠ 并发安全逃生舱)

`FLYWHEEL_PROFILE_IDENTITY_BYPASS=1` 只跳过**身份/OAuth 权威决策**(§1.1 的 probe/anchor 判定与 §1.2 的收敛);**tagged-preimage 捕获、pre-network/pre-journal/post-journal 三处 fence、三态 conditional-restore 分类器(§1.3)对包括 BYPASS 在内的每条 Keychain mutation 路径无条件生效**——否则 partial `kc_write` + founder 并发登录在 BYPASS 下仍会被盲回滚覆盖,与核心不变量矛盾。文档与告警文案写明:BYPASS 是 founder 授权的 break-glass,**豁免的是 live-identity/freshness 保证,不豁免 compare-before-overwrite/restore**。兼容测试从「现状链逐字」改为「**同 bypass 意图结果 + 并发加固**」;新增 bypass 模式的 post-journal 注入与 partial-write/第三值注入测试。可用性不回退(现状 freshness 同样断网 31 fail-closed)。

### 1.5 typed 失败分类(R4#4)

exit 88 不再单义。bash 以**稳定 stderr marker** 区分,adapter(claude-profile-cli.ts)解析为专用错误/reason code,executor/monitor 按类处置:

| marker | 类 | 处置 |
|---|---|---|
| `FLYWHEEL_LIVE_IDENTITY_UNAVAILABLE` | **机器/环境级**失败(probe/kc 读不可得、anchor 歧义)——影响所有候选 | **新专用 terminal `LiveIdentityUnavailableError` + reason code `live_identity_unavailable`**,仿 `FreshnessUnavailableError` 模式:不标任何账号 flag、不试第二个 apply、整体 fail-closed(R5#3:不得映射到 target 级的 `TargetIdentityUnverifiableError` 族——那会继续下一候选并误归因到账号)。daemon 侧:episode 保持 throttled-open(不丢状态),本 tick 不再动作 |
| `FLYWHEEL_KEYCHAIN_PREIMAGE_CONFLICT` | 外部写者(founder 并发登录) | **terminal:绝不尝试下一候选**;audit;daemon 侧 alert **复用现有 `account_switch_failed` kind + 新 reason `keychain_preimage_conflict`**(不加第三 alert kind;routing/throttle/no-secret body 进合同测试)+ daemon 退避(founder 正在切号的信号);manual bash 路径 = stderr marker + audit,不新增 bash 侧投递(R5#5);journal 交接 = fence-2/分类器已清 own-opId / 第三值位点保留 journal 供人工收敛 |
| (delegated reconcile 误用) | 结构误用 | fail fast,现 88 语义 |

`reconcile` 对同因的表示(R5#3):`live_identity_unavailable` 落在 exit-20 `unresolvable` JSON 的 `reason` 枚举里(`probe_unavailable` / `anchor_ambiguous` / `keychain_unreadable`)。adapter/executor 的分类断言随 **PR-1** 测试交付(PR-1 独立 ship 该行为);PR-2 只留 monitor 侧分类(测试 18)。

## 2. Fix B(bash + teamlead,PR-1)

### 2.1 `reconcile` 子命令合同

「只对账修复,不切号」。**exit 0/10/20 时 stdout 恰一行 JSON;39/46/47 结构性失败不承诺 JSON**:

| outcome | 含义 | exit |
|---|---|---|
| `already_consistent`(`freshened`、`displaySynced`) | 活身份==marker 槽 anchor;strict capture 保鲜 | 0 |
| `repaired`(`from`/`to`、`displaySynced`) | 活身份唯一归到另一槽;§1.2 全事务完成 | 0 |
| `no_credential` | Keychain 空(合法 bootstrap 态) | 10 |
| `unresolvable`(`reason`) | probe 失败/归不了唯一槽 —— 零 mutation | 20 |
| 结构性失败 | 现有合同 | **46 / 47 / 39**(R4#6 修正) |

实现 = `establish_live_active` 内核(§1.1-1.3、§1.5 全合同);自己 `acquire_lock`;delegated env 已设 → 结构误用拒;**`FLYWHEEL_PROFILE_IDENTITY_BYPASS=1` 同样显式拒**(R7 note:纯身份对账命令没有有意义的 bypass 结果);trampoline/dispatch/usage 加 `reconcile`;单层进程组合同(TS runner 设 `FLYWHEEL_PROFILE_GROUP_LEADER=1`)。

### 2.2 strict store 合同(quota-guard `active-sync-strict`)

同 R4 版:严格 flag 解析(未知/重复/悬空拒)、stdin 单值有界 JSON、未知账号非零、lease fence + readback 合同测试;仅值变化 bump generation;`--freshened` 绑定 `--name` 清 auth 三标记;`identityMismatch` 仅 stdin 证据对上 `AccountEntry.identity` 才清(FLY-1252 权属;分歧 → 保留);bash `active_sync_store_strict` 失败 47;旧 `active-sync` 零改动。

### 2.3 delegated freshening 的 report 生产者通道(R3#4 + R4#3;PR-1)

**现状如实**:`FLYWHEEL_APPLY_REPORT_FILE` 通道只有 TS 侧 parser 与测试 mock,**bash 从不写它**;且现 parser 要求 `identityChecks` 非空(`appendReport` 丢空 report),`TargetStaleError`/`TargetQuotaExhaustedError`/`FreshnessUnavailableError` 分支丢弃已解析 report。本单补齐端到端:

- **producer(bash)**:仅在**认证的 delegated-lock child** 中写 report;写法 = parent 预创建路径上的 atomic(temp+rename)、no-follow、owner-only(0600)、bounded 写;`freshened` 事实**仅在 strict capture readback 成功后** emit;凭据 capture 已成功的每个 outcome 都携带 report——含 stale / identity-mismatch / 多候选续跑路径(修上述三处丢弃)。
- **schema**:report 接受 freshened-only 形态(放宽「identityChecks 必须非空」;`freshened?: {name, identityProof}`,identityProof = 非 secret uuid/email)。
- **consumer(parent,switch-executor.ts)**:每次 child attempt 结束后,经**一个共享 pure helper** 在锁内 re-read 最新 store → 校验 generation/activeAccount → patch flag 清除 → **把 `working` 替换为 patched 最新值**,后续任何 `writeStore`/`commitSwitch` 基于它——已清 flag 不可能被复活。
- **conflict 压制 freshened**(R5#4):同账号在 capture 之后、commit 之前再登录/轮换,正是 `keychain_preimage_conflict` 的一种成因——此时已 capture 进池的字节可能已是废弃家族环;`identityProof` 证所有权、**不证家族新鲜度**。故 pre-write 或 post-write preimage conflict 的 attempt 上,report 的 `freshened` auth-family 清除**丢弃/压制**(identity-check 观察可保留),auth flag 保持到后续一次 verified capture。真 producer 测试:capture 成功 → 同 anchor 账号 commit 前轮换 → conflict 返回 → auth 三标记仍在。
- **防伪**:parent 只信自己创建路径上的 report;伪造/手工路径拒绝测试。
- 测试(12):**真 bash producer**(非 adapter mock)× {成功 / stale / identity-mismatch / 多候选续跑} 断言清除不复活 + 伪造 report 拒绝。

## 3. Fix B(TS 侧,PR-2)— 引擎接线

### 3.1 `machine-reconcile.ts`

同 R4 版:scrub ambient GROUP_LEADER → detached 组(TERM→KILL)→ child 设 GROUP_LEADER=1;env scrub;stdout/stderr cap;先解析 10/20 的 typed outcome 再 collapse `unavailable`;60s 超时;真进程树测试。

### 3.2 tick 接线(短锁快照 → 放锁 spawn → 短锁全谓词重判)

1. 短锁快照:authority + `readKeychainRawDigest()`(新增)+ active 槽池 `rawDigest`。放锁。
2. 触发:authority 非 resolved **或** kcDigest ≠ activeSlotDigest → `runMachineReconcile`(episode 节流 `lastReconcile{witnessDigest,at}`,canonical JSON 编码同 R4)。
3. **episode 生命周期(R4#5 补全)**:
   - **健康快照短路**:tick 的第一次快照就已满足「resolved ∧ Keychain 可读 ∧ kcDigest==activeSlotDigest」→ 若存在 open episode,以显式 **`not_needed` 成功**清除之(覆盖「founder/另一条命令在两 tick 间已把一切修好」——否则 episode 因永不再 spawn 而卡死,且 stale 节流状态会压掉后续同 witnessDigest 的真新 episode)。
   - **attempted 清除谓词**:第二次短锁快照重复全部判定——resolved ∧ Keychain 可读 ∧ kcDigest==activeSlotDigest ∧ outcome ∈ {already_consistent, repaired} ∧ **`displaySynced === true`**(R4#2)——才清;`no_credential`/`unavailable`/digest 仍不等/display 未收敛 → throttled-but-open + 对应告警。
   - **告警三分**(R4#5):`blind`(Keychain 不可读/空)/ `machine_account_conflict`(证人分歧,现有)/ **新增 `keychain_pool_divergence`**(authority resolved 但 kcDigest≠activeSlotDigest 持续)。
4. 低频身份对账(`identityAuditMinutes` 360;durable `lastIdentityAuditAt`)与 C′ 同前。
5. `keychain_preimage_conflict`(§1.5)从 reconcile 返回时:terminal 处置 + **复用 `account_switch_failed` kind 上的专用 reason** 告警(founder 正在切号的信号,daemon 退避)。

### 3.3 pos-1 honest boundary

同 R4 版(polling 只 capture tick 时刻在场的身份;两跳不可找回;pos-1 前提 B 副本非真死;单跳窗口 = poll 间隔)。

### 3.4 状态/config/alert schema + 回滚真相

同 R4 版(新键进 allowed-key set/strict parser/defaults/迁移;`poolAgeAlerts` 句法校验+硬上限+运行时 prune;**revert ⇒ 保守 state 重置**如实写入部署说明 + strip 脚本 + 旧 loader fixture 测试);alert 表新增 `pool_credential_aging` 与 `keychain_pool_divergence` 两 kind,及 **`account_switch_failed` 的新 reason `keychain_preimage_conflict`**(R5#5)——三者的 routing/throttle/no-secret body 全进 strict 合同测试。live-identity outage 的 daemon 行为统一表述为「episode throttled-open,本 tick 不动作」(非丢状态的「跳过」)。

## 4. Fix C — 非活跃槽定期保鲜 + 老化报告(PR-2)

每轮定时扫描先直证活 Keychain 身份并唯一映射 anchor 槽;proof 不可得/不唯一时整轮零 refresh。对活跃槽以外的每个安全槽调用现有 freshness helper,refresh 成功则原子写回轮换后新凭据;30 拒绝则不写回、保留 auth fail-closed 并发老化点名。扫描与 `use`/`capture` 共用 account lock 和 lease fence,但不写 Keychain。原 C′ 的 24h durable 节流、authority 冲突时整轮跳过、secret 不外泄报告继续保留。

## 5. 兼容·回滚·撤项

### 5.1 兼容
行为变化面:(a)「活身份==target」→ no-op;(b) probe/归槽不可得 → fail-closed;(c) active 判定从标记换为活身份;(d) 并发外部写者 → typed terminal conflict(以前:盲写/盲回滚)。`IDENTITY_BYPASS` + 引擎 delegated `use` 现状测试全绿作兼容守卫;`sync_identity` 公共合同不变(新增 reporting helper);旧 `active-sync` 调用面不变。

### 5.2 回滚
PR-1:revert 即回现状。PR-2:revert 附带 monitor state 保守重置(§3.4 如实声明 + strip 脚本)。

### 5.3 历史撤项已被 Founder 终裁覆盖

R1–R7 「后台 refresh 保活 sweep defer」仅作评审历史保留,不再是交付决策;PR-2 按 §0.1/§4 实施安全化定期保鲜。

## 6. TDD 清单(实施节点 RED→GREEN)

bash(harness,OAuth/probe 全桩):
1. no-op 正:on A,`use A` → 0;`kc_write` 零调用 + mtime 不变;池 A 更新;audit。
2. no-op + marker 漂移:marker=B、活=A → `use A` 成功;顺序断言 fence→capture→store(readback)→marker→display;display 三态(成功/失败/oauthAccount.json 缺失)且失败不回滚、journal 已清。
3. probe/kc/归槽不可得 → `FLYWHEEL_LIVE_IDENTITY_UNAVAILABLE` fail-closed 四态零 mutation;`IDENTITY_BYPASS=1` → **同 bypass 意图结果 + 并发加固**(§1.4;含 bypass 模式的 post-journal / partial-write / 第三值注入例)。**adapter/executor 分类(PR-1,R5#3)**:marker → `LiveIdentityUnavailableError` terminal(无账号 flag、不试第二 apply、reason `live_identity_unavailable`);`FLYWHEEL_KEYCHAIN_PREIMAGE_CONFLICT` → terminal 不试下一候选。
4. R2#1 regression:marker/display=B、活=A、`use B`、B 池副本 access 活但 refresh 家族死 → 30、零 `kc_write`、A 已 capture、marker 收敛 A。
5. 负:活=C、池 A 死 → `use A` → 30。
6. **preimage 双 fence + 三路 rollback 注入族**:capture 前注入 → conflict 且池字节不变;rc44 后注入登录 → conflict 且新登录存活;commit identity GET 期间注入 → fence-1 conflict;**journal 创建后注入 → fence-2 conflict:target 未写、founder 字节存活、own-opId journal 已清**;`kc_write` 后 readback 前注入 → 不回滚第三值、journal 保留、terminal conflict;**(a) partial-write:`kc_write` 装上 target 但返非零、restore 前注入 founder 写入 → founder 字节存活**(R5#1);(b) readback-mismatch 与 (c) marker-commit-failure 两位点前注入 → founder 新字节存活;三态分类器「current==原 preimage」分支 → 不写、journal 已清、报原始失败;freshness POST 前注入 → conflict 无 POST。每例断言 stderr marker。
6b. **journal old-state tag crash-recovery(R5#2)**:absent preimage 下,journal 创建后 / target 写入后 / 条件 delete 后 cleanup 前三处 crash → recovery 各自收敛或安全清除(rc 44 只匹配 `absent` 端点);既有 v1 journal 兼容读取回归。
7. bootstrap:rc44 显式跳 probe;rc44 + marker==target + 池死 → freshness 必跑 → 30;rc44 + target 活 → 安装;bootstrap 回滚只删「仍==工具写入值」。
8. `next`:漂移下以活身份选后继;活身份槽不被选为后继。
9. delegated:纯一致 no-op(capture 保鲜)短路;需修复 → 46;`reconcile`+delegated env → 结构误用拒。
10. `reconcile`:0/10/20 各恰一 JSON(含 `displaySynced`);46/47/39 合同;`repaired` 后 marker/store/池一致;`unresolvable` 零 mutation;trampoline/dispatch/usage。
11. strict store:严格 flag 解析;generation 语义;`--freshened` 清三标记;`identityMismatch` 分歧保留;readback 失败非零;前缀失败注入 47;stdin cap。
12. **report 生产者通道(真 bash producer)**:delegated child 原子写 report(0600/no-follow/bounded);freshened 仅在 capture readback 后;{成功/stale/identity-mismatch/多候选续跑}×report 送达 parent;parent 共享 helper patch 最新 store 且 `working` 被替换 → 清除不复活;伪造/手工 report 路径拒绝;**conflict 压制(R5#4)**:capture 成功 → 同 anchor 账号 commit 前轮换 → preimage conflict → auth 三标记保持不清。

TS(vitest,spawn/fetch 桩 + 真进程树):
13. tick:conflict → reconcile → 全谓词(resolved ∧ kc 可读 ∧ digest 等 ∧ outcome 兼容 ∧ displaySynced)才清;`no_credential` 证人一致也不清 + blind alert;reconcile 后 digest 变 → 不清;**健康快照 + open episode → `not_needed` 清除**;stale 节流不压后续真新 episode;`keychain_pool_divergence` alert 触发;节流。
14. `readKeychainRawDigest` 稳定、secret 不外泄;短锁快照→放锁→spawn 顺序;witnessDigest canonical 编码。
15. identity audit:到期+不匹配 → reconcile;匹配/未到期/失败 → 无动作;durable。
16. C:每轮活 identity 直证;活跃槽 refresh 零调用;仅非活跃槽 refresh + 新凭据原子写回;proof/authority 非 resolved 整轮跳过;30 拒绝不写回且点名;阈值/节流/poolAgeAlerts 句法校验+运行时 prune。
17. state/config:新键 roundtrip;旧 loader 对 post-PR fixture = 保守重置不崩溃;strip 脚本;config 边界;alert 路由合同(两新 kind **+ `account_switch_failed`/`keychain_preimage_conflict` 新 reason 的 body/routing 断言**,R6#3)。
18. `runMachineReconcile` **monitor 侧分类(仅 PR-2 面;executor/adapter 断言在 PR-1 测试 3,R6#3)**:超时 TERM→KILL 真进程树;GROUP_LEADER scrub;10/20 → typed outcome;`keychain_preimage_conflict` → daemon 退避 + `account_switch_failed` reason 告警、`live_identity_unavailable` → episode throttled-open 本 tick 不动作——断言 monitor 分类结果,不只 exit 码。

## 7. QA(独立 QA 节点参考;复用 `qa-fly-1182-isolated-switch-drill.sh` 模式)

- E2E-1(pos-1,前提 B 副本非真死):手工登录 A → tick → digest 触发 reconcile → `use B` → `use A`,零人工。**路径区分(R7 note)**:直接手动 `use B` 走 `establish_live_active`,**当场自愈、不等 tick**(独立断言);「tick 前拒绝」只出现在 daemon/authority-gated 路径或两跳/死池变体。
- E2E-2(pos-2):`use <当前号>` → 成功 + Keychain mtime 不变。
- E2E-3(负):真死号 30;probe 断网 fail-closed;R2#1 场景;**并发登录注入**:切换各阶段写入第三值 → typed terminal conflict + 新登录存活。
- E2E-4:活跃期家族轮换 → 下一 tick freshened;display 未收敛时 episode 保持 open;外部修复后下一 tick `not_needed` 清除。
- 生产验收(ship 后,founder 在场):手工登录任一号 → ≤20min 对齐;Lead 代切一次成功。

## 8. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | OAuth 家族模型非官方合同 | 不依赖强形式;定时保鲜每轮重新直证 active,严禁刷 active 槽,单槽拒绝即 fail-closed + 点名 |
| R2 | probe 端点限频未知 | use/next +1、tick 触发 +1、audit 6h;失败即 fail-closed/跳过 |
| R3 | 手工登录不参与 accounts lock | §1.3 双 fence + compare-before-restore + absence fence;residual = 四处 primitive 级非原子窗口(如实,不给未测量的数量级);polling 边界如实 |
| R4 | daemon spawn 环境差异 | 生产已验证 detached runner;单层进程组 + 真进程树测试 |
| R5 | strict store / report-patch 双写面 | store 的 flag patch 单写者 = parent(共享 pure helper);bash 只报事实不写 store;readback + 失败注入 |

## 9. 交付切分

- **PR-1(bash + teamlead 混合合同)**:§1 + §2(含 `active-sync-strict`、report 生产者通道、`switch-executor.ts` patch helper)+ 测试 1-12。PR body 附构建/部署证据。
- **PR-2(TS daemon)**:§3 + §4(含 Founder 终裁的非活跃槽定期 refresh) + 测试 13-18 + QA 脚本 + state strip 脚本。依赖 PR-1。
- 实施节点全仓 gates + codex code review;ship founder-gated,照常。
