# FLY-1462 rework 永久 hold:terminated holder 空 tmux_session 误判 — 探索

Issue: FLY-1462 (https://linear.app/geoforge3d/issue/FLY-1462/infra引擎-rework-永久-holdpersisted-target-missing-terminated-holder-空)
日期: 2026-07-24
基于: 无

## 1. 问题一句话

FLY-1150 QA-fail 之后的 rework 被 `classifyPhaseActorReentry` 永久 hold 在 `persisted_target_missing`:原 holder 已被**显式 terminate**(FSM status=terminated),但分类器只看 `tmux_session` 列是否为空,不看 FSM status,于是把"已证死"的 holder 继续当"无法证明死亡"保守 hold——hold 没有任何出口,rework 的 implement attempt 2 永远 `pending`,永不派新 runner。

## 2. 现象取证(FLY-1150,2026-07-24)

- `workflow_rework_delivery` 卡在 `pending`,generation 980(engine 每个 reconcile tick 重试一次、每次 +1,980 = 已被重试 ~980 次,每次都得到同一个 hold)。
- `last_error = persisted_target_missing`。
- 原 holder(implement attempt 1)的窗口在 ship_parked 阶段被回收 → 行上 `tmux_session` 为空。
- 该 holder 后来被显式 terminate(boot-fail zombie 0555207c,status=terminated)——**terminate 之后 hold 依旧**,证实显式终结不解此结。
- `/loop-reentry` 恢复杆被 `loopbackSelfOrigin` + `isSameOrigin` 限制在 Bridge 内部,Lead 无法触达。
- 后果:Annie 反复问"为什么 1150 没有 implementation 在干活";PR #698 的 7k 行 build 悬在半空。

## 3. 保守 hold 的本意(不能丢的安全面)

`phase-actor-reentry.ts` 的注释写得很清楚:

> `absent` from the registration-backed probe is not death: a cleared/corrupt CommDB registration and a dead process look identical there. Only the actor's persisted tmux target may authorize replacement.

即:**registration 消失 ≠ 进程死亡**(terminal session 的 CommDB registration 会被清掉,和进程真死在 registration 探针上不可分辨)。分类器要求用行上持久化的 tmux target 直接探活才允许 replace——防的是"错判死亡 → 派 replacement → 老进程还活着还在写 branch B → 双写者"。

这条保守面**本设计不动**:有 tmux target 时仍然走探针;探针 indeterminate 仍然 hold。FLY-1050 的教训(terminate 可以返回 cleanupPending——FSM 已 terminal 但 tmux 还活着)靠的就是这条探针路径,保持原样。

## 4. 根因的精确形状

```
classifyPhaseActorReentry:
  registered probe → absent          (terminal session 的 registration 已清,恒 absent)
  ↓
  if (!session.tmux_session) → hold "persisted_target_missing"   ← 卡死点
```

当 `tmux_session` 为空时,探针路径**永远无法运行**;registered 探针**永远返回 absent**。hold 的两个解除条件都被物理封死 → hold 不是"等待更多证据",而是"永久死锁"。而此时 FSM status 明明已经写着 `terminated`——系统自己已经在 FSM 层证明了死亡(terminate 动作走 `applyTransition` 落库、close-runner 杀 tmux),分类器却拒绝采信这份证据。

一句话:**分类器只认"tmux 探针证死",不认"FSM 显式终结证死",而空 target 时前者永远不可得。**

## 5. 方案空间

### 方案 A(选定):分类器认 FSM 终态为死亡证据 — 小、精准、保守面不丢

在 `!tmux_session` 分支内加一层:若 session 的 FSM status 属于 proven-dead 终态集合(terminated / failed / rejected / blocked / deferred / shelved),返回 `{kind:"replace"}`;否则维持原 hold。

- 只改空 target 分支;有 target 时探针路径原样(FLY-1050 cleanupPending 保护不动)。
- `completed` **刻意排除**:completed 是 parked-alive 的常规形态(等待被 wake 复用),"没有 target"对 completed 不构成死亡证据 → 维持 hold(现有测试 `completed + 无 target → hold` 的断言原样保留)。
- 两个消费者(rework coordinator + 三段式 `isWakeTargetProvenDead`)同时受益,语义一致:replace = proven dead。
- 部署后 engine 下一个 reconcile tick 自动重分类 → FLY-1150 自愈,无需人工干预。

### 方案 B(否):把 /loop-reentry 恢复杆开放给 Lead

把 Bridge 内部的恢复端点暴露给 Lead 手动解卡。**否**:治标不治本——每次撞病都要人肉发现 + 人肉解卡,Annie 的"为什么没人干活"还会重演;且扩大了 Lead 对引擎内部状态机的操作面(与 founder-only-authority / TURN 纪律方向相反)。

### 方案 C(否):terminate 动作顺手推进 rework delivery

在 terminate 路径里检测"该 execution 是某 rework 的 preferred actor"并直接把 delivery 推到 replacement_pending。**否**:把 rework 引擎的状态机知识泄漏进 terminate 动作(职责扩散);且只覆盖"先 hold 后 terminate"这一条时序,覆盖不了"terminate 在前、rework 在后"或 failed/rejected 等其它终态入口;分类器修法天然覆盖全部时序。

### 方案 D(否,可作 follow-up):hold 升级告警(generation 阈值 → Discord)

hold 重试 N 次后向 Lead/Annie 发告警。不解决卡死,只缩短发现时间;且本次修复后 proven-dead 类 hold 不复存在,剩余 hold(真 indeterminate)是否值得告警可另立 issue。**不进本单 scope**。

## 6. 影响面

- **直接**:FLY-1150 解卡——rework 立刻派新 implement 修挂掉的测试,保住 PR #698 全部工作(不重做 7k 行 build)。
- **类修**:根治"holder window 被回收/终结 + 需 rework 或 re-drive"的整类永久 hold(reference_rework_persisted_target_missing 记录的病)。三段式 keep-alive 的 `isWakeTargetProvenDead` 同样受益(terminated + 空 target 的 wake 目标不再被误判为"可能还活着"而空等)。
- **纯引擎逻辑**,不加 feature flag(Annie 铁律),直接 enable。

## 7. 开放问题(带到 research/plan 阶段核实)

1. proven-dead 集合的精确成员——与现有三套终态词汇(`TERMINAL_STATUSES` / `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES` / `AUTO_CLOSE_STATES`+`CRASH_PRESERVE_STATES`)如何对齐,是否引用还是本地枚举。
2. replace 的 reason 字面量:复用 `persisted_target_dead`(issue 原文)还是新增独立 reason(取证诚实性:没跑过探针就不该叫 target_dead)。
3. 下游是否有代码按 reason 字符串分支(决定新增 reason 的风险)。
4. 现有测试夹具 status=completed——新逻辑必须不翻转既有断言。
