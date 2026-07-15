# FLY-818 auto-continue Monitor — 探索

Issue: FLY-818 (https://linear.app/geoforge3d/issue/FLY-818/infraepicrobustness-系统健壮性追踪-runner-完成idle-不上报-founder-lead-status-不准)
日期: 2026-07-03
基于: 无(umbrella 首个过程文档;上游 = Annie 的 Linear brainstorm 评论 + FLY-512/FLY-400 research）

---

## 0. 本文档 scope

FLY-818 是 umbrella robustness issue（6 个子项 A–F）。经 BRAINSTORM GATE 与 Lead（Tadashi）确认:

- **本 session 只做 item A** = **runner 一轮做完→idle 空转,没人续跑、没人可靠告诉 founder** 的直接根因。
- C（Lead status 核实）/ D（QA verdict 回写 Linear）/ E（packages/config 进 restart trigger）/ F（stale runner/cmux residue）= 独立小 sync-gap,拆成 umbrella 下的子 issue plan-first,**不塞进本 PR**。

item A 本身是 Annie 在 Linear 评论里定的方向:**A + B 合并升级成一个 goal-driven 自动续跑 Monitor**。

---

## 1. 根因（以 793 stall 为样本）

runner「做完一轮 → idle 空转」没人上报 founder,是几个洞叠加:

1. **无「runner 一轮结束 + idle」的续跑信号**。runner 是 **turn-based**:每个 turn 以一条回复结尾就停下等下一个输入。runner 说「我接着做」只是那条回复里的文字、turn 已经结束 → 没有新输入就 idle 在 prompt。**这不是某个 runner 的 bug,是所有多步任务的天然行为**——runner 不会自己无限循环。代码实证:`TmuxAdapter.buildClaudeArgs`（`packages/claude-runner/src/TmuxAdapter.ts:705-773`)—— `claude [options] [prompt]`,prompt 是最后一个 positional;**Claude CLI v2.1.63 没有 `--max-turns`,也没有任何「跑完继续」的机制**;runner 处理完初始 prompt 就停。

2. **watchdog 是「卡死检测器」,不是「续跑器」**。现 `RunnerIdleWatchdog`（`packages/teamlead/src/RunnerIdleWatchdog.ts`）:
   - poll 间隔被 FLY-628 band-aid 拉到 **~1h**、`waitingThresholdCycles=2`(≈2h 才报 waiting)——刻意拉长,因为短阈值 idle 告警会吵 Lead + 烧 token（对 parked/长任务 runner）。
   - **只 emit `runner_idle_detected` 事件、不续跑**。
   - 事件走 Lead relay(FLY-163:Bridge 不 auto-post)→ Lead 漏 → founder 盲。

3. **Lead status 被动 + 不核实**(= item C,拆子 issue)。

结果:runner 一轮做完还有活,既没人续跑,founder 也要自己去发现它停了。

---

## 2. Annie 定的方向:goal-driven 自动续跑 Monitor

（原文见 Linear 评论,2026-07-03）

- 给 runner 一个 goal（如 implement 全做完 → 开 PR）。
- Monitor 用**短阈值**扫 runner「turn 结束 + idle」:
  - 有 pending question（在问 Lead/founder）→ **不续、正确等回答**(把问题路由出去)。
  - 无 question + goal 未完 → **自动喂「朝 goal 继续」续跑**(无 founder ping、自动)。
  - 真卡住（反复失败 / 真 blocker / 续不动)→ **升级** Lead/founder。
- 对比现 watchdog:新 Monitor = 短阈值 + **自动续跑** + 只升级「真卡住」。
- 一次解决三件:runner 跑到完(自动续)+ founder 不被琐碎 idle 烦(Monitor 自处理)+ 真问题照样浮上来。

**Annie 追加的关键方向（Lead 在 brainstorm gate 转达）**:她想**先试 /loop（runner 原生自循环）**,好用的话**可能就不需要自造看门狗/Monitor 了**。所以本探索**必须先评估 /loop 路,不能直接跳 Monitor**。

---

## 3. 现有可复用基建（已审计,file:line）

| 组件 | 作用 | 与本 issue 的关系 |
|------|------|------------------|
| `RunnerIdleWatchdog`（`RunnerIdleWatchdog.ts`) | 短阈值 tmux capture 检测 idle → emit `runner_idle_detected` | 检测已有,**缺续跑** |
| `quiet-classifier.ts`（FLY-626) | 从廉价信号把 quiet 分类成 `self_parked / self_long_task / done_but_running / pending_gate / recent_comm / review_signal / quiet_unexplained` | 决策树几乎 1:1 映射:`quiet_unexplained` = auto-continue 候选;`pending_gate` = 不续 |
| `attemptRunnerRecoveryNudge`（`runner-recovery-nudge.ts`,FLY-368) | **唯一审计 + 门控的「往终端键入 continue」原语**(gate:status/decision_route/pending-gate/fingerprint/input-box + 全审计) | auto-continue 的键入路径,已存在 |
| `AutoRepairBot`（`AutoRepairBot.ts`,FLY-368) | 对 `runner_stuck_unhandled`(长阈值)→ nudge "continue";默认 OFF（`FLYWHEEL_AUTO_REPAIR=1`) | 已能续跑,但**只对长阈值 stuck、不对短 idle** |
| `AlertChannelHub`（FLY-368,in flight） | 统一 alert 频道,可直达 founder | item A 的「升级直达 founder」出口 |
| `StuckRunnerDetector`（FLY-195/253） | stagnation episode → `runner_stuck_escalation` | 「真卡住」的检测器,可当安全网 |

**结论**:「续跑」的原语（审计 nudge）和「检测」（idle watchdog + quiet-classifier）都已存在;真正缺的是把「续跑」从长阈值 stuck 路径**下沉到短 idle 路径**,并决定这个「续跑」的智能放在**模型里(/loop)**还是**Bridge 里(Monitor)**。

---

## 4. 两条候选路（详细对比见 research.md）

- **路 A `/loop-native`**:runner 自己续跑（Claude `/loop`+`ScheduleWakeup` self-paced / Codex `/goal`),智能在模型里,thin wrapper。
- **路 B `Monitor-extension`**:Bridge 外部检测 idle + 审计 nudge 续跑(扩展 FLY-368),智能在 Bridge。

FLY-512 research（Annie 委托、已完成）已就「Runner 层要不要自主续跑循环」做过判断（finding **F:有意不做**「自主续跑到 done/合并」,因跟 founder-only-authority + human-gated ship 冲突;要借 `/goal` 的**契约结构**、不借它的**自主循环**);FLY-400 research 则背书「thinnest wrapper / everything is the model」。这两份前置研究是本对比的重要输入,research.md 会正面 reconcile Annie 的直觉（试 /loop)与前置研究的立场。

**下一步**:research.md 出「/loop-native vs Monitor-extension」对比（可行性/复杂度/是否自造/backend 覆盖/安全网/robustness）+ 推荐 → 报 Lead → 给 Annie 过目。**不直接实现。**
