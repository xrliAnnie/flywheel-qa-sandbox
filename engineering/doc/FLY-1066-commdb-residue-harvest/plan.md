# FLY-1066 Bridge 侧残留治理(双层)— 实施计划

Issue: FLY-1066 (https://linear.app/geoforge3d/issue/FLY-1066/infra-bridge-侧残留收割-commdb-孤儿注册清理-statestorecommdb-终态同步-scope-free-清理入口)
日期: 2026-07-16
基于: exploration.md(重写版,双层)、research.md(§1-§8 = ②层事实;§9 = ①层审计)

## 0. 目标一句话

双层治理 Bridge 残留:**① 根因层** = FSM 转移咽喉实时把 CommDB registration 终态如实化
(failed/blocked 泄漏源在产生当刻闭合,治本);**② 兜底层** = 已实现的四面收割器(boot/心跳/定点,
收 crash 死法的残留,fsck 定位)+ 两处增量。只做②被 Annie 否决;分工 = 能拦的走①、拦不住的走②。

## 1. 对 FLY-817 review BLOCKER-1 决定的修订(给 Codex reviewer 显式看;②层沿用 + B1 扩展引用)

**原决定**(FLY-817,`commdb-fsm-reconcile.ts` 现行注释):CommDB running 行若 StateStore ∈
CRASH_PRESERVE(failed/blocked),只看 FSM、绝不 probe、绝不删——retry 的
`closeRunner(forcePreserved)` 要读 CommDB tmux 目标,删行会 strand preserved 窗口。

**修订**(第一轮已获 Tadashi gate 放行 + Codex design R1 复核,已实现、已 QA):probe==="dead" 时允许
finalize——窗口与 scrollback 已灭失,preserve 标的不存在;删行后 `getTmuxTargetFromCommDb` 返回空 →
closeRunner 幂等。**probe=alive/indeterminate 的 failed/blocked 行原决定原样保留**(FLY-116 零变化)。

**mark 与 delete 的时机分工**(重开后新增,消解 Tadashi 两次答复的表面矛盾;呈他终裁):

| 时机 | 动作 | 依据 |
|---|---|---|
| ①转移当刻(窗口可能活) | mark:`updateSessionStatus(execId, failed/blocked)` | 非破坏;A3 答复(只 mark 不 delete)的适用域 |
| ②收割时(probe=dead 铁证) | delete:`finalizeSession` | BLOCKER-1 修订,双签已实现 |

## 2. 硬约束(验收原文)

> 收割信号 = terminal/CommDB 存在性,绝不是 FSM 终不终态;awaiting_review + terminal 活 = 合法等 founder,结构性不可触。

②层推论原样(删除/终态化只认 probe==="dead";alive/indeterminate keep;design_done/parked 不可触;
面③ FSM 拒绝即 keep 不 forceStatus;时间戳 fail-closed;搭车不阻塞 tick)。①层新增推论:
- hook 体 best-effort + try/catch,**永不破坏 transition**(FLY-907 同契约);
- mark 幂等(重复 UPDATE 无害),且**绝不 DELETE**(转移当刻无死亡证明);
- mark 不改 tmux_window / vendor / issue_id(只 status + ended_at)——retry teardown target 原样;
- CHECK 迁移只放宽约束,旧值全兼容,迁移幂等(schema sql 含 'failed' 即跳过,FLY-1279 同款)。

## 3. Part A — ①根因层(本轮新增工作;TDD,每 M 单独 commit 全绿)

### A1 — flywheel-comm:CommDB CHECK 加 'failed' + 原语扩容

- db.ts:按 FLY-1279 模式(db.ts:370-405 逐字仿写)整表原子重建 sessions,CHECK 扩为
  `('running','completed','timeout','blocked','failed')`;迁移判据 = schema sql 不含 `'failed'` 才跑。
- `updateSessionStatus` 签名扩 `'failed'`;`types.ts:67` Session.status union 同步。
- **测试**(flywheel-comm db.test 扩展):旧库(不含 'failed' 的 CHECK)重建后数据逐行保全 + 新值可写;
  已迁移库幂等跳过;'failed' 写入 + ended_at 断言;读方兼容抽查(listSessions/getSession 返回新值)。

### A2 — teamlead:转移咽喉 CommDB 终态同步 hook(L-A,①层核心)

- 新模块 `bridge/terminal-commdb-sync.ts`:
  ```
  syncTerminalStatusToCommDb(executionId, targetStatus, projectName):
    targetStatus ∉ {failed, blocked} → no-op
    resolveCommDbPath(projectName) 失败 → warn + no-op
    CommDB.updateSessionStatus(executionId, targetStatus)   // row 不存在 = UPDATE 0 行,无害
    全程 try/catch,任何失败 warn 不 throw
  ```
- 接线:plugin.ts composition root 的 **两个** ApplyTransitionOpts 实例(FLY-907 的共享实例 +
  stale-blocker-guard 自有实例,research §9.1)onTransition 内追加调用;flag
  `FLYWHEEL_TERMINAL_COMMDB_SYNC`(default on,注册进 feature-flags registry,注册与首个读点同 commit)
  =0 时 onTransition 与现状逐字节一致。
- **forceStatus 旁路**:审计生产调用方——若存在以 failed/blocked 为目标的 forceStatus 调用点,同点补
  sync;若无,加守卫测试 pin(grep 级断言 + 单测:forceStatus('failed') 不期望 CommDB 同步的现状固化,
  防未来悄悄依赖)。
- **测试**:failed 转移(reapOrphans 路径 harness)→ CommDB row 变 'failed'+ended_at;blocked 转移
  (event-route `--route blocked` 消费路径)→ 'blocked';非 CRASH_PRESERVE 转移零 CommDB 写(负向+
  突变对照);CommDB 打不开/row 缺失 → transition 照常成功(fail-open 哨兵);flag=0 反向哨兵
  (onTransition 行为 Object 级与现状一致);**retry 哨兵**:marked row 上 closeRunner(forcePreserved)
  teardown target 查找照常(tmux-lookup 按 execId,status 无关——research §2.2 已核,测试 pin 住)。

### A3 — spawn 失败 pending row 定点清理(L-B,条件性增强)

- implement 时实核 auto-QA spawn 失败路径(auto-qa-effects → dispatcher/runs-route 的失败分支):
  若能拿到「blueprint 从未启动」的确定证据,在该分支调 `unregisterPendingSession`(FLY-80 对齐);
  拿不到就跳过本项(A2 已把该形态标 failed 隐藏)——**不猜**。
- **测试**(若做):auto-QA spawn 失败 → `:pending` row 被删;已自注册(非 pending)row 不受影响。

### A4 — owner 矩阵 pin(L-C,审计交付)

- research §9.3 矩阵中标 ✅ 的关键格子加最小哨兵测试(已有测试则引用不重写):closeRunner 调
  finalizeCommDbSession、crash-reaper 调 finalize、lifecycle-closeout 调 finalize——各 1 条已存在则记
  文档指针,缺则补 1 条 spy 级断言。发现真 gap:属本票三残留物的修在本票,机制级缺陷另开 issue 并在
  PR 描述列出。FLY-603 autoclean 调查、FLY-1148 进程泄漏 = 独立 open item,不并入。

## 4. Part B — ②兜底层(已实现,引用 + 两处增量)

**as-built**(本分支 commit `01201baf1`…`5cec7eeb2`,原 PR #616,独立 QA PASS = qa-report.md):
M1 面①②收割分支(commdb-fsm-reconcile.ts harvest opts:孤儿 = 无 FSM row + 24h + probe dead → finalize;
面② = CRASH_PRESERVE + probe dead → finalize)/ M2 面③ statestore-ghost-reconcile.ts(30min + CommDB
absent + session 级 probe dead + 双重新读 → finalize 先行 → terminated + 显式侧效)/ M3 面④
orphan-escalation-reconcile.ts(全局 presence index + TOCTOU 双验 + 复活 predicate 扩
'residue_harvest')/ M4 三入口(boot 循环 + HeartbeatService onMaintenanceTick 搭车 ~1h + runs-route
409 定点,`FLYWHEEL_COMMDB_RESIDUE_HARVEST` 总闸)/ M5 flag 矩阵哨兵。**本轮不重做、不重构**;
计划细节以 git 历史 `6a79e4918` 的 plan.md 为准。

### B1 — FLY-638 终态 prune 扫描集扩展

- `pruneDeadTerminalCommDbSessions` 扫描集 `{completed,timeout}` → `{completed,timeout,failed,blocked}`
  (①标记出的终态 row,窗口证死后由既有 prune 收走;delete 正当性 = §1 修订,判据不变 probe==="dead")。
- **测试**:marked 'failed' + probe dead → prune;'failed' + alive → keep(preserve 哨兵);
  off-flag 下扫描集回到现状(反向哨兵——注意该扩展挂 ② 的 harvest flag 还是无条件,见「决策点 D2」)。

### B2 — ①×② 交互回归

- ①标记后 row 离开 running 扫描集 → ②面②候选收敛(测试:同一 row 先被 A2 mark,再跑
  reconcile running 扫描 = 零候选;再跑 B1 prune probe-dead = 收走)。
- flag 矩阵扩维:`FLYWHEEL_TERMINAL_COMMDB_SYNC` × `FLYWHEEL_COMMDB_FSM_RECONCILE` ×
  `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 关键组合哨兵(全开 / 全关 / 只①(=治本无兜底,新僵尸零产生但
  存量在)/ 只②(= 第一轮形态))。

## 5. 决策点(呈 Tadashi,plan 过目时终裁)

- **D1(§1 分工表)**:①mark-当刻 / ②delete-证死后 的时机分工——确认 A3 答复适用域。
- **D2**:B1 的 prune 扩展挂 `FLYWHEEL_COMMDB_RESIDUE_HARVEST`(推荐,②家族语义一致、一闸全停)
  还是独立 flag。
- **D3**:①层 flag 名 `FLYWHEEL_TERMINAL_COMMDB_SYNC`(default on)。

## 6. 实施顺序与提交纪律

A1 → A2 → A3(条件)→ A4 → B1 → B2,每步 RED→GREEN→REFACTOR、单独 commit 且全绿;全程 progress.md
记 cursor。已实现的 M1-M5 commits 不动(implement 阶段在同分支增量);PR 头移动 → Codex code review
以 resume 增量复审全部新旧改动。PR 描述:决策级摘要 + §1 修订/分工表 + 双层验收清单,链
FLY-1066/FLY-817/FLY-742/FLY-1050/FLY-1279。

## 7. 真机验收(deploy 即验收,配下一次 Bridge 重启窗;M6 原样 + ①层新增)

1. **重启前置门**(必做):7 份生产快照跑 same-predicate preflight(log-only)输出 face/age/FSM/probe/
   action+reason 清单;独立 QA 核对 candidate/keep 集(重点 joycon-typeless/growth/sub 未判读行)。
2. 重启后:②收割计数出现;`d2f31930`/`e4d3b29d`/`e90f3962` 消失(Peter 复核,issue 原文)+
   ~11 条同型消失;flywheel 合法行(design_done×2 等)原样在场(阳性对照)。
3. **①层生产观察**:下一个自然产生的 failed/blocked session(如 auto-QA 失败)→ CommDB row 即时
   'failed'/'blocked',runner_terminal_list 不显示 running(对照:修复前形态 = 永久 running)。
4. 独立 QA 复查生产库,不信实现者自报。

## 8. 验收清单(汇总)

- [ ] A1 迁移:旧库重建保全 + 幂等 + 新值可写(测试)。
- [ ] A2:failed/blocked 转移 → CommDB 实时 mark(两条产生路径 fixture);非 CRASH_PRESERVE 零写
      (突变对照);fail-open 哨兵;flag=0 反向哨兵;retry teardown 哨兵;forceStatus 旁路审计结论落档。
- [ ] B1:prune 扩展四态矩阵(failed/blocked × dead/alive);B2 交互回归 + 三 flag 组合哨兵。
- [ ] ②层既有验收原样(M6 清单:preflight 独立核对、3 样本+同型收净、零误伤阳性对照、§2 硬约束哨兵、
      负向断言全带突变对照)。
- [ ] §1 修订 + 分工表在 PR 描述链给 Codex reviewer;D1-D3 经 Tadashi 终裁。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| hook 写 CommDB 拖慢/破坏转移 | best-effort try/catch + 微秒级 UPDATE(better-sqlite3 同步、单行);FLY-907 同契约;失败只 warn |
| CHECK 迁移撞上并发写者(runner CLI) | 迁移在 CommDB 构造器内、事务原子(FLY-1279 先例已生产验证);重建期间短暂锁表可接受(毫秒级,表行数 ≤ 几十) |
| 'failed' 新值惊吓未盘点读方 | research §9.2 读方矩阵;类型层编译期兜底;真机验收 §7.3 观察 |
| mark 与 retry 语义冲突 | mark 不动 tmux_window;tmux-lookup 按 execId status 无关(已核+哨兵);preserve 窗口照常保留 |
| ①层 flag=0 时回到泄漏现状 | 有意为之(kill-switch 语义);②收割兜底仍在 |
| 双层同 PR 体量大 | Part B 已实现且 QA 过,增量只有 B1/B2;真实新代码 = A1/A2(小);Codex resume 增量复审 |

## 10. Non-goals(exploration §6 原样)

不动 FLY-742 PR-证据路径;无手动 HTTP 入口;不重建 worktree/app-server 清理机制;CommDB 不加
'terminated' 等更多值;park 语义零变化;FLY-638/817 关闭态 byte-compat;FLY-603 autoclean 调查独立跟。
