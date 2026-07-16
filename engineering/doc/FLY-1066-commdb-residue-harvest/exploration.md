# FLY-1066 Bridge 侧残留治理(双层:根因自清 + 兜底收割)— 探索

Issue: FLY-1066 (https://linear.app/geoforge3d/issue/FLY-1066/infra-bridge-侧残留收割-commdb-孤儿注册清理-statestorecommdb-终态同步-scope-free-清理入口)
日期: 2026-07-16
基于: 无(上游取证 = FLY-1050 design addendum F8 系列,权威摘要在 FLY-1066 issue 描述;F8 防御规格另见 engineering/doc/FLY-1070-qa-respawn-verify/research.md §3)

## 0. Scope 演变(为什么这份是重写版)

本票第一轮 design(本文件夹旧版,2026-07-16 上午,Codex design review 4 轮 APPROVED)只做了**收割器**:
boot/心跳/定点三入口扫两本账、收四面僵尸。该方案已在本分支完整实现(M1-M5,原 PR #616)且独立 QA PASS。
**Annie 否决了这个 scope**:只做收割 = 打补丁——残留会持续产生,收割器只是把垃圾定期扫走。
她选了方案 C:**两层一起做**。Tadashi 在重开后的 brainstorm gate(2026-07-16)明确分工:

> **能拦的走①实时自清(治本)、拦不住的走②收割(兜底,像 fsck)。只有② = 打补丁。**

- **① 根因层(本轮新增,核心)**:complete / park / `--route blocked` / auto-QA spawn 失败这些**可拦截**的
  终态路径,session 退出时**实时**清自己的残留(CommDB row + app-server + worktree),让残留根本不产生。
  复用现有 `finalizeSession` / FLY-1185(FLY-603 家族)worktree-autoclean 原语。
- **② 兜底层(上一轮已设计+已实现,保留)**:SIGKILL / OOM / Bridge crash——进程没有机会自清的死法——
  由 boot/心跳/定点收割器兜底。四面判据与安全约束不变(见 §4)。

## 1. 现象与取证(2026-07-16 只读复核,全部样本仍在场)

Flywheel 有两本账:**StateStore**(`~/.flywheel/teamlead.db`,Bridge 的 FSM 真相)和 **CommDB**
(`~/.flywheel/comm/<project>/comm.db`,Lead↔Runner 通信 + Lead 视图 `runner_terminal_list` 的读模型)。
两本账各自可以残留、也可以互相失同步,产生四种「永久僵尸」形态:

| 面 | 形态 | 生产样本(2026-07-16 在场) | 数量 |
|---|---|---|---|
| ① CommDB 孤儿 | CommDB sessions 有 row(status=running),StateStore **无 row** | `d2f31930`(tmux `%194`、issue_id=NULL、lead_id=NULL、2026-05-11) | 1 |
| ② 终态未同步 | StateStore 已终态(failed/blocked),CommDB registration 仍 running | `e4d3b29d`/`e90f3962`(GEO-441 auto-QA,`runner-geoforge3d:pending` 占位)+ geoforge3d 3 条(GEO-342/424/347)+ flywheel 8 条 | ~13 |
| ③ StateStore 幽灵 | StateStore **非终态**(如 awaiting_review),CommDB **无 row**,tmux terminal 已死 | Asha 夜跑事故形态(2026-07-15 夜,3 个夜跑位被吃 + close_runner 报 No session found) | 事故实证 |
| ④ 双无主 escalation | `detection_escalations` 表 pending 行,target exec 在**两本账都查无此人** | 2026-07-15 夜 65 条告警风暴的实测形状 | 事故实证 |

面①②的 6 个已知样本 tmux 目标全部实测 `probe=dead`。伤害:Lead 视图永远显示 running 僵尸、
close_runner 够不到(无 StateStore row / 跨 project 被 checkLeadScope 挡)、幽灵占 active-session 位使
`/api/runs/start` 409(cron 夜跑位被吃)、pending escalation 反复驱动告警风暴。

## 2. 根因分析 — 泄漏源清单(①层的靶子)

残留 = **产生**(退出路径没清)+ **收不回**(现有清理机制盲区)。第一轮 design 只解了后者;这里把前者列全。

### 2.1 一个 session 的三种残留物与其应然归宿

| 残留物 | 应然归宿 | 现有清理原语 |
|---|---|---|
| CommDB sessions row | 正常关闭 → `finalizeSession` DELETE;crash-preserve(failed/blocked,窗口留取证)→ **status 如实标记**(不删,retry teardown target 保留) | `finalizeSession`(FLY-1238)/ `updateSessionStatus` / `unregisterPendingSession`(FLY-80) |
| app-server / MCP 子进程(Codex 常驻 daemon 等) | 随 session 关闭被 reap | closeRunner 的 MCP-descendant reap(FLY-228)+ `codex-phase-shutdown`(FLY-1269 协作式关停) |
| worktree + 分支 | ship/cancel closeout 时按 FLY-1185 §2.4 CAS 原语清理 | lifecycle-closeout 五入口(FLY-1185)+ branch-cleanup/worktree-cleanup 原语 |

### 2.2 泄漏源逐条(exit-path × 是否可拦 × 现状)

| # | 泄漏源(exit path) | 残留物 | 可拦? | 现状(2026-07-16 head 实核) |
|---|---|---|---|---|
| S1 | **FSM → failed**(reapOrphans force-fail、spawn 失败、DecisionLayer failed 路由、FLY-1282 zombie declaration) | CommDB row 停在 running | ✅ ①层 | 无任何路径同步 CommDB(CRASH_PRESERVE 不走 close)→ 生产 ~11 条 failed 僵尸的直接来源 |
| S2 | **FSM → blocked**(`flywheel-comm complete --route blocked`) | CommDB row 停在 running | ✅ ①层 | 同上(FLY-817 模块头点名此路径);CommDB 有 `updateSessionStatus('blocked')` 原语但没人在此路径调 → 生产 2 条 blocked 僵尸 |
| S3 | **auto-QA / dispatcher spawn 失败**(GEO-441 形态:预注册 `…:pending` 后 blueprint 外的失败) | CommDB `:pending` row 停在 running + StateStore failed | ✅ ①层 | `cleanupPreRegistration`(unregisterPendingSession)只挂在 run-dispatcher 自身 catch(run-dispatcher.ts:842/897/923);经 S1 hook 兜住后此形态归并为 S1(标记 failed),定点 unregister 为增强 |
| S4 | **completed 但 Lead 从未 close** | CommDB row 停在 running(runner 可能 parked-alive) | 已有 owner | adapter 受控退出会写 completed(TmuxAdapter.ts:703 finally / CodexTmuxAdapter.ts:821)+ lifecycle-closeout 五入口(FLY-1185)+ FLY-817 boot 收 deletable 终态 → 非本票新增面 |
| S5 | **park(declare-state parked)** | 无 —— parked = done-but-alive by design,残留在后续 close 时清(S4 owner) | 已有 owner | close/closeout 路径已调 finalizeCommDbSession(close-runner.ts:373 / actions.ts:1402 / crash-reaper.ts:319 / lifecycle-closeout.ts:243) |
| S6 | **SIGKILL / OOM / Bridge crash** | 全部三种 | ❌ 只能② | 进程无机会自清 → 收割器兜底(crash-reaper 管 StateStore 侧可见的;两本账失同步形态归②四面) |
| S7 | **StateStore 整库重建**(FLY-663 形态,样本①的成因) | CommDB 孤儿 row | ❌ 只能② | 没有任何 StateStore-driven 机制再认识它 → ②面① |
| S8 | worktree / app-server 在 crash 死法下的残留 | worktree、daemon 进程 | ❌ 只能②/既有 | crash-reaper teardown + FLY-1185 periodic sweep + FLY-1269 provably-absent backstop 已各有 owner;审计 gap 落 plan 的 L-C 审计项 |

**结论**:①层可拦截的真实 gap 收敛为一个结构性缺口——**Bridge 侧 FSM 转移到 CRASH_PRESERVE
(failed/blocked)时,没有任何机制把 CommDB registration 的 status 如实化**(S1+S2+S3)。
其余泄漏源要么已有 owner(S4/S5),要么原理上只能靠②(S6/S7/S8)。

### 2.3 现有清理机制的盲区(②层的靶子,第一轮 design 结论,原样成立)

| 机制 | 扫描集 | 盲区 |
|---|---|---|
| FLY-638 boot prune | CommDB `{completed,timeout}` | 面①②③④均不在扫描集 |
| FLY-817 FSM reconcile | CommDB `{running}` | 面①(`!fsm → keptNonTerminal`)、面②(`CRASH_PRESERVE → keptPreserve`,注释「tracked separately」= 本票)、面③(无 CommDB 行可遍历)结构性看不见 |
| FLY-720 crash-reaper | StateStore running + CommDB 目标可得 | 面③ no-target 明确不 own |
| FLY-742 stale-blocker-guard | 409 blocker | PR open/unknown 只告警不自愈 |

## 3. ① 根因层设计(本轮新增)

### 3.1 L-A:终态 CommDB 同步——五个生产写入面 + 非阻塞队列(核心;Codex design R1 收紧后形态)

Bridge 侧 failed/blocked 的**生产写入面是五个确定点**(不止 applyTransition——`DirectEventSink` 故意
绕过它直写 upsertSession,DirectEventSink.ts:102-108 / run-infra.ts:554-556 自述):
① 共享 ApplyTransitionOpts.onTransition(FLY-907 实例) ② stale-blocker-guard 自有 onTransition
③ DirectEventSink 的 `route==="blocked"` completion 直写点 ④ `DirectEventSink.emitFailed`
⑤ complete-marker-reconciler 的 forceStatus fallback。五点统一调同一入口:

```
enqueueTerminalCommDbSync(execId, targetStatus, project):   // 同步调用点:只做内存入队,微秒级
  targetStatus ∈ {failed, blocked} 才入队(coalesce by execId)
drain(per-project single-flight,调用栈之外):
  重读 StateStore 权威状态仍 ∈ {failed, blocked} → CommDB mark + first-terminal ended_at
  (CommDB 构造器重量级——mkdir/WAL/migrations/busy_timeout 5s——绝不在 hook 内开库)
```

- **只 mark 不 delete**:CRASH_PRESERVE 的窗口可能还活着(取证/scrollback/retry teardown target)——
  FLY-116 政策与 FLY-817 BLOCKER-1 原样保留;`tmux-lookup.ts:178` 按 execution_id 读 row、status 无关,
  mark 不破坏 retry。Tadashi gate 答复 A3 确认。
- **写入优先级**(防 last-writer-wins 竞态):adapter 生命周期尾写(completed/timeout)只允许 CAS
  `WHERE status='running'`;mark = StateStore 权威写,`ended_at` first-terminal-write 不漂移;
  registerSession 晚注册时序审计。
- **CommDB CHECK 加 `'failed'`**(Tadashi gate 答复 A1 采纳):按 FLY-1279 已验证的整表原子重建模式
  (db.ts:370-405 同款)扩 CHECK;`types.ts:67` union 同步。**读侧候选集必须同步扩**:
  `getRecentTerminalSessions`/`countTerminalSessions` 硬编码 `('completed','timeout')`,不扩则 mark
  对 `runner_terminal_list` 不可见(Codex R1 #4);`cleanupStaleSessions` 刻意不扩(它 kill 窗口,
  与 preserve 政策冲突)。
- **效果**:status ≠ running → classifyRunnerRow terminal 分支 → 窗口活 = parked-alive(比 running
  诚实),窗口死 = dead(默认隐藏)。S1/S2/S3 三个泄漏源在**产生当刻**闭合,不再等收割。
- **其余 forceStatus 旁路**(StateStore.ts:3505 legacy 直写):逐点写死「生产不可达 failed/blocked」
  证明 + 守卫测试 pin;证明不成立的并入五面 inventory。

### 3.2 L-B:spawn 失败 cleanup 覆盖审计(非代码 gate;Codex R1 #7 改判)

S3 经 L-A 已闭合(spawn 失败 → FSM failed → row 标 failed 隐藏);且现行 dispatcher 已在 pre-launch
abort / promise rejection / 无 sessionId 失败结果上调用 `cleanupPreRegistration`(FLY-80)。L-B 因此是
**审计并引用/补 pin 既有覆盖**的非代码 gate——只有找到一个具名、可复现、且拿到「从未启动」证明的
未覆盖分支才新增 `unregisterPendingSession` 调用;GEO-441 历史形态与现行覆盖的差异写进审计结论。

### 3.3 L-C:app-server / worktree 的审计与 pin(不重建机制)

审计结论(research §10):这两类残留的清理**已有专责机制**——closeRunner 的 MCP-descendant reap
(FLY-228)、codex-phase-shutdown(FLY-1269)、lifecycle-closeout 五入口 + branch/worktree CAS 原语
(FLY-1185)。①层不重复建设,交付物为:
1. research 里的 exit-path × 残留物 owner 矩阵(§10)——把「谁负责清什么」第一次写成一张表;
2. implement 时对矩阵里标 gap 的格子逐个实核,真 gap 修在本票、机制级缺陷另开 issue
   (已知线索:FLY-603 worktree autoclean 未触发的调查是独立 open item,不并入本票)。

### 3.4 ①与②的交互

- ①上线后,新增 failed/blocked 僵尸在源头闭合 → ②面②的候选集随时间收敛到「crash 死法」残留,
  收割器回归 fsck 定位(Tadashi 的分工原话)。
- ①标记出的 `failed`/`blocked` 终态 row,窗口一旦证死即成死尸 → **②的终态 prune(FLY-638)扫描集从
  `{completed,timeout}` 扩为 `{completed,timeout,failed,blocked}`**(delete 仍只认 probe=dead;新增
  两值挂 harvest flag,原集无条件保留)。该 delete 的正当性 = 第一轮 design §3.7 已获 Tadashi + Codex
  双签的 FLY-817 BLOCKER-1 修订(probe=dead ⇒ preserve 标的已灭失)。**收敛节奏**:prune 同时纳入
  residue full pass(heartbeat maintenance ~1h 一轮)——现状它只在 boot 跑,mark 后的行离开 running
  扫描集,不入 full pass 就要等下次重启才收(Codex R1 #5)。

### 3.5 决策呈报:mark 与 delete 的分工(消解两次答复的表面矛盾)

Tadashi 对重开 gate 的 A3 答复(「failed/blocked 只 mark 不 delete,delete 列 follow-up」)与
第一轮已实现的面②(probe=dead 即 delete,BLOCKER-1 修订双签)表面冲突。本设计按**时机分工**消解:

| 时机 | 动作 | 理由 |
|---|---|---|
| ① 转移当刻(窗口可能活着) | **mark**(updateSessionStatus) | 非破坏;preserve 政策原样;A3 的本意 |
| ② 收割时(probe=dead 铁证) | **delete**(finalizeSession) | preserve 标的已灭失;BLOCKER-1 修订已双签、已实现、已 QA |

即:A3 约束的是「转移当刻」的实时动作;probe=dead 后的收割 delete 维持第一轮已批语义。
此分工在 plan 呈 Tadashi 过目时显式列出,由他终裁。

## 4. ② 兜底层(第一轮方案,保留;已实现)

四面判据、三入口(boot + 心跳 maintenance 搭车 + scheduled-run 409 定点)、安全约束
(收割信号 = terminal/CommDB 存在性,绝不是 FSM 终不终态;删除只认 probe==="dead";
awaiting_review + terminal 活 = 结构性不可触;fail-closed 时间戳;`FLYWHEEL_COMMDB_RESIDUE_HARVEST`
kill-switch;scope-free = 零 leadId 检查、只遍历本 Bridge config projects)——
全部见本文件夹旧版归档于 git 历史(commit `6a79e4918`)与 plan.md「Part B」;
实现已在本分支(M1-M5,独立 QA PASS,qa-report.md)。本轮对②仅做两处增量:
§3.4 的 FLY-638 prune 扫描集扩展 + 面②候选集在①上线后的收敛说明。

## 5. 备选方案(已否决)

| 方案 | 否决理由 |
|---|---|
| 只做②收割器 | **Annie 否决**:= 打补丁;残留持续产生 |
| 只做①自清、砍掉② | crash/OOM/SIGKILL/库重建死法无进程可自清;昨夜面③④事故正是这类;②已实现且 QA PASS,砍掉是倒退 |
| ①各写入面各自开库直写(无统一队列入口) | 打地鼠 + 每处重复 open/close 重量级 CommDB;统一 `enqueueTerminalCommDbSync` 五面接线 + 单 drain,语义一处定义(注意 applyTransition **不是**唯一咽喉——DirectEventSink 生产直写,Codex R1 #1) |
| ①连 completed 家族也 mark | S4 已有三重 owner(adapter finally / lifecycle-closeout / FLY-817);再加一层是冗余写放大 |
| CommDB 不加 'failed'、failed 映射 'blocked' | 状态可信是 FLY-942 家族主题;Tadashi A1 拍板加 'failed';FLY-1279 迁移模式现成 |
| 新 `/api/actions/cleanup` 手动端点 / 枚举 `~/.flywheel/comm/` 全目录 | 第一轮已否决(FLY-175 扩权 / 跨 Bridge 误伤),理由不变 |

## 6. Non-goals

- 不动 FLY-742 PR-证据路径;不做手动 HTTP 入口;FLY-638/817 关闭态 byte-compat(同第一轮)。
- 不重建 worktree/app-server 清理机制(已有 owner,见 §3.3);FLY-603 autoclean 未触发的调查独立跟。
- 不给 CommDB 加 'terminated' 等更多状态值(YAGNI:terminated 路径由 closeout DELETE,轮不到 mark)。
- park 语义零变化(parked = 合法保活,不是残留)。

## 7. 验收(双层)

1. **①层**:构造 fixture——FSM 转移 failed(reapOrphans 路径)与 blocked(complete --route blocked 路径)
   → CommDB row 实时变 'failed'/'blocked' + ended_at;runner_terminal_list 不再显示 running;
   retry teardown(closeRunner forcePreserved)在 marked row 上照常工作(哨兵)。
2. **②层**:第一轮验收原样(Peter 3 样本收净 + ~11 条同型 + 合法行零误伤阳性对照 + M6 same-predicate
   preflight 独立 QA 核对)+ prune 扩展面(marked-dead row 被终态 prune 收走)。
3. **byte-compat**:①层 hook 挂 kill-switch(plan 定 flag 名),=0 时与现状逐字节一致;②层旧 sentinel 原样。
4. 部署重启后生产复核:新产生的 failed/blocked session 不再留 running 僵尸(观察一个 crash-preserve
   实例);Peter 3 样本消失。

## 8. 下游

- ①层代码审计锚点 + exit-path×残留物 owner 矩阵 → 同文件夹 `research.md` §10(新增)
- 双层实施计划(Part A = ①层新工作;Part B = ②层 as-built + 两处增量)→ 同文件夹 `plan.md`(重写)
- plan 完成 → Codex design review → **发 Tadashi 过目 → 他呈 Annie → 才进 implement**(重开 gate 的明确指令)
