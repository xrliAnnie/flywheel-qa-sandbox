# FLY-1596 cmux legacy grouped → A1 迁移 + 运维重建合法通路 — 实施计划

Issue: FLY-1596 (https://linear.app/geoforge3d/issue/FLY-1596/cmux承接1578-legacy-grouped-a1-迁移-运维重建-cmux-视图的合法通路现在缺口)
日期: 2026-08-04
基于: exploration.md, research.md(+ Codex design review R1 九项全采纳,见 §13)

---

## 0. 一句话

**把「侧栏永远全且对」变成机器不变量:先拆掉自毁机(dismantle 阶段化 + prove-before-consume),再补上常驻自愈(三形态收编,终局 guard 复核全部证据),然后给运维一条骑 FLY-1482 让位窗口、开到「可验证终态」为止的带审计重建通路,最后用一个带代次围栏的只读判官把结果验收钉死。**

版本:v1.5x(ship 时取空号)。改动:`scripts/flywheel-cmux-sync.sh` + `scripts/lib/cmux-mutator-process-census.sh` + `scripts/test-cmux-sync.sh` + `scripts/test-teardown.sh`(mode 文法副本与 fixtures)+ runbook 文档;零 packages/ 代码。

## 1. 变更总览、优先级与 PR 切分

| # | 内容 | 性质 | PR |
|---|---|---|---|
| Fix 1 | dismantle 阶段化(tmux 半先行 + 结构化 stage/outcome)+ escrow/inventory 失败带因日志 + keeper inventory 锁的窄修 | P0,bug 修复,无开关 | PR-1 |
| Fix 2 | W1/W1'/W1-dead 三形态常驻收编(durable fingerprint + 终局 guard 全证据复核 + 崩溃恢复规则 + 预算化限速),`FLYWHEEL_CMUX_RESTORED_ADOPTION=0` 单一逃生口 | P0 | PR-1 |
| Fix 3 | `--rebuild-views` 运维通路(ops_rebuild claim + 让位窗口 + 全链事务到可验证终态 + 审计报告) | P1 | PR-2 |
| Fix 4 | `--verify-sidebar` 只读判官(七条终态规则 + 双端代次围栏) | P1 | PR-2(实现物在 PR-1 也可先落,供其 drill 用) |
| Fix 5 | 四类刷屏日志的有界 episode 去重限频 | P2 | PR-3(独立最后一个 PR,回滚不涉收敛逻辑) |

依赖序:Fix 1 → Fix 2 →(Fix 3、Fix 4)→ Fix 5。每个 Fix 独立可测、独立可回退(§10)。

## 2. Fix 1 — dismantle 阶段化

### 2.1 现状缺陷(research §3.3)

`dismantle_view_display()`(5034)先逐 ref `close_ledger_workspace_ref`(消耗收据关行),后处理 tmux 侧;tmux 半失败静默 return 1 → 行没了、canonical 名仍被占 → create ready gate 永久 defer。

### 2.2 改法:tmux 半先行 + 结构化 outcome(不许诺「零效果」)

重排为:unledgered 分支逐字保留 → 若视图存在:所有权证明 + escrow/unlink **先行** → 成功(或视图本就缺席)后才逐 ref 关行删收据。

**诚实的失败语义**(R1-4):escrow 链在失败前可能已留下持久效果(`@flywheel_cmux_owner` option 先于 inventory/rename 落盘,5002-5030;既有回归 test-cmux-sync.sh:6841-6860 明确证明这一点),多 ref 关闭也可能中途失败。因此 dismantle 不再声称原子,而是暴露**结构化 stage/outcome**(全局变量 `DISMANTLE_OUTCOME`,并落日志):

| outcome | 含义 | 后续推进者 |
|---|---|---|
| `preflight-refused` | 任何变异前拒绝(WAL 封锁/无代次/unledgered 同名行/restored 在途 —— 细分因由走独立 `DISMANTLE_REASON`,outcome 表保持四值穷举,R3-6) | 现状同义,收据与行原封 |
| `tmux-partial-recoverable` | escrow/unlink 中途失败;可能残留 owner option / prepared inventory 行 / 已改名 keeper | keeper inventory 对账 + 下一 tick 重入(owner option 残留对后续所有权证明无害且幂等) |
| `tmux-complete-cmux-pending` | 视图已让位,行/收据关闭未完成 | = reconcile-view-dead 既有形态,重入收敛 |
| `complete` | 全部完成 | — |

每个失败分支(escrow 9 处、`_inventory_upsert` 5 处、guard 失配)补 `log "WARN: dismantle stage=<s> failed view=<v> reason=<r>"`。repair else 分支(5753)文案改为携带 outcome,不再写误导性的 `(no ledger authority)`。
测试要求:**逐 failpoint 断言落在上表某个具名可恢复态**,禁止出现表外状态;不测也不宣称「零效果」。

### 2.3 keeper inventory 锁的窄修(R1-5,W2 收敛的前置)

`_inventory_upsert`/`_inventory_remove_sid`(4744/4770)现状:`mkdir .lock` 失败即 return 1,无 lease 断言、无残锁回收 —— FLY-1578 R5#2 的 stale-lock 死角原封在场,prove-before-consume 只能防消失、给不了收敛。窄修(不进口 §17.2 其余项):

1. 两函数入口加 `assert_or_reuse_owned_lease || return 1`(inventory 写从此绑定全局单写者);
2. 残锁回收:持有已验证 lease 时 `.lock` 目录存在 = 必为崩溃残留(单写者不变量),`rmdir` 回收 + `[audit] reaped stale inventory lock` 日志;非 lease 持有路径永不回收;
3. 崩溃测试:lock 取得后 / prepared 写后 / rename 后 / commit 前四个落点 SIGKILL → 重入收敛。

## 3. Fix 2 — 常驻收编:W1 / W1' / W1-dead

新函数 `adopt_restored_workspaces()`,lease 内执行。**挂点(R3-3:anchor-independent)**:在 bootstrap/additive 两个循环里,`recover_restored_transactions()` + W1-dead 观察/动作放在 durable-state 准备与严格快照结论化之后、**空/非空分支判定之前**(现 bootstrap 在窗口清单为空时 6311 直接 return、additive 走 6363 quiet 分支 —— 若挂在 title reconcile 之后,「源全缺席」恰恰是 W1-dead 最该跑的时刻却永远跑不到);W1/W1' 收编保持在 `reconcile_workspace_titles` 之后。恢复 close 与 W1-dead close 消耗同一个 §3.5 预算。测试:零 agent 窗口下的首次观察 / grace 完成 / mint 崩溃恢复 / 严格清单 inconclusive。

### 3.1 证据模型:durable fingerprint + 终局 guard 全证据复核 + in-flight 事务独占(R1-1, R2-1)

复用 stock reaper 的骨架(键控宽限 + `_stock_final_close_guard` 模式,1550-1659),但**状态文件独立**(R4-1):

- **独立 state 文件** `RESTORED_STATE=~/.flywheel/state/cmux-restored-adoption` —— 不与 `ADOPTION_STATE` 共文件。原因:`reap_unledgered_stock_workspaces` 用 keep-list **整文件重写**(1654),不保留未知前缀行;共享文件意味着 additive pass 里排在后面的 stock reaper 能在同一 pass 抹掉刚写下的在途标记,合成收据立刻回到普通权威。写法同款 tmp+mv 原子;交叉测试:stock 重写(mint/promotion 后)保留 restored 行、restored 写入/回滚保留 stock 宽限行、任一 namespace 重写中途崩溃 → 文件是完整旧版或完整新版,绝无混合/空文件;畸形 restored 行必须在无关 stock GC 下存活(rc=2 fail-closed 的前提)。
- **标记行 schema(R6-2 + R7-2:定界安全)**:版本化行文法 **`restoredv1|<kind:W1|W1p|W1dead>|<generation>|<ref>|<title_b64>|<orig_b64>|<fingerprint>|<epoch>`**(恰好 8 列)。`orig_b64` = 原收据元组 canonical 串 `state|generation|ref|title` 的 **base64**(原元组自身含管道,不得裸嵌);`title_b64` 同理。读取端:列数恰 8 → 逐字段文法校验 → base64 解码 → 解码值再按各自严格文法复验(title 拒 `|`/TAB/换行/控制字节;元组拒非法 state/形态),任何一步不过 = 畸形 = rc2;`epoch` 校验含**未来时间/非数字 = 畸形**(fail-closed,绝不因坏 epoch 永远 wait,R9-1)。**定界注入 fixtures**:管道/换行/控制字节注入不可能产出第二条逻辑记录;畸形列数 → rc2;一条有效 `restoredv1` 记录即阻塞 drain;**只含畸形行的文件同样阻塞 drain(R8-2)**。**全文统一记号(R7-2)**:持久记录一律称「有效 restoredv1 记录」;§3.6 flag 语义、§5 判官第七条、§10 drain 判定全部基于**严格解析器**:drain 成功 = `parser rc=0 ∧ valid_count=0`(只含畸形行的文件 = drain 失败,不是「零有效记录即空」,R8-2);不是文本前缀 grep。fingerprint = `hash(generation|ref|title|surface-title|证据向量)`,首见写入 `RESTORED_STATE`,**连续两个 conclusive pass** 逐字一致才进入动作。**写序合同:标记先于任何账本变异落盘**(mint/promotion 前标记必须已在),恢复端才能永远从标记反推。
- **恢复决策表(R7-1:逐 cell 落进 plan,表驱动测试从本表生成,resident 与 ops 共用同一实现)**。判定优先序:先行条件 → 代次关系 → kind × 账本观察 × ref 在场 × flag/证据。每 cell 恰一个 owner、恰一个动作:

  | # | 条件(按优先序短路) | 动作 / owner |
  |---|---|---|
  | 0 | 标记畸形 / 账本或 cmux JSON 不可读 / 严格快照 inconclusive | quarantine + 告警;闸继续围(owner=recover) |
  | 1 | 当前代次证明不了 | defer(wait);闸继续围 |
  | 2 | 代次陈旧 ∧ L=none | 终局删标记(旧账本已净,无可回滚) |
  | 3 | 代次陈旧 ∧ L=合成 committed(W1/W1dead) | `_restored_ledger_cas` 删旧行 → 删标记 |
  | 4 | 代次陈旧 ∧ L=预期 committed(W1p) | `_restored_ledger_cas` 恢复原 prepared(旧代次行,后续归既有 stale-ledger 卫生 4704-4740)→ 删标记 |
  | 5 | 代次陈旧 ∧ L=原 prepared 仍在(W1p 未 promote) | 终局删标记(前置态原封) |
  | 6 | 代次陈旧 ∧ L=冲突 | quarantine |
  | 6.5 | 当前代次 ∧ **flag on ∧ ref 在场** ∧ 证据 conclusive 且 fingerprint 稳定 ∧ **分支前置账本态原封**((W1/W1dead ∧ L=none)∨(W1p ∧ L=原 prepared))∧ **就绪条件未满足**(W1/W1p:latch 未满两个 conclusive pass;W1dead:`now - first_seen < grace`)| **wait**:标记保留、账本/cmux 零变异、不消耗动作预算(R9-1/R10-1;flag off 时不落此行 —— 直接落 #8/#14 立即非破坏终局;`grace-1` 边界必须落此行且字节不变,`grace` 才许进 #7/#13)|
  | 7 | 当前代次 ∧ W1/W1dead ∧ L=none ∧ ref 在场 ∧ flag on ∧ latch/证据就绪(W1dead 含 grace 已到) | advance:guard 下 mint(owner=adopt) |
  | 8 | 当前代次 ∧ W1/W1dead ∧ L=none ∧ ref 在场 ∧(flag off ∨ 证据漂移) | 非破坏终局:删标记(未 mint,无可回滚) |
  | 9 | 当前代次 ∧ W1/W1dead ∧ L=none ∧ ref 缺席 | 幂等终局:删标记(行已由他途消失) |
  | 10 | 当前代次 ∧ W1/W1dead ∧ L=合成 committed ∧ ref 在场 ∧ flag on ∧ 证据复证通过 | recovery-close(能力标记 + restored guard)→(W1)create 重建 /(W1dead)止 |
  | 11 | 当前代次 ∧ W1/W1dead ∧ L=合成 committed ∧ **ref 在场** ∧(证据漂移 ∨ flag off) | CAS 回滚 committed→删行 → 删标记 |
  | 12 | 当前代次 ∧ W1/W1dead ∧ L=合成 committed ∧ ref 缺席(**与 drift/flag 无关,R8-1:缺席 ref 永远归 GC,绝不 CAS**) | 留给既有 committed-GC 清行(4679-4701,唯一显式放行);行净后落 #9 删标记 |
  | 13 | 当前代次 ∧ W1p ∧ L=原 prepared ∧ ref 在场 ∧ flag on ∧ 证据就绪 | advance:guard 下 promote |
  | 14 | 当前代次 ∧ W1p ∧ L=原 prepared ∧(flag off ∨ 漂移) | 终局删标记(前置态原封,abort 无事可回) |
  | 15 | 当前代次 ∧ W1p ∧ L=预期 committed ∧ ref 在场 ∧ flag on ∧ 复证通过 | recovery-close → create 重建 |
  | 16 | 当前代次 ∧ W1p ∧ L=预期 committed ∧ **ref 在场** ∧(漂移 ∨ flag off) | CAS 恢复原 prepared → 删标记 |
  | 17 | 当前代次 ∧ W1p ∧ L=预期 committed ∧ ref 缺席(**与 drift/flag 无关;绝不 CAS 恢复 prepared —— 缺席 ref 的 prepared 会被 4620-4624 永久 preserve 成僵尸**) | 留给既有 committed-GC;行净后落 #18 |
  | 18 | 当前代次 ∧ W1p ∧ L=none ∧ ref 缺席 | 终局删标记(事务已被 GC 收尾;**不**恢复 prepared —— 给缺席 ref 造 prepared 行 = 重造僵尸) |
  | 19 | 当前代次 ∧ W1p ∧ L=none ∧ ref 在场 | quarantine(行凭空消失而 ref 活着 = 意外态) |
  | 20 | 任意 ∧ L=冲突(多行/非预期元组) | quarantine |

  两条铁律由表结构保证并单测锁死:**W1/W1dead 任何 cell 都不产生 prepared 行;W1p 的回滚 cell 只恢复 prepared、绝无删到 none 的路径**(#18 是观察到 none 后的终局,不是删除动作)—— 含重启后。表驱动测试逐行生成,**另加 Cartesian 互斥/覆盖生成器测试(R8-1,R9-1 扩维 `readiness={not-ready, ready}`):枚举全部具体状态组合,任一状态命中 0 行或多行非 catch-all 即失败**(逐行 fixture 抓不到重叠;`grace-1`/`grace` 两个确定性边界例:前者保标记零变异,后者才可进 advance 并消耗预算;**`readiness=not-ready × flag={on,off}` × 三 kind 全组合:flag on → #6.5 wait 字节不变零预算,flag off → 立即 #8/#14 删标记且账本/cmux 零变异,R10-1**);显式增补 committed+absent × {drift, flag off} × {W1, W1p} 四例,断言 #12/#17 胜出、`_restored_ledger_cas` 零调用、committed-GC(4679-4701)清行后才走 #9/#18 删标记。resident 与 ops 不允许各自解释。
- **分阶段收据谓词(R2-1)**:W1 在 fingerprint 取证与 mint 时刻均要求 `ledger_candidate_receipt_state == none`;W1' 在 promotion 前要求**唯一一条 prepared**;终局 close 时要求**恰好一条预期 committed** ref/title 且无冲突行。三个阶段谓词分别测试,不复用同一句 C4。
- **终局 guard**:所有 close 走 `close_ledger_workspace_ref` 的 `extra_guard` 挂点(4010,stock reaper 先例),guard 内**在 lease 下重读全部证据**(分支各自的源窗谓词 / 行唯一 ref 逐字 / 视图缺席 / 阶段收据谓词 / surface 指纹 / 双端代次一致),任何一项漂移 → guard 拒 → **mint 前**:本轮放弃、fingerprint 作废重新起算;**mint/promotion 后**:进入下方相位感知 abort(回滚合成收据/quarantine),绝不是清 fingerprint 了事(R4-4)。外部 tmux/cmux 变化不受 lease 约束,这一层是唯一能封住 stale-observation-becomes-authority 的地方。
- **in-flight 事务独占(R2-1 + R3-1:覆盖全部账本消费者,不止 dismantle)**:有效 restoredv1 记录同时是**在途事务标记**。崩溃落在 mint/promotion 之后会残留一张合成收据;任何普通消费者拿它当权威 = stale-observation-becomes-authority 复活。封堵为**单一 tri-state 权威闸** `restored_inflight_state <generation> <ref> <title>`(rc 0=在途 / 1=无标记 / 2=标记不可读或畸形 —— **rc 2 一律按在途处理,fail-closed**),接入**枚举过的完整消费者图**:
  1. `close_ledger_workspace_ref`(咽喉,一切 close 含 orphan-pin 路径都过它):在途收据一律拒,除非调用方持有 **restored-recovery 能力标记**。能力标记**不是进程级布尔**(R4-3):绑定到精确 `generation|ref|title|fingerprint` 四元组、单次调用作用域、进入时要求 `restored_inflight_state == rc0`(rc2 永不可被能力绕过)、所有返回路径清除;仅 `recover_restored_transactions` 与 3.2/3.3 的 restored close 路径设置;
  2. `reconcile_prepared_ledger`:对匹配的**在场** ref 跳过(prepared 重驱动 / prepared-loser close / `complete_title_migration` promotion 都不得碰在途行);committed+**缺席** GC 分支是唯一显式放行(它正是 3.2 恢复规则的 owner);
  3. `reconcile_workspace_titles` / `complete_title_migration` / `close_prepared_loser_ref`:在途 title/ref 直接跳过;
  4. `dismantle_view_display` 预检:在途 → `DISMANTLE_OUTCOME=preflight-refused`(reason=`restored-inflight`,见 §2.2 —— 不扩表);
  5. **显式拆分的 pass 序(R4-2,替代「排在一切消费者之前」的粗描述)**:现 `prepare_linked_view_state`(4930)捆绑了 construction-WAL 恢复、`reconcile_prepared_ledger`、keeper inventory 对账;restored 恢复放它之前会缺 WAL collision 阻断集,放它之后 prepared 消费者先行。**拆分**为:
     `assert authority → 构造 WAL 恢复/quarantine + collision 阻断集 + keeper 准备(非账本消费部分)→ 严格快照 → recover_restored_transactions + 预算内 W1-dead → reconcile_prepared_ledger(带在途闸)→ invariant/existing/title 对账 + 活体收编`
     改动清单里点名拆分 `prepare_linked_view_state` 为两段并重排 `refresh_linked_sessions`/两循环的调用序;ops 编排器同序。
  测试:**逐消费者**断言拒碰在途收据(不只 dismantle);mint 后、promotion 后 SIGKILL 分别断言恢复只经 restored guard 到达 close;**在途 restored 行与未决/畸形构造 WAL、prepared 账本行共存**的三方组合测试(R4-2)。
- **相位感知的非破坏 abort(R3-2)**:证据漂移时**不是**清掉标记了事 —— 合成收据必须先原子回滚:W1 `committed → 删行(回到 none)`;W1' `committed → 恢复原 prepared 行`;账本回滚成功后才清标记。回滚证明不了 → 标记保留为 quarantine + `cmux_cleanup` 告警(在途闸继续挡住所有消费者)。测试:漂移且 ref 在场、回滚中途崩溃、W1/W1' 各在途时的 abort。
- **标记终态收尾(R4-3)**:事务走完(close 成功 + 账本行已除)后、删标记前崩溃 → 残留「有效 restoredv1 记录 + ref 缺席 + 无收据」孤儿标记;close-success/remove-fail 由既有 committed-GC 清行后同样残留孤儿标记。终态清理:在 conclusive 的代次/ref/收据三查(ref 缺席 ∧ 无当前代次收据 ∧ 代次未变)下删除孤儿标记,audit 记录;崩溃测试:账本行移除后、标记删除前 SIGKILL → 重入清理。
- **跨代次 settlement(R5-2)**:标记记录的 cmux 代次一旦变陈旧(app 重启 —— 恰是验收 drill 的核心场景),标记既围不住当前代次消费者、又会永久卡死 drain,还可能与被 stale-ledger 路径刻意 preserve 的旧合成收据(4704-4738:旧行 ref 在场即 preserve)共存。定义**结论性代次迁移 settlement**:绝不因 ref 字符串巧合匹配而关/改**当前代次**的任何 cmux 对象;只用标记的 provenance 回滚**旧代次合成账本迁移**(W1 删旧合成 committed 行;W1' 恢复其原 prepared 行),账本回滚成功后原子清标记;证据不可读/歧义 → quarantine 保留;当前代次证明不了 → defer。**账本原语(R6-1):不得用现有 `_ledger_upsert` 做该回滚** —— `_ledger_transaction upsert` 按 ref 删行**无代次谓词**(3857-3863),ref 被当前代次复用时会先删掉一张有效的当前代次收据。新增窄的 lease 绑定、inner-lock 内 CAS 原语 `_restored_ledger_cas`:要求账本中恰好存在标记授权的旧元组且处于预期态,只替换/删除 `(old-generation, ref)` 那一行,其它代次行字节保留;W1 删除同样要求预期合成 committed 元组逐字在场;缺席/已恢复 = 幂等终局,重复/意外态 = quarantine。四个跨代次落点测试各加一个「ref 被当前代次复用且带 committed 收据」变体,断言当前 cmux 对象与该收据字节不变。重启落点测试:pre-mint 标记后 / W1 mint 后 / W1' promotion 后 / close+账本 GC 后删标记前,各注入 cmux 重启 → 断言当前代次行零触碰、常驻收敛与 flag=0 drain 均可终止。
- **flag=0 的确定性语义(R4-3)**:既有在途事务**保持被闸围住并走非破坏 abort 路径**(回滚到相位前态),绝不「恢复成 close」—— 紧急回滚场景下 flag=0 的效果是收敛到零在途、零合成收据,而不是继续动侧栏。

### 3.2 W1:恢复行收编(adopt-to-close → create 全链重建)

前提(C1-C5,均在 fingerprint 与终局 guard 双处取证):

| 条件 | 取证 |
|---|---|
| C1 title T 恰好一个活受管源窗口(pane_dead=0) | **新的严格类型化 tmux 快照助手**(R2-2):现 `get_tmux_agent_windows`(552)不读 pane_dead 且 `\|\| true` 吞错,部分读取会伪装成「唯一在场/确凿缺席」。沿 `collect_agent_window_names_strict`(1668)/`read_roster_tmux_inventory`(669)的 fail-closed 家族新增 `strict_agent_window_snapshot`:携带 session/wid/name/pane_dead,任一读失败 → rc=2 inconclusive,本 pass 放弃 |
| C2 恰好一个行 title ∈ {T, canonical_raw(T)},ref 形态合法 | 单快照 JSON |
| C3 视图 `cmux-T` 缺席 | `linked_session_exists` |
| C4 阶段收据谓词(§3.1:此分支 = mint 前 none) | 账本 |
| C5 恰好 1 个 surface,surface title ∈ {T, canonical_raw(T), "~"} | `workspace_single_surface_title` |

动作:`_ledger_upsert committed`(audit 行)→ `close_ledger_workspace_ref ... restored-adoption-<T> <终局guard>` → 既有 create 全链重建。选 adopt-to-close 而非原地复活:恢复行 surface 是死壳,heal 的「裸活 shell」前提不成立;create 全链是今晚 10/15 自动收敛验证过的最强路径。

**崩溃恢复规则(R1-1 / R2-3 修正)**:
- close 成功但 `_ledger_remove` 失败/崩溃 → 残留「committed 行 + ref 缺席」:恢复 owner 是**既有** `reconcile_prepared_ledger` 的 committed-GC(4679-4701 —— 当前代次 committed 行的 ref 缺席/改名今天就会被 GC;belle 今晚即由此自愈)。**不新增 GC、不改其既有语义**。测试:close-success/remove-fail 后既有 refresh GC 清行 + create 解锁;reverse-compat 测试证明 fingerprint 缺席的 committed+absent 清理行为逐字不变。
- mint/promotion 后、close 前崩溃 → 残留「committed 行 + ref **在场**」:更硬的在途态,owner = §3.1 的 `recover_restored_transactions()` + 普通消费者预检拒碰。

### 3.3 W1':prepared 漂移壳 —— promote-then-close,不造第二条 close 族(R1-1)

前提:该 ref 当前代次 **唯一一条** prepared 行;surface title ∉ {T, canonical_raw(T)}(漂移:`:5` 尾巴 / `~`);C1/C2/C3 同上。
动作:在终局 guard 复核通过的同一持锁窗口内 `_ledger_upsert committed`(promote,audit 标 `promoted-drifted-prepared`)→ 立即走 **committed 咽喉** `close_ledger_workspace_ref`(同 3.2 的 guard 与恢复规则)。不再有「guarded close → 手工 `_ledger_remove`」的旁路;close-success/remove-fail 落进 3.2 的同一恢复规则。

### 3.4 W1-dead:死 title 清理(「死 session 必无行」)

前提(R2-2 收窄):title ∈ **roster 派生合法 lead title 集(`derive_lead_roster`)——仅此**,runner 文法一律留给既有 stock reaper(文法不是关闭 founder 行的权威;不重复造 runner 权威);源窗口**确凿缺席**(用 §3.2 的严格快照助手:rc=0 且清单里无 T 才算缺席,任何读失败 = inconclusive 放弃 —— 与 W1/W1' 的「唯一在场」是两个**不同的谓词**,终局 guard 按分支选用,不共用「唯一活源」句);视图缺席;C2/C5 行与 surface 证明同 §3.2;unledgered(mint 前 none);grace ≥ `FLYWHEEL_CMUX_ADOPTION_GRACE`(复用既有 300s 默认)。动作 = 3.2 的 adopt-to-close,无重建后续。实现抽 stock reaper 的 fingerprint+grace 骨架复用。

### 3.5 预算化限速(R1-6:两个/tick 撑不住 5 分钟验收)

每个 additive pass 的收编动作预算 = `max(4, ceil(N_titles/3))`(N_titles = 本 pass 判型为可收编的 title 数;env `FLYWHEEL_CMUX_ADOPTION_BUDGET` 覆盖,边界校验)。另:**restart/reopen conclusive 事件后的 bootstrap pass 预算翻倍**(全量重启是收编需求的峰值时刻,也是 5 分钟验收的计时起点)。附**确定性 15-title 时序测试**:模拟 15 个 W1 → 断言 latch(1 pass)+ 预算节奏下全部收敛所需 pass 数 × 60s + 健康恢复余量 < 300s。

### 3.6 安全边界与逃生口

- founder 行:C5 surface 闸 + C1/C2 双唯一 + 文法/roster 闸 + 终局 guard 复核,任一歧义 → 逐字既有 refuse+告警。
- 每次收编:audit 行 + `cmux_cleanup` 告警(只验产出)。
- `FLYWHEEL_CMUX_RESTORED_ADOPTION=0`(R3-2/R5-3 语义):只停止**新事务的发现与铸造**(3.2/3.3/3.4 不再开新单);**在途闸继续围住既有标记,且既有在途只走非破坏 abort 与终态/跨代次 settlement —— 绝不 recovery-into-close**(否则残留合成收据立即回到普通消费者手里)。完全 byte-compat 的关断要求先证明 drain(严格解析器计数为零条有效 restoredv1 记录);reverse-compat 哨兵按此语义写。测试:flag=0 且 W1/W1' 各有在途标记 → 闸仍生效、abort 收敛、drain 后行为逐字回归。

## 4. Fix 3 — `--rebuild-views` 运维通路

### 4.1 CLI 合同(R1-8:边界输入全量校验)

```
flywheel-cmux-sync --rebuild-views (--all-leads | --target T[=workspace:N] ...)
                   [--execute] [--handover]
```

- 目标文法:`--target T` 可重复;歧义指定用 `--target T=workspace:N`(ref 绑定在 title 上,消除多 `--title` × 单 `--ref` 的歧义)。`--all-leads`(roster 派生)与 `--target` 互斥。
- **两阶段边界校验(R2-6:语义校验必须读活状态,不可能先于一切 IPC)**:
  - **阶段 A(词法/结构,先于任何 IPC)**:未知 flag、flag 冲突、目标重复、ref 形态非法、title 含 `|`/TAB/换行字节 → 拒绝退出,零 IPC 零副作用;
  - **阶段 B(语义解析,只读 IPC,先于任何副作用)**:roster 派生 + 活窗口/cmux 只读快照 → 未知 title(∉ roster ∪ 活受管窗口)、歧义不可达 → 拒绝退出;**只有阶段 B 全过才允许** claim 发布 / 报告文件创建 / lease 获取 / 任何变异。
  - 目标集去重后排序固定;**preview 与 execute 共享同一份解析结果与判型快照代码路径**(不可变目标集贯穿)。
- **exact-ref 语义(R2-4)**:`--target T=workspace:N` 指定的是**本次授权作用的那一行**(按判型 retire/adopt);它不是对同 title 其它行的关闭授权。阶段 B 预检:该 title 的其余同名行必须(a)不存在,或(b)可经**既有** guarded duplicate 原语(fly1605 keeper-ready 路径)收敛 —— 否则该 title 上前拒绝(refuse up front),绝不为凑「唯一行终态」关闭证明不了的行。终态不可达 = 不开工,而不是开工后半途而废。
- 默认 dry-run:不取 lease、零变异,逐 title 打印判型(W1/W1'/W2/absent-both/healthy)+ 将执行动作序列。
- `--execute`:watcher 不在跑 → 直接 `acquire_mutator_lease ops_rebuild`;watcher 在跑且无 `--handover` → 报错退出(绝不抢)。
- `--execute --handover`:写 ops claim → 等 watcher 让位(默认上限 90s,超时撤 claim 报错退出)→ 干活 → 撤 claim。全程不碰 launchd,不撞 FLY-913。

### 4.2 让位窗口:骑 FLY-1482,泛化 claim(R1-3:补齐全部消费者)

- 新 claim 文件 `${CMUX_MAINTENANCE_MARKER}.ops-rebuild`,行格式 `pid|incarnation|ops_rebuild|nonce`。
- 泛化 `_read_qa_teardown_claim` → `_read_maintenance_claim <file> <expected_mode>`(qa 调用点参数化,byte-compat);`maintenance_requested` 增查 ops claim;`watcher_maintenance_checkpoint` 的 stale-claim 回收(含 hard-link activity fence)对两种 claim 各跑。
- **改动点全清单**(遗漏任何一处 = 上线即断,R1-3 实测过两处):
  1. `_read_mutator_owner` mode 白名单(6781)+ `acquire_mutator_lease`(7165);
  2. `maintenance_entry_allowed`:新增**自有 claim 例外** —— `ops_rebuild` 模式放行的唯一条件是 claim 的 `pid|incarnation|mode|nonce` 与当前进程逐字自证(防「有任何 ops claim 存在就放行」被他人 claim 搭车);`--once/--refresh` 在任何 claim 存在时照旧被拒;
  3. `scripts/lib/cmux-mutator-process-census.sh`:动词白名单(line ~46)是**精确枚举**,必须加 `--rebuild-views`,否则 census 把 ops 进程当非 mutator(lease 重建误判);
  4. `scripts/test-teardown.sh:76` 的 owner-mode 文法副本 + 相关 fixtures/contract 测试。
- 互斥:qa claim 与 ops claim 并存时后到者 fail-closed 退出(先到先得);测试覆盖:冷启动 / 活 watcher handoff / 并发 qa+ops / 畸形 claim / SIGKILL 残留 / stale lease 重建。

### 4.3 per-title 事务:开到可验证终态(R1-2)

共享一套**低层 classify/guard/mutate 原语**(= Fix 1/2 的实现),ops 编排器与常驻路径的差异只有两点:①操作员显式枚举 = 越过「歧义 → refuse」闸的唯一新增权威;②不等两-pass latch —— 以**同一持锁窗口内的两次间隔重读一致**替代(等价的 conclusive 双观察,inline 完成)。

**作用域与重验(R3-4)**:ops 模式下 `recover_restored_transactions` 以解析出的不可变目标集为参数 —— 目标外的在途事务**只报告不变异**(`--target A` 拿到的全局 lease 不是处置无关 title B 的授权;resident 模式保持全量)。`--handover` 等待可达 90s,阶段 B 的判型/exact-ref 绑定/其余行处置/终态可达性**在拿到 lease 后全部重算**,漂移 → 该 title 上前拒绝零变异。测试:target A + 在途 B(B 字节不变);handoff 期间新增冲突行 → 拒于变异前。

每 title 驱动**完整收敛链**,不是「代跑一个 resident tick」:

```
re-probe 判型 → (W1: adopt-to-close | W1': promote-then-close | W2: dismantle 阶段化)
→ 源窗口活着 ⇒ 直接调 create_workspace_for_window(视图重建 + 行创建 + 改名 + committed 收据 + verify-attach 全链)
→ 终态 readback:行存在 ∧ 视图 A1 匹配 ∧ 恰一条 committed 收据 ∧ 无 restored 标记
→ 单 title 复核 = `--verify-sidebar --target T` 同一套七条终态规则(§5)
```

**create 腿的两处 ops 专属处理(R2-4)**:
1. `create_recently_attempted` 30s TTL(5317-5320)会把「刚失败过的 resident create」变成 ops 里的假成功 return 0 —— ops 路径以 **lease 已证 + 精确目标**为条件旁路该 TTL(仅 ops 编排器内;resident 路径字节不变);
2. create 的 return 0 不当成功读:**强制终态 readback**(上链的第三行)才是唯一成功判据,readback 不达 = 该 title FAILED。

失败 → 停在该 title,后续 title 不动,报告标 FAILED;操作员显式决定重试(「真失败即停」语义保留)。

### 4.4 审计与报告

所有变异走既有 `[audit]` 咽喉;运行报告 `~/.flywheel/state/cmux-rebuild-reports/<UTC-ts>-<nonce>.txt`(判型表 + 每 title 动作/结果 + 前后 verify 摘要)+ stdout;结束一条 `cmux_cleanup` 汇总告警。runbook `doc/engineer/implementation/cmux-ops-rebuild-runbook.md`:手敲 tmux/cmux 变异命令修侧栏从此非法,一律 `--rebuild-views`;替换 08-04 更正过的手修手册段落。

## 5. Fix 4 — `--verify-sidebar` 只读判官(R1-7/R5-1/R6-3:七条终态规则 + 代次围栏)

新入口,零 lease、零变异。断言集:

1. 活必有行;2. 死必无行(lead 文法按 roster);3. 视图 A1 拓扑(grouped=0 ∧ active=members={wid} ∧ owner=源 ∧ marker=0);4. pane 真活(`pane_pid(view:active)==pane_pid(源:wid)` ∧ `pane_dead=0` ∧ 非裸 shell);5. 附着真实(view client ≥1);**6. 账本一致:恰好一条当前代次 committed 收据绑定唯一 ref/title,无 prepared / 无冲突当前代次行**。

**围栏(R2-5 + R3-5:代次不动 ≠ 状态不动)**:代次只对重启敏感,同代次内的 close/rename/窗口置换/client 掉线/账本改写/Lead job 装卸全部探不到。因此判定基于**双份完整可变证据集等值**:把「cmux JSON + 严格 tmux 清单与拓扑 + pane/client 事实 + 账本字节 + **canonical 排序的 `derive_lead_roster` 结果与解析后的 subject 集** + **canonical 化的 `RESTORED_STATE` 字节(R5-1)**」作为一个复合快照,**取两次、无序证据先 canonical 化再逐字比较**(枚举顺序差异不得制造永久 inconclusive),相等才进入判定;任何差异 → exit 2。**第七条终态规则(R5-1 + R6-3)**:subject 存在**任何有效 restoredv1 记录(严格解析,当前代次或陈旧代次)** = 在途未完事务 = 该 title FAIL(六不变量全过也不行;陈旧标记同样卡 §10 drain,settlement 完成清掉标记后才许 PASS);restored 状态不可读/畸形 = exit 2;两次读取之间 restored 状态变化 = exit 2。ops(§4.3)与验收全部按**七条终态规则**判,不是六条。外层再加开头/结尾的 cmux+tmux 代次围栏(重启粗筛)。roster 派生失败 / JSON 畸形 / pane 或 client 读不全 → exit 2(inconclusive,绝不当 PASS)。输出逐 title `PASS|FAIL <title> <败因>`,整体 exit 0/1/2;`--json` 给 harness。测试:healthy-but-unledgered / prepared 残留 / 重复收据 / cmux 中途重启 / tmux 中途重启 五个假 PASS 陷阱,**加同代次五陷阱:中途 close/rename、窗口置换、client 掉线、账本改写、roster 装卸**,**加 restored 四陷阱(R5-1/R6-3):六不变量全过但带**当前代次**在途标记 → FAIL、六不变量全过但带**陈旧代次**稳定标记 → FAIL(settlement 清标记后才转 PASS)、restored 状态畸形 → exit 2、两读之间标记变化 → exit 2** —— 全要红(exit 2 或 FAIL)。

## 6. Fix 5 — 有界 episode 去重限频(R1-9,独立 PR-3)

**一 title 一行**:state 文件 `cmux-log-episodes` 按 `kind|title` 键控(不按 evidence-hash 开行),行内含 `当前evidence-hash|last-emitted|suppressed-count`。evidence 变化 = 状态变化 → 必打 + 重置计数;重复态每 `FLYWHEEL_CMUX_LOG_REPEAT_SECONDS`(默认 3600,`0` = 逐条全打 byte-compat)打一条 `(suppressed N repeats)` 汇总。原子写(tmp+mv)、lease 下写、healthy 即删行(re-arm)、title 消亡 GC(复用既有 gc_* pass 形态)、文件行数上限 = 活 title 数天然有界。类永不静音;注入违规必产出首条。

## 7. 测试面

| 层 | 断言(新增于 R1 的加粗) |
|---|---|
| harness 真值表(test-cmux-sync.sh) | Fix 1:escrow 各步失败 → **落在 §2.2 具名 outcome 表内**(不再断言零效果);**inventory 四落点 SIGKILL → 重入收敛;残锁在 lease 下回收、非 lease 不回收**;Fix 2:C1-C5 逐条失败零变异;**终局 guard 在 close 前证据漂移 → 拒(mint 前 fingerprint 作废;mint/promotion 后走相位 abort 回滚)**;**mint/promotion 后 SIGKILL → 普通 dismantle 不能消费该收据(R2-1 独占测试)+ 恢复只经 restored guard 到 close**;**close-success/remove-fail → 既有 committed-GC 清行 + reverse-compat 证明 fingerprint 缺席行为逐字不变(R2-3)**;**严格快照助手 rc=2 → W1「唯一在场」与 W1-dead「确凿缺席」都判 inconclusive(R2-2)**;W1' promote-then-close 的阶段谓词;W1-dead 活窗/grace 内/非 roster title 拒;**15-title 时序测试(3.5)**;Fix 3:**两阶段校验矩阵(词法零 IPC;语义只读;副作用最后)**;**exact-ref 终态不可达 → 上前拒绝零变异(R2-4)**;**ops 专属 create-TTL 旁路只在 lease+精确目标下生效、resident 字节不变**;claim 自证例外;**并发 qa+ops 互斥**;census 动词、test-teardown 文法副本 contract;Fix 4:七条终态规则各自击穿 + **十四个假 PASS 陷阱(五重启/收据 + 五同代次含 roster 装卸)→ exit 2/FAIL**;**R3 增补:tri-state 闸逐消费者拒碰在途收据(prepared 重驱动/promotion/title 收编/prepared-loser/orphan-pin 经咽喉)**;**abort 三测(漂移且 ref 在场 / 回滚中途崩溃 / flag=0 带在途标记)**;**零 agent 窗口下 W1-dead 首观察/grace/恢复/inconclusive 四测**;**ops:target A + 在途 B 字节不变、handoff 后重算 preflight**;Fix 5:抑制/变化必打/`0` byte-compat;`RESTORED_ADOPTION=0` 按 R3-2 语义的 reverse-compat 哨兵 |
| real-tmux 集成 | grouped 夹具 → Fix 1 阶段化:人为致败 escrow(占 keeper 名)→ 行与收据在场 + outcome=tmux-partial-recoverable;放开 → 收敛 A1 → verify PASS(核心断言不放在沙箱会 skip 的段里) |
| 事故重放 | 复用 qa-fly1272-incident-replay.sh 拓扑:收编→迁移→重建全链;两半之间 SIGKILL 重入 |
| 真机 drill(QA 节点,禁 stub) | §9-2 两个重启 drill + 注入 drill + `--rebuild-views --handover` 全链实跑(watcher yield/复归/RESYNC 实证);期间侧栏会闪,提前知会 Tadashi/Annie |

## 8. 部署与存量清理顺序

1. merge 后经既定安装路径(`flywheel-cmux-install.sh` / `scripts/lib/restart-cmux-watcher.sh`)换 watcher —— 不裸 bootout,不碰 FLY-913。
2. 常驻路径收敛 W1×4(rafiki/ops/geoforge3d-cos/reflection)与 W1'(ws:60/flywheel-cos-lead);若部署时 ws:60 形态已漂出 3.3 前提 → 首跑 `--rebuild-views --target flywheel-flywheel-cos-lead --execute --handover`(scope #2 的「迁移」在今日现场的实义)。
3. `--verify-sidebar` 全绿后进入 §9 drill(「全绿」语义按 §14-4:针对性检查全过 + 全局输出为可解释的 INCONCLUSIVE(仅已知 manifest 缺口)或 exit 0)。

## 9. 验收标准(结果导向,全部机器判)

| # | 标准 | 判据 |
|---|---|---|
| 1 | 生产侧栏全且对 | `--verify-sidebar` exit 0(15/15 lead + 全部 runner title,含账本不变量)。**受 §14-4 验收门拆分约束**:codex-infra-bot manifest 缺口修复前,本条为挂起项;FLY-1596 自身按 §14-4 第一层验收 |
| 2 | 重启自愈 | 真机 drill:cmux app 重启、fleet/tmux 全量重启各一次,≤5 分钟回到 verify PASS,零人工 |
| 3 | 无半迁移 | drill 全程:每条 `view-invariant-mismatch` close 后 ≤3 个 additive tick 内同 title 重建成功;无 ready-gate defer 连刷;dismantle outcome 日志无表外状态 |
| 4 | 存量 5 个收敛 | 5 title verify PASS;逐 tick 刷屏消失且 grep 证明代码路径未删(抑制行带 `suppressed N repeats` 可区分) |
| 5 | 类未静音 | 注入手建 grouped 视图 → 首条 mismatch 日志 + 告警产出(只验产出) |
| 6 | 让位窗口 | `--rebuild-views --handover` 实跑:watcher yield → ops 完成(每 title 到可验证终态)→ watcher 复归 + RESYNC 实证;期间 `--once` 被拒 |

## 10. 回滚

- Fix 2(R4-4 收紧):回滚序 = `RESTORED_ADOPTION=0`(停新事务,闸照跑)→ 等既有在途走完非破坏 abort/终态收尾 → **验证 drain(严格解析器计数:`RESTORED_STATE` 零条有效 restoredv1 记录 ∧ 零合成收据)** → 才允许代码 revert。**禁止在 drain 前手删标记文件**(删标记 = 把合成收据交还普通消费者,正是 §3.1 封的洞)。Fix 3/5:不调用 `--rebuild-views` / `FLYWHEEL_CMUX_LOG_REPEAT_SECONDS=0`;episodes 文件可直接删。均无 schema。
- Fix 1:revert = 回到自毁机;回滚判据 = drill 数据表明新序收敛失败率高于旧序才考虑;账本/WAL/inventory 格式零改动。
- claim 残留:stale 两次观察回收 + `--handover` 超时自撤;最坏 `rm` claim 文件(与 qa-teardown 同语义)。

## 11. 风险

| 风险 | 处置 |
|---|---|
| 收编误伤 founder 行 | 三层闸 + 终局 guard 全证据复核 + 歧义一律 refuse;真值表逐条锁 |
| Fix 1 阶段化后的中间态 | 全部映射到 §2.2 具名可恢复态;SIGKILL 落点重放 |
| 收编与外部 tmux/cmux 变化竞态 | 终局 guard 在 lease 下重读全部证据 + 双端代次围栏(R1-1) |
| drill/存量清理的 founder 可见抖动 | 预算化限速 + 提前知会;一次性 |
| 告警链坏着(FLY-1577 家族) | 验收只验产出;`--verify-sidebar` + 报告文件为第一巡检面 |
| `--handover` 期间 watcher 停摆 | 与 QA teardown 同预算;超时 fail-closed 自撤;完成即复归 RESYNC |
| census/test-teardown 副本漏改 | §4.2 全清单 + contract 测试钉死 |

## 12. 明确不做

exploration §7 照抄为准:不碰 FLY-913;不整类静音;不做 FLY-1578 §17.2 基建补课(2.3 的 inventory 锁窄修除外——它是 W2 收敛的直接前置,已剥离到最小);不修告警投递链;三个 launchd job 失败不在本单;FLY-1570 回填 writer 不在本单。不引入第二套变异实现(ops = 编排器);不把 pin 或「带 index」用作保护语义。

## 12.5 前代分支裁决(Tadashi,2026-08-04,implement 开工前必读)

背景:origin 上存在前一代 runner(08-03 23:44 → 08-04 10:14,结论回撤前基线)的 `flywheel-FLY-1596` 分支,含其 design + implement 提交(`fix(cmux): harden keeper inventory authority`、`feat(cmux): rebuild interrupted migrations forward` 等),未合入 main,生产 watcher 未受其影响(本 plan 的全部取证基线 = main)。

Lead 裁决(逐字执行):

1. **旧分支保留不删**,已打存档 tag `archive/fly1596-gen1`(指向其 HEAD `2e621740`)留证;
2. **implement 基线 = 本分支(`flywheel-FLY-1596-design-r2`)+ 本 plan**;旧分支只作参考 —— 与 Fix 1/Fix 2 重叠处(inventory 锁、前向重建)由 implement 按**本 plan**判断是否择优吸收,**禁止整分支合并**(其设计基线已被本单取代:它不含 R1–R11 的收编独占/决策表/CAS/判官合同);
3. 本节即裁决的落档处;implement 若吸收旧分支任何片段,须在其 PR 描述里逐段注明来源与按新 plan 复核的结论。

## 13. Design review 记录

**终verdict:R11 APPROVED — ready to implement(Codex,xhigh,11 轮,前 10 轮 findings 全采纳零驳回)。** R11 附注:恢复决策表 + 其 Cartesian 生成器测试 = 实现期的可执行合同;任何谓词/owner 偏离都必须回改 plan 并聚焦复审,不许在 shell 控制流里隐式解决。

- R12(收官轮聚焦评审,CHANGES REQUESTED,2 项)全采纳:①§14-2 精化 —— argv 只选范围不是证据,target-local 权威(该 title 自身 plist/manifest 行)必须解析并纳入双复合快照,补五格行为矩阵(健康+无关缺失=0 带 caveat / 已加载 Lead 缺席=1 / 自身权威不可判=2 / 全局同缺口=2 / 快照间权威漂移=2),封「死 Lead 假 PASS absent」通路(§14-2);②验收门拆分 —— 环境缺口修复前全局正确输出 = 带名字非空 INCONCLUSIVE,不是回归也不是 product PASS;§8-3/§9-1 同义修订(§14-4)。
- R11(APPROVED):#6.5 边界修正确认;无阻塞项。
- R10(CHANGES REQUESTED,1 项)采纳:#6.5 谓词收窄(flag on ∧ ref 在场 ∧ 分支前置账本态原封),flag off 直落 #8/#14;readiness×flag×kind 全组合测试(§3.1)。
- R9(CHANGES REQUESTED,1 项)采纳:新增 #6.5 wait 行(latch/grace 未到 → 零变异零预算)+ readiness 轴 + grace-1/grace 边界 + 坏 epoch fail-closed(§3.1)。
- R8(Codex,xhigh,CHANGES REQUESTED,2 项)全采纳:①真值表 #11/#16 补「ref 在场」谓词消重叠(缺席 ref 永远归 GC,绝不 CAS —— 否则 W1' 会给缺席 ref 恢复出被 4620-4624 永久 preserve 的 prepared 僵尸)+ Cartesian 互斥/覆盖生成器测试 + committed+absent × drift/flag × W1/W1p 四例(§3.1);②§3.1 两处残留 `restored:` 记号改「有效 restoredv1 记录」+ drain 成功 = `parser rc=0 ∧ valid_count=0`(只含畸形行 = drain 失败)+ 对应测试(§3.1)。
- R7(Codex,xhigh,CHANGES REQUESTED,2 项)全采纳:①21 行恢复决策表逐 cell 落进 §3.1(优先序短路、每 cell 单 owner 单动作、表驱动测试);②行文法定界安全化(8 列、orig/title base64、解码复验)+ 全文记号统一 + 严格解析器 drain/判官判定(§3.1)。
- R6(Codex,xhigh,CHANGES REQUESTED,3 项)全采纳:①跨代次回滚禁用 `_ledger_upsert`(其按 ref 删行无代次谓词,3857-3863,会误删被复用 ref 的当前代次收据)→ 新窄 CAS 原语 `_restored_ledger_cas`(只动 `(old-generation, ref)` 预期态行,其它代次字节保留;幂等终局/quarantine 语义)+ ref 复用变体测试(§3.1);②标记行升级为版本化 schema `restoredv1|kind|generation|ref|title-b64|原收据元组|fingerprint|epoch` + 标记先于账本变异的写序合同 + kind×账本态恢复真值表 + 两条铁律测试(W1 永不恢复 prepared / W1' 永不删到 none)(§3.1);③判官第七条改「任何有效标记(当前或陈旧代次)= FAIL 直到 settlement 清除」+ 全文六→七条终态规则改齐 + 陈旧标记陷阱(§5/§7/§1/§4.3)。
- R5(Codex,xhigh,CHANGES REQUESTED,3 项)全采纳:①`RESTORED_STATE` 纳入判官复合快照 + 第七条终态规则(有效当前代次标记 = FAIL;畸形 = exit 2;两读间变化 = exit 2)+ restored 三陷阱(§5/§7);②跨代次 settlement:旧代次标记只回滚旧合成账本迁移、绝不按 ref 字符串触碰当前代次对象、四个重启落点测试保证 drain 可终止(§3.1);③§7 漂移措辞相位化、§3.6 flag 语义与 §3.1 对齐(绝不 recovery-into-close)(§3.6/§7)。
- R4(Codex,xhigh,CHANGES REQUESTED,4 项)全采纳:①`restored:` 标记改独立 `RESTORED_STATE` 文件(stock reaper 整文件重写会抹共享文件里的未知前缀行)+ 交叉/崩溃完整性测试(§3.1);②pass 序显式拆分 `prepare_linked_view_state`(WAL 恢复/阻断集先行 → 严格快照 → restored 恢复+W1-dead → 带闸 `reconcile_prepared_ledger` → 各对账)+ 三方共存测试(§3.1-5);③能力标记绑定 `generation|ref|title|fingerprint` 四元组单次调用作用域、rc2 不可绕;孤儿标记终态清理 + 账本移除后标记删除前崩溃测试;flag=0 确定性 = 在途只走非破坏 abort(§3.1);④§10 回滚序改为 drain-then-revert 且禁 drain 前手删标记、陷阱计数 5+5、§3.1 漂移措辞相位化(§10/§7/§3.1)。
- R3(Codex,xhigh,CHANGES REQUESTED,6 项)全采纳:①在途独占升格为 tri-state 权威闸 `restored_inflight_state`(rc2 fail-closed)接入枚举过的全消费者图(close 咽喉能力标记 / prepared 重驱动与 promotion / title 收编 / prepared-loser / dismantle 预检),`recover_restored_transactions` 前移到一切账本消费者之前含 `prepare_linked_view_state` 链(§3.1);②相位感知非破坏 abort:合成收据先原子回滚(W1 删行、W1' 恢复 prepared)再清标记,回滚不可证 → quarantine + 告警;flag=0 只停新事务、闸与 drain 继续(§3.1/3.6);③recovery + W1-dead 挂点 anchor-independent(空/非空分支之前,共享预算)(§3);④ops recovery 以不可变目标集为界、目标外在途只报告不变异;lease 到手后全量重算 preflight(§4.3);⑤判官复合快照纳入 canonical roster + subject 集,无序证据 canonical 化,加 roster 装卸陷阱(§5);⑥outcome 表保持四值,restored-inflight 走 `DISMANTLE_REASON`(§2.2)。
- R2(Codex,xhigh,CHANGES REQUESTED,6 项)全采纳:①`restored:` fingerprint 升格为在途事务标记 + `recover_restored_transactions()` 排在 `reconcile_existing_workspaces` 之前 + `dismantle_view_display` 预检拒碰在途收据 + 分阶段收据谓词 + mint/promotion 后 SIGKILL 独占测试(§3.1);②严格类型化 tmux 快照助手(fail-closed rc=2)供 C1 与 W1-dead 两个不同谓词,W1-dead 收窄到 roster lead title(§3.2/3.4);③崩溃恢复改认既有 committed-GC(4679-4701)为 owner,不新增 GC(§3.2);④exact-ref 语义 = 仅授权指定行 + 终态不可达上前拒绝 + ops 专属 create-TTL 旁路 + readback 为唯一成功判据(§4.1/4.3);⑤判官改双份复合可变证据集等值 + 同代次四陷阱测试(§5);⑥CLI 两阶段边界校验(词法先于 IPC,语义只读先于副作用)(§4.1)。
- R1(Codex,xhigh,CHANGES REQUESTED,9 项)全采纳:①W1/W1' 终局 guard + durable fingerprint + 四边界崩溃恢复(§3.1/3.2/3.3);②ops 事务开到可验证终态 + 共享低层原语(§4.3);③FLY-1482 消费者全清单(census 动词/test-teardown 文法/自有-claim 例外/互斥)(§4.2);④dismantle 结构化 outcome 取代「零效果」承诺(§2.2);⑤keeper inventory 锁窄修入 Fix 1(§2.3);⑥预算化限速 + 15-title 时序测试(§3.5);⑦判官第六不变量 + 双端代次围栏 + exit 2 语义(§5);⑧`--target T[=ref]` 文法 + argv 全量校验先于副作用(§4.1);⑨Fix 5 有界化 + 独立 PR(§6)。

## 14. 收官轮裁决(Tadashi,2026-08-05 — 对 Fix 4 合同的修订;经 R12 聚焦评审细化)

背景:implement head `34fa370d` 的 QA 复测第 2 轮(QA-RETEST-FLY-1596.md)确认上轮阻断项(keeper inventory generation token)已修复并通过真机、对照、回归、静态审计、mutation test 五重验证;但发现判官在真生产上因 `flywheel-codex-infra-bot-lead` manifest 缺失(本单 §12 声明不做的环境缺口)而零字节静默 exit 2。Lead 裁决(逐字执行,细化 §5 —— 不推翻其 fail-closed 方向):

1. **可用性(阻断)**:`--verify-sidebar` exit 2 时必须打印 `INCONCLUSIVE` 行 + 机器可读原因(含缺失的具体 manifest 名,如 `roster-authority-unavailable: missing manifest flywheel-codex-infra-bot-lead`);`--json` 输出结构化 inconclusive 对象,非零字节,含稳定的 `reasons`/`caveats` 字段;**每一条 exit 2 路径都必须到达渲染器**(不许任何 early-return 绕过输出)。仪器必须自报定义域与失败原因 —— 零字节静默违反仪表铁律。
2. **范围收窄(R12-1 精化:argv 只选范围,不是证据)**:全局(无 `--target`)完整性判定的 roster fail-closed **维持不变**(不知全 roster 不得宣称侧栏完整)。显式 `--target <title>` 不被**无关** Lead 的 manifest 拖死 —— 但 argv 本身**不构成** subject-membership 或 expected-liveness 证据:判官必须解析**该 title 自身的 target-local 权威**(其对应的已加载 plist/manifest 行),并把它纳入前后两份复合快照(§5 围栏);只有无关 Lead 的 manifest 不再是硬依赖。roster 现在的双重职责(枚举 subjects + 「已加载 Lead 缺席 = FAIL roster-lead-absent」的 expected-liveness 证据)在 target 模式下由 target-local 权威承接,绝不因跳过 roster 而丢失。既有可独立证明的 runner-absence 语义保持不变。行为矩阵(逐格测试):

   | 场景 | 结果 |
   |---|---|
   | 健康 target + 无关 manifest 缺失 | exit 0 + roster 缺失 caveat(文本与 JSON 双模) |
   | target 是已加载 Lead 且侧栏缺席 + 无关 manifest 缺失 | exit 1(FAIL roster-lead-absent) |
   | target 自身权威不可判 | exit 2(绝不 PASS absent) |
   | 全局模式 + 同一缺口 | exit 2(带名字的 INCONCLUSIVE 自报) |
   | 两快照间 target-local 权威漂移 | exit 2 |

3. **不回退约束**:上述改动不得回退已验证的 sha256 generation token 修复(QA 将复跑 RETEST §1 全套 + §4 突变体 + §5 全量单测)。
4. **验收门拆分(R12-2)**:在 `flywheel-codex-infra-bot-lead` manifest 缺口(§12 声明不做,Lead 另行 ops 处理)修复之前,生产**全局** `--verify-sidebar` 的正确输出就是带名字的非空 INCONCLUSIVE(exit 2)—— 这不是实现回归,也**绝不许**当成 product PASS;targeted PASS 不得替代全局完整性。因此验收拆两层:
   - **FLY-1596 代码/QA 验收(当前环境)** = 带名字的非空 INCONCLUSIVE 文本/JSON + 针对性 `--target` 检查全过(§14-2 矩阵);
   - **系统级「生产侧栏全且对」**(§9-1 的全局 exit 0)= 挂起项,待环境缺口修复后复跑全局 exit 0 收尾。
   §8-3 的「`--verify-sidebar` 全绿后进入 §9 drill」按此同义修订:全绿 = 针对性检查全过 + 全局输出为**可解释的** INCONCLUSIVE(仅该已知缺口)或 exit 0。

**v4 情报归档(graph owner 终版裁决,2026-08-05):gen-3 平行 v4 设计(repair-in-place)已作废 —— 机器不建;其现场情报(08-05 晨间取证:三谜铁证答案 + 分支双代警示)按「现场情报」保留于 git 历史(flywheel-FLY-1596 分支 commit 04264ad2 的 engineering/doc/FLY-1596-cmux-ops-rebuild-path/,工作树已删)。implement 基底 = 本 plan,任务仅 §14 两小项。**
