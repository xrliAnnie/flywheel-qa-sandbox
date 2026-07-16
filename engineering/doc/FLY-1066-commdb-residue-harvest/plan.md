# FLY-1066 Bridge 侧残留收割 — 实施计划

Issue: FLY-1066 (https://linear.app/geoforge3d/issue/FLY-1066/infra-bridge-侧残留收割-commdb-孤儿注册清理-statestorecommdb-终态同步-scope-free-清理入口)
日期: 2026-07-16
基于: exploration.md、research.md(锚点与取证均在 research,本文不重复;Codex design review R1 8 条 + R2 4 条已全采纳)

## 0. 目标一句话

给 Bridge 加一个 scope-free 的残留收割器:收掉四面僵尸(①CommDB 孤儿注册 ②StateStore 终态未同步到 CommDB ③StateStore 幽灵 session ④双无主 detection_escalations),入口 = boot sweep + 心跳 maintenance 搭车 + scheduled-run 409 定点触发,kill-switch 一关全停、byte-compat。

## 1. 对 FLY-817 review BLOCKER-1 决定的修订(给 Codex reviewer 显式看)

**原决定**(FLY-817 Codex design R1 BLOCKER-1,`commdb-fsm-reconcile.ts:124-129` 现行代码):CommDB running 行若 StateStore ∈ CRASH_PRESERVE(failed/blocked),**只看 FSM、绝不 probe、绝不删**——理由是 retry 的 `closeRunner(forcePreserved: true)` 要读 CommDB tmux 目标去拆 preserved 窗口,删行会 strand 该窗口;且 crash 现场 scrollback 要留给人看。

**本设计的修订**:failed/blocked 行在 `probeTmuxWindowLiveness === "dead"` 时允许 finalize。理由:probe=dead 意味着 preserved 窗口与 scrollback **已经不存在**(tmux 无持久化),teardown target 与取证标的双双灭失;删行后 retry 路径 `getTmuxTargetFromCommDb` 返回空 → closeRunner 幂等 already-gone,resident Codex phase 的专用 shutdown 判据同样把 target gone/absent 视为可直接清理(Codex R1 已实核两条路径)。对 **probe=alive/indeterminate 的 failed/blocked 行,原决定原样保留**(FLY-116 CRASH_PRESERVE 政策零变化)。

生产实证:该形态积压 ~13 行(geoforge3d 5 + flywheel 8,research §3.2),全部 probe=dead。Tadashi 已在 brainstorm gate 显式把关放行本修订(2026-07-16);Codex design review R1 复核「修订本身成立」。

## 2. 硬约束(验收原文,gate 修正③)

> 收割信号 = terminal/CommDB 存在性,绝不是 FSM 终不终态;awaiting_review + terminal 活 = 合法等 founder,结构性不可触。

推论(全部落测试):删除/终态化只认 probe==="dead";alive/indeterminate 一律 keep;design_done/parked 保活行不可触;面③ FSM 转移失败即 keep+告警,绝不 forceStatus;`started_at` 缺失/非法/未来时间 → ageMs 解析 fail-closed = keep(R1 #6);心跳搭车不得阻塞既有 tick 管线。

## 3. 交付物与任务拆分(TDD,每个 M 先 RED 后 GREEN;每个 M 单独 commit 且全绿)

### M1 — 面①②:扩展 `commdb-fsm-reconcile.ts`(核心收割分支)

改 `reconcileCommDbRunningAgainstFsm`,在既有分支链的两个 keep 点上挂新出口:

```
for s of CommDB running rows:
  fsm = fsmStatusOf(s.execution_id)
  if fsm ∈ CRASH_PRESERVE:
      if !opts.harvest → keptPreserve(现状,byte-compat 路径)
      else: probe(s.tmux_window) === "dead" ? finalize : keptPreserve++        // 面②
  if !fsm:
      if !opts.harvest → keptNonTerminal(现状)
      else if parseAge(s.started_at) 有效 且 > orphanMinAgeMs(24h) AND probe === "dead":
          finalize                                                             // 面①
      else keep(含 started_at 缺失/非法/未来 → 一律 keep,fail-closed)
  … 其余分支逐字节不变
```

- `opts.harvest?: { orphanMinAgeMs: number; nowMs: () => number }`——不传 = 现状;plugin.ts 按 flag 决定传不传。
- **result shape byte-compat(R1 #5)**:不改既有六字段结果对象;harvest 计数放进**仅当 harvest 开启才出现**的可选嵌套对象(如 `result.harvest = { orphanHarvested, preserveHarvested, keptOrphanCandidate, keptPreserveAlive }`)。off-sentinel 用 `Object.keys(result)` 深比较断言与现状逐字节一致。
- 年龄解析:SQLite UTC 文本(`parseSqliteUtcMs` 语义,stale-blocker-guard.ts:57 同款);NaN/未来时间 → keep。
- probe 去重:同一行只 probe 一次,新分支复用同一次结果。
- **测试**(既有 `commdb-fsm-reconcile.test.ts` 扩展):面①正例(无 FSM row+老+dead → 删,gate 一并 retire)/年龄不足 keep/probe alive、indeterminate keep/started_at 缺失、非法、未来 keep(×3 负向);面②正例(failed+dead 删;blocked+dead 删)/failed+alive keep(FLY-116 哨兵)/failed+indeterminate keep;off-sentinel(不传 harvest → Object.keys + deep equality 与现状一致);**突变对照**:注释掉 age guard/probe guard/时间戳 fail-closed 后对应负向测试必须转红。

### M2 — 面③:新模块 `bridge/statestore-ghost-reconcile.ts`(fail-closed reapOneGhost,对齐 crash-reaper 真实序列,R1 #1)

`applyTransition` 只做 FSM 校验 + StateStore 持久化 + audit directive + `onTransition`(生产 hook 仅 display refresh)——**不是**完整 teardown;archive/QA-loss/session event 必须显式做(crash-reaper.ts:316-389 的真实序列)。故:

```
reconcileStateStoreGhosts(projectName, deps):
  rows = StateStore 非终态行 where project_name=projectName
         (status ∈ {pending, running, awaiting_review, approved_to_ship, design_done};
          reconnecting 等不在 WORKFLOW_TRANSITIONS 边表内的中间态,implement 时实核后再定入集)
  for row: reapOneGhost(row)

reapOneGhost(row):                                  // 全程持 crash-reaper 同款 per-issue lifecycle mutex
  1. parseAge(row.started_at) 无效或 <= ghostMinAgeMs(30min) → keep
  2. CommDB.getSession(row.execution_id) 存在 → keep     // tmux 目标权威仍在,归面①②/crash-reaper 域
  3. !row.tmux_session → keep + 计数(无可探目标,不猜)
  4. probe(row.tmux_session) !== "dead" → keep            // session 级:整个 session 消失才算死亡证明
  5. 【async 间隙后重读】store.getSession + CommDB absence 双重新读,任一变化 → keep(防 probe 等待期状态漂移)
  6. finalizeCommDbSession(execId, project) —— 先清 CommDB lifecycle residue(runner_phase_wakes/
     shutdown_controls;sessions 行本形态不存在,幂等)。失败 → keep + warn,不 transition
     (fail-closed:行留在候选集,下轮重试;绝不先 transition 后 finalize——那会让失败行永久退出候选集)
  7. applyTransition(store, row, "terminated", TransitionContext{ executionId, issueId,
     projectName, trigger: "residue_harvest" })          // 真实字段;无 actor/reason 字段
     失败 → keep + warn(绝不 forceStatus)
  8. 成功后显式补齐 crash-reaper 同款侧效:chat_thread_role==="qa" 时调 FLY-1050 qa-loss hook
     (onQaPhaseTerminated 同型回调,由 plugin.ts 闭包注入)、terminated archive =
     archiveIssueThreadIfNoOtherActive(..., { allowStatuses: ["terminated"] })——crash-reaper 的
     生产接线原样(plugin.ts:5064-5074;maybeArchiveThreadOnClose 只允许 completed、排除
     terminated,勿用)、session event 记录
```

- 30min 护栏理由(R1 #6 修正后):CommDB 预注册是 best-effort(preRegisterCommDb 失败被吞)且 Runner 自注册有延迟 → 年轻 StateStore 行短暂无 CommDB 行属正常;窗口秒~分钟计,30min >> 之;CommDB-missing + probe-dead 双证据故短于面①的 24h。
- 三段式 qa 幽灵的 respawn 由 FLY-1050 既有守卫链自决(F8 已证防御正确),收割器只触发 hook 不新增判据。
- **测试**(新文件):幽灵正例(awaiting_review+CommDB 无 row+session dead+31min → 步骤 6→7→8 全序列断言:finalize 先于 transition、qa-loss hook 仅 qa 行触发、archive/event 调用);**production-wiring 哨兵**:terminated ghost 真进 plugin.ts 的 archiveIssueThreadIfNoOtherActive allowStatuses=["terminated"] closure(不许只测无约束 spy 被调用);age 内 keep;started_at 缺失/非法/未来 keep(×3 负例,逐项列出);CommDB row 在 keep;session alive keep(**含 awaiting_review+alive = 合法等 founder 哨兵,§2 原文进断言消息**);design_done+CommDB row 在 keep(生产实存形态);重读漂移 keep;finalize 失败 → 不 transition(fail-closed 哨兵);applyTransition 拒绝 → keep 不 force;突变对照(拆 CommDB-missing guard / 拆 finalize-先行顺序 → 测试红)。

### M3 — 面④:双无主 escalation 置结(全局 presence index,每 pass 一次,R1 #2)

`detection_escalations` 行**没有 project_name 列**(target_key/issue_id/owner_lead_id),且 target session 双无主时已无从反查 project → 面④**不进 per-project 循环**,每个全量 pass 只跑一次:

```
resolveOrphanEscalations(deps):
  1. presence index:遍历全部 configured projects 的 CommDB,收集 execution_id 全集;
     任一 project CommDB 打开/读取失败 → 本轮整体 abort(indeterminate ≠ absent,keep 全部)
  2. rows = store.getDetectionEscalationsForReconcile()(既有契约 status != 'RESOLVED',
     即 NEW/LEAD_NOTIFIED/ACKED/ESCALATED/CLEARING 全含)
     只处理 targetKey 为 execId 形态的行(排除 <project>:<leadId> lead 状态键)
  3. 初筛:target 在 StateStore sessions 查无 AND 不在 presence index
  4. 【每候选 UPDATE 前重验,R2 #2 TOCTOU】同步重读 StateStore + 对全部 configured-project
     CommDB 再查一次该 target;任一 presence 或 read error → keep
     (同 ID replay 会先写 CommDB 预注册、StateStore 行随后才落——初始 index 只是初筛,
      不能证明 RESOLVE 时刻仍双无主)
  5. 双验仍 absent → UPDATE status='RESOLVED', resolved_via='residue_harvest';否则不动
```

- **ACKED 纳入**(R1 #2 问):既有 recovery 清除逻辑本就处理 ACKED(机器证明 clear 不豁免 ACKED);双无主是比 recovery 更强的灭失证明,豁免 ACKED 没有一致性理由。复用 `getDetectionEscalationsForReconcile()` 的 status != RESOLVED 契约即天然含 ACKED。
- **复活语义现在就定契约(Codex R2 #1)**:`detection_escalations` 主键 = (target_key, kind, episode_fingerprint) 且 upsert 是 INSERT OR IGNORE → 同 tuple **不可能建新行**;现行复活条件只认 `resolved_via === 'recovery'`(StateStore.ts:9062-9084)。同 ID replay/re-drive 真实存在(run-dispatcher.ts:487-570)→ 若新 token 不进复活条件,harvester 清过的 fingerprint 将永久静音。**契约:`'residue_harvest'` 与 `'recovery'` 同级 = machine-proven clear,复活 predicate 扩为两者**;`DetectionEscalationRow.resolved_via` 类型加新 token。测试:更晚的 firstDetectedAtMs 把同一行复活为 NEW 并重置 notify/ack/page/clearing/attempts;`resolved_via='lead'` 仍不复活。
- **测试**(StateStore 测试扩展):双无主(含 ACKED 行)→ RESOLVED + resolved_via 断言;target 在 StateStore → 不动;target 只在任一 project CommDB → 不动;lead 形态 targetKey → 不动;RESOLVED 行 → 不动;任一 CommDB 打开失败 → 全部不动(fail-closed 哨兵 + 突变对照);**可注入 race test(R2 #2):初始 index 建完后、resolve 前向任一 CommDB 注册同 exec → 断言不 RESOLVE**;复活契约:RESOLVED('residue_harvest') 行遇更晚 firstDetectedAtMs → 复活 NEW + 全量重置;'lead' 不复活。

### M4 — 入口布线 + flag 注册(plugin.ts + HeartbeatService maintenance seam + stale-blocker-guard;R1 #3/#4/#7)

1. **flag 注册与首个生产读点同 commit**(R1 #7):`FLYWHEEL_COMMDB_RESIDUE_HARVEST` 注册进 `packages/config/src/feature-flags/registry.ts`(default on;`=0` 关 M1 harvest opts + M2 + M3 + 全部入口含定点插点)。feature-flags-drift 双向 guard 要求注册与读点不可分离。
2. **共用核心**:`harvestResidue(projects)` = per-project(M1 harvest + M2)+ 全局一次(M3);fire-and-forget、per-project try/catch、**三入口共享**的进程内单飞行守卫(上一轮未完成即跳过本轮)。
3. **boot**:folded 进 plugin.ts:5547 既有循环——flag on 时以 harvest opts 调 M1(替代裸 817 调用)+ M2,循环后跑一次 M3;flag off 时逐字节走现状代码路径。
4. **心跳搭车(R1 #4)**:复用 HeartbeatService **既有** `onMaintenanceTick` seam(HeartbeatService.ts:467-515;生产注入在 plugin.ts:5204-5273)——不新增构造器参数/不加第二套 counter。cadence N 由真实 `config.stuckCheckIntervalMs` 换算 ~1h;**分支独立于 `worktreeAutocleanEnabled()` 的 early return**(否则 FLYWHEEL_WORKTREE_AUTOCLEAN=0 会成为未声明的 residue kill-switch)。
5. **定点触发(R1 #3)**:插点在 **runs-route 409 分支 / guard 顶部,早于 FLY-742 的 `enabled` 检查与 local classify**——running ghost、fresh-parked ghost(31min~120min)都必须能到达;仅由 `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 控制,`FLYWHEEL_CRON_STALE_GUARD=0` 不得关闭它。`ghostReconcileOne(blocker)` 走 M2 reapOneGhost 单行判据;true(已 terminalize)→ 放行 run-start;false → 逐字节执行原 FLY-742 路径(含其自身 flag 检查)。
- **测试**:boot 循环 flag on/off 分叉(off = 反向哨兵,新函数零调用);maintenance N tick(N-1 不触发、N 触发、单飞行跳过、worktree-autoclean=0 时仍触发);定点矩阵——幽灵 blocker(awaiting_review 31min dead)→ proceed;**fresh awaiting_review(<30min)→ 原 409**;**running ghost → 判据满足则 proceed**;**CRON_STALE_GUARD=0 + 幽灵 → 仍 proceed**;非幽灵 → 原 FLY-742 调用序列逐字节不变;residue flag=0 → 插点零调用。

### M5 — flag 组合矩阵哨兵 + 全套回归

- 矩阵哨兵:817=0(总闸,面①②不跑;M2/M3/入口不受 817 辖制)× harvest=0/1;worktree-autoclean × residue 独立性;三处反向哨兵(reconcile 输出 Object.keys 级、maintenance 零新调用、guard 与 FLY-742 现状一致)。
- 全仓 lint + teamlead/flywheel-comm/config 包测试套;两个绑 127.0.0.1 的套件 host 直跑(research §7)。

### M6 — 真机验收(deploy 即验收,配合下一次 Bridge 重启窗)

1. **重启前置门(R1 #8,必做非可选)**:在 7 份生产快照上运行与生产**完全同一**候选分类器(same-predicate preflight,log-only),输出每 exec 的 face/age/FSM/probe/action+reason 清单;**独立 QA 核对 candidate/keep 集**(重点:joycon-typeless/growth/sub 未逐行判读过的行),核对通过才允许带 default-on 重启。
2. 重启后:boot 日志出现收割计数;查生产库——`d2f31930`/`e4d3b29d`/`e90f3962` 三样本消失(Peter 在 GeoForge3D 侧可复核,issue 验收原文),geoforge3d 另 3 条 + flywheel ~8 条同型消失;flywheel 的 design_done×2、running×2、awaiting_review×1 合法行**原样在场**(阳性对照:收割确实跑过且没伤及无辜)。
3. 面③④:若生产当时无实例,以隔离 fixture 实证(M2/M3 测试已覆盖;不人造生产幽灵)。
4. 独立 QA(FLY-579 auto-QA 或 Lead 派):按本节清单对生产库独立复查,不信实现者自报。

## 4. 验收清单(汇总)

- [ ] M6.1 same-predicate preflight 清单经独立 QA 核对(重启前置门)。
- [ ] Peter 3 样本收净(issue 原文验收),附带 ~11 条同型收净,合法行零误伤(阳性对照在场)。
- [ ] §2 硬约束原文对应的哨兵测试全绿:awaiting_review+alive 不可触;design_done 不可触;alive/indeterminate 一律 keep;删除只认 dead 证明;时间戳缺失/非法/未来 → keep。
- [ ] 面③ fail-closed 序列:finalize 先于 transition;finalize 失败不 transition;FSM 拒绝不 force;qa-loss/archive/event 侧效显式断言。
- [ ] 面④:双无主(含 ACKED)→ RESOLVED('residue_harvest');任一 CommDB 不可读 → 全 keep;lead 键不动;UPDATE 前逐候选双重新读(race test);复活 predicate 扩至 residue_harvest(更晚 firstDetectedAtMs 复活 NEW,'lead' 不复活)。
- [ ] 定点矩阵:幽灵 proceed / fresh keep / running ghost proceed / CRON_STALE_GUARD=0 不影响 / 非幽灵走原路径。
- [ ] `FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 三处反向哨兵(Object.keys 级 byte-compat)。
- [ ] 负向断言全部带突变对照(拆守卫 → 测试红),不收 vacuous green。
- [ ] FLY-817 修订立节(本文 §1)在 PR 描述中链给 Codex reviewer。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| tmux server 短暂 down 时全 probe 报 dead(`no server running` 属可证死亡)→ 一轮收走「重启前」的行 | tmux 无持久化:server down = 所有窗口真实灭失,runner 进程随之死——语义与 FLY-638/817 既行一致,不是新风险面 |
| 面③把「Bridge 观察不到但仍在干活」的 runner 终态化 | 判据要求 CommDB row 缺失(runner 自注册会写回 row)+ session 级死亡证明 + 30min 龄 + async 后双重新读;三者同真且 runner 还活着的形态不存在(runner 活 ⇒ 其 tmux session 在) |
| 与 FLY-742 语义冲突(PR open 的 awaiting_review 被收) | 定点插点只在面③判据全真(probe=dead)时 proceed;probe=alive(runner 可唤醒)永远走 FLY-742 原路径;§2 哨兵固化 |
| mid-dispatch 面①误收:CommDB 预注册**先于** StateStore 行落库(R1 #6 实核的真实顺序)→「CommDB running+无 StateStore+pending dead」是正常瞬态 | **24h 年龄护栏是实际安全边界**(非纵深备份);时间戳解析 fail-closed;research §6 已按真实顺序改写 |
| 收割轮 probe 开销(每行一次 tmux 调用,~5s 超时) | boot fire-and-forget 先例;maintenance ~1h 一轮 + 三入口共享单飞行;定点 = 单行 |
| flag 语义组合 | M5 矩阵哨兵:817=0 为面①②总闸(文档明示);M2/M3/入口仅由 harvest flag 控;worktree-autoclean 独立 |
| M3 presence index TOCTOU(index 构建与 RESOLVE 之间的同 ID replay——CommDB 预注册**先于** StateStore 行,index 不能证明 RESOLVE 时刻仍双无主) | index 仅作初筛;每候选 UPDATE 前同步重读 StateStore + 全 CommDB 再查,任一 presence/read error → keep;可注入 race test 固化;且置结只影响告警去重,不影响 session 生命周期 |

## 6. Non-goals(原样引 exploration §5)

不改 FLY-742 PR-证据路径;不动 CommDB blocked 行(FLY-1279 语义);不修泄漏源头;不加手动 HTTP 入口;FLY-638/817 关闭态行为不动。

## 7. 实施顺序与提交纪律

M1 → M2 → M3 → M4(含 flag 注册)→ M5 每步 RED→GREEN→REFACTOR,单独 commit 且该 commit 全绿(feat/fix/test 前缀);M6 验收随 ship 窗。全程 progress.md 记 cursor。PR 描述:决策级摘要 + §1 修订节 + 验收清单勾选,链 FLY-1066/FLY-817/FLY-742/FLY-1050。
