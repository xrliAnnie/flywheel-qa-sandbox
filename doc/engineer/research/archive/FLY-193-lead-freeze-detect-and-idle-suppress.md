# Research: Lead freeze 检测 / idle 误报抑制 / resume-menu 自动恢复 — FLY-193

**Issue**: FLY-193
**Date**: 2026-06-02
**Source**: team-lead 派单 + `packages/teamlead/src/LeadWatchdog.ts` 代码审计 + 3 个生产 Lead pane 真实抓取
**Status**: Complete (audit) — 待 brainstorm 定方案

---

## 0. TL;DR

FLY-193 是两件事:
1. **真 freeze（part 1）**:长跑 Lead 撞 Claude Code 启动的 "Resume from summary / full / don't-ask" 菜单或 compact 提示 → 卡住等按键 → 收不到 Discord。当前 `pane_hash_stuck` 检测会响,但**没有自动恢复**,得人肉 `tmux send-keys` 选 "1"。
2. **误报刷屏（part 2，高优先,正在烦 Annie）**:`pane_hash_stuck` 对**健康 idle Lead** 误报"Lead pane has been frozen",反复发 Annie 的 Discord。

**关键结论**:
- **不是 regression**。`git log` 证实只有 FLY-83(造的)+ FLY-182(加了默认关闭的修复)动过这文件。误报是 pane-hash 方案从 day 1 就有的固有缺陷。
- 修复**已经存在但默认关闭**:`suppressIdleHealthy` flag(env `FLYWHEEL_PANE_IDLE_SUPPRESS=1`)+ `isIdleHealthyPane()` 识别器,等真实 fixture 验证后才敢开。
- **我拿 3 个真实 Lead pane 验了识别器,发现它还不够**:cos-lead / ops-lead 能正确识别为 idle(会被抑制),但 **product-lead 识别失败、仍会误报** —— 因为它 200 行抓取里有一条**过期的 spinner 行**("…almost done **thinking** with xhigh effort")命中了过宽的 `\bthinking\b` 标记。所以"直接开 flag"**不够**,得先小修识别器。
- 真 freeze 安全性已验证:resume 菜单 / compact 提示 / 卡在工作中 三种都被识别器判为"非 idle" → **仍会告警**。开抑制不会盖掉真 freeze。✓

---

## 1. 告警从哪来(谁 emit `pane_hash_stuck`)

| 路径 | 是否 emit `pane_hash_stuck` | 是否被 flag 管 |
|------|------|------|
| Bridge `LeadWatchdog.tickLead()` (`LeadWatchdog.ts:279`) | **是** | 是(`suppressIdleHealthy`，`LeadWatchdog.ts:268-275`) |
| 壳 `scripts/lead-alert.sh`(经 `claude-lead.sh:1592`) | **否,只 emit `crash_loop`** | — |

**结论**:刷屏 100% 来自 Bridge 的 `LeadWatchdog`,而且确实被 `suppressIdleHealthy` 这个开关管着。所以"开 flag + 重启 Bridge"能止住刷屏 —— **前提是识别器对所有 Lead 都判对**。

## 2. 误报根因

idle Lead 的 pane 是**静止**的(没有动画 spinner)→ hash 连续 ≥3 个周期(~90s)不变 → 没有 blocked 关键词 → 落到 `pane_hash_stuck` 告警。watchdog 单凭"hash 稳定"无法区分"活着但空闲"和"真冻住"。这是 FLY-83 pane-hash 方案的固有局限,FLY-182 已经认识到并写了修复(B3)但默认关闭。

反馈回路使刷屏更糟:告警 → Lead 回一句"FLY-193 false positive, holding silent" → pane 变 → 重新静止 90s → 又告警。每次 pane 内容微变 → 新 eventId signature → 30 分钟 cooldown 去重抓不住。

## 3. 识别器现状(`isIdleHealthyPane`,`LeadWatchdog.ts:449`)

判 `true`(= idle 健康 = 抑制)需要同时:
- 无 blocked 关键词(rate/usage limit、login、permission),且
- 无 "working" 标记(`esc to interrupt` / `\bthinking\b` / `\bworking\b` / token 计数 / `esc…cancel`),且
- 有高置信 idle-ready 标记(`? for shortcuts` / `shift+tab to cycle` / `try "`)。

抓取用 `tmux capture-pane -p -S -200`(`lead-alert-helpers.ts:240`)= **200 行滚动历史**,识别器扫的是整 200 行。

## 4. 真实 fixture 验证结果(用编译后的真代码跑)

3 个生产 Lead(`flywheel:1.0/2.0/3.0`,2026-06-02 抓取):

| Lead | `isIdleHealthyPane` | 结果 |
|------|------|------|
| cos-lead | `true` | 抑制 ✓ |
| ops-lead | `true` | 抑制 ✓ |
| **product-lead** | **`false`** | **仍会告警 ✗(漏)** |

product-lead 漏的原因:第 235 行(滚动历史里)有过期 spinner `✢ GEO-371 … (11m 3s · ↓ 47.1k tokens · almost done **thinking** with xhigh effort)` 命中 `\bthinking\b`。而 pane 底部其实是干净的 idle `❯` + 状态栏。**整页扫描被历史里的陈旧 spinner 污染了。**

真 freeze case(必须判 `false` = 继续告警):

| case | `isIdleHealthyPane` | 结果 |
|------|------|------|
| resume 菜单 | `false` | 继续告警 ✓ |
| compact 提示 | `false` | 继续告警 ✓ |
| 卡在工作中(spinner+esc to interrupt) | `false` | 继续告警 ✓ |

## 5. 额外 fixture 发现:idle 标记不通用

GEO-371 runner 空闲时状态栏是 `⏵⏵ bypass permissions on · 1 shell · ← for agents` —— **没有 `shift+tab to cycle`**(后台有 shell 在跑时,"1 shell" 顶掉了 "shift+tab to cycle")。所以 `shift+tab to cycle` 不是通用 idle 标记,idle 标记集不完整。更稳的 idle 正向锚点是**状态栏本身**(`Opus 4.x…/xhigh | ⚡<agent> | … ctx N%` + `⏵⏵ bypass permissions on`)。

## 6. 识别器需要的小修(方案待 brainstorm)

核心:识别只看 pane **底部活区**(input box + 状态栏),别扫整 200 行历史,这样上方的陈旧 spinner 总结不会污染判断。候选:
- (a) 把 working/idle/blocked 检测限定到"活区"(从最后一个 input-box 顶边 / 最后一个 `❯` 到页尾,外加上方几行抓活 spinner);
- (b) 收紧 WORKING_MARKERS 到高置信 LIVE 信号(`esc to interrupt` / `esc to cancel` / 活 spinner glyph `✻/✢` + 走动计时),去掉过宽的裸词 `\bthinking\b` / `\bworking\b`;
- (c) 加稳健的 idle 正向锚点:状态栏出现在底部几行 + 底部有 `❯`。
- 大概率是组合:定义"尾部活区" + 要求底部有 idle 状态栏锚点 + 活区内无活 spinner。

## 6.1 已验证的 V2 原型(live-region 识别器,feasibility 已证)

把识别限定到 pane **底部活区**(从最后一个 input-box 顶边 `──…── @<agent> ──` 往上 4 行到页尾),并收紧标记:

- BLOCKED 关键词:只在活区判;
- WORKING 标记:收紧到高置信 LIVE-only(`esc to interrupt` / `esc to cancel`),**去掉**过宽裸词 `\bthinking\b` / `\bworking\b`;
- 正向 idle 锚点:活区里有状态栏(`⏵⏵ bypass permissions` / `ctx N%`)+ `❯` prompt。

原型对真实 fixture 跑分:

| 输入 | V2 判定 | 期望 |
|------|------|------|
| cos-lead(真) | true 抑制 | ✓ |
| ops-lead(真) | true 抑制 | ✓ |
| **product-lead(真)** | **true 抑制** | ✓(V1 这里漏) |
| resume 菜单 | false 告警 | ✓ |
| compact 提示 | false 告警 | ✓ |
| 卡在工作中(spinner+esc to interrupt 紧贴 box) | false 告警 | ✓ |

**注意(FLY-169 教训)**:"卡在工作中"那条是我构造的合成 fixture,不是真 capture。最终上线前必须用**真实工作中**的 pane(QA test slot 或抓一个正在干活的 Lead)验证活区窗口大小 + 标记集。方向已证可行,精调留 implement 阶段。

## 6.2 enable 后的安全验证(回答"会不会盖掉真 freeze")

team-lead 紧急 enable flag 后,补做完整 fixture 验证:

**真 freeze 用真实文本(不是脑补)**——从 `feedback_lead_resume_confirm_freeze.md` 拿到生产实测的 resume 确认框原文:
```
Resuming the full session will consume a substantial portion of your usage limits.
We recommend resuming from a summary.
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
Enter to confirm · Esc to cancel
```
注意它**有 `❯`**(对抗性),但**没有**状态栏 / `shift+tab to cycle` / `? for shortcuts`。

| 输入 | 当前 `isIdleHealthyPane` | 结论 |
|------|------|------|
| resume 菜单(真实原文) | **false** | 不抑制 → 仍告警 ✓ |
| compact 提示 | **false** | 不抑制 → 仍告警 ✓ |
| cos-lead / ops-lead(2 次快照) | true | 抑制 ✓ |
| product-lead(2 次快照) | **false** | **漏(仍告警)** —— 不是危险方向 |

**结论(给 team-lead 的安全答复)**:enable flag **没有制造盖掉真 freeze 的盲区**。识别器是 **fail-open**(拿不准就告警):resume 菜单 / compact / 卡工作中 全部不被抑制。唯一瑕疵在**相反的安全方向**——product-lead 偶尔漏(它 scrollback 里有陈旧的 "runners are now **working**" / "15,540 **tokens used**" 命中过宽 working 标记)。瑕疵 = 烦但不危险。

**V2 live-region 修复对 fresh 抓取再验证**:cos/ops/product 三个 fresh 全 `true`(product 修好),resume/compact/卡工作中 全 `false`。V2 同时解决两种 stale 变体("thinking" 和 "working/tokens used")。

## 7. Part 1 自动恢复(resume / compact 菜单)

识别到 resume / compact 菜单(非 idle、非 blocked 关键词)→ 自动 `tmux send-keys` 选推荐项(Enter / "1"),同 Simba 手动操作。注意 FLY-169 教训:往 pane 里打字要"先确认再发"的多重 gate(只在高置信菜单 + 幂等时发)。**自动选哪一项需要 Annie 拍**(选 "1. Resume from summary" 会丢全历史压成摘要;6h/758k token 的 Lead 影响不小)。

## 8. 关联 issue

与 FLY-191(`awaiting_review` 卡死、Bridge 够不到)、FLY-195(runner stream stall、tmux send-keys 恢复)共享一个 core:**区分 idle / 卡在 gate / 真冻住,并用 tmux send-keys 自动恢复**。需与 worker-fly-191 / worker-fly-195 对齐,避免互踩 `RunnerIdleWatchdog.ts` / `runner-status.ts`。本 issue 只碰 Lead 侧(`LeadWatchdog.ts`)。

## 8.5 紧急止血部署记录(2026-06-02 17:17)

FLY-182(今早 ship)Track B 让告警投递变可靠 → 一直存在的 `pane_hash_stuck` 误报现在每 ~90s 稳定刷到 Annie(烧她 token)。紧急处置:

- **动作**:`~/.flywheel/.env` 加 `FLYWHEEL_PANE_IDLE_SUPPRESS=1`(wrapper `set -a` 自动导出)→ `launchctl kickstart -k gui/501/com.flywheel.bridge`。无 rebuild、无改代码。
- **验证**:新 Bridge PID 41661,env 里有 flag,`LeadWatchdog started`。未碰 Lead `bun server.ts`(13 个 adapter 全活)、未重启任何 Lead。
- **效果**:重启前 `alert_claims` 每 ~90s 一条(cos/ops 交替);重启后 **连续 10 分钟 0 条**(含 product-lead 残留也没触发 —— 陈旧 spinner 已滚走,pane 现在是干净 idle)。
- **真 freeze 安全**:resume / compact / 卡工作中 三种 `isIdleHealthyPane=false` → 仍告警,未致盲。
- **持久性**:flag 在 `.env`,Bridge 自动重启后仍生效。
- **残留**:product-lead 仍可能偶发漏(§4 的 V1 缺陷),由 §6.1 的 V2 live-region 识别器在正式 PR 里根治。

## 8.6 生产二次事件:product-lead(Peter)仍刷屏 — 现场诊断(2026-06-02 22:xx)

`FLYWHEEL_PANE_IDLE_SUPPRESS=1` 开了之后,cos/ops 静了,但 **product-lead 还每 ~15 min 刷**(22:23/22:31/22:34…)。现场抓 `flywheel:2` 实时诊断:

**判定:(a) 误报。Peter 是活的,不是冻住。** 5 秒抓两次:spinner 计时从 `1m22s` 走到 `4m14s`,再到 `✳ Compacting conversation… (6m5s) ▰▰▰ 71%` —— Peter 在 **ctx 100% → 自动 compact**(正常恢复,不是 hang)。随后 compact 完成 → ctx 跌到 11% → 干净 idle。**绝不发 Enter**(它在工作)。

**根因纠偏(重要)**:team-lead 一开始怀疑"ctx 100% 这个状态 recognizer 认不出"。**数据否掉了**:lead 抓的 6 行 capture(只有 input box + 状态栏)跑 V1 = `true`(会抑制);**真正原因**是 watchdog 抓的是 `capture-pane -S -200`(200 行),product-lead 的滚动历史里有陈旧的 `…almost done thinking` / "runners are now working" / "tokens used" → 整页扫中招。`ctx 100%` 只是相关(满 ctx → 更多 extended-thinking → 更多陈旧 spinner),不是机理。**Peter compact 后滚动历史被清空 → 陈旧 marker 归零 → 连 V1 都抑制了 → 刷屏自愈**(27 min 无新告警)。

**止血决策**:team-lead 拍板今晚**不重启 Bridge**(撞 FLY-176),靠 Peter compact 自愈 + 把 recognizer 在 PR 里正经修。`~/.flywheel/blocked/product-lead` marker 是可用的 file-level 止血杠杆(watchdog 见 marker → Silent),但会致盲该 Lead,本次未用。

**一致性修正(本轮 PR 加强)**:原 V2 用 spinner glyph 集判"working",但 `✽` 没在集里 → 跟 `✳` 行为不一致;且 extended-thinking 的 `(Xs · thinking)` 行**会滞留**在 idle 态。改为**只认"结束即消失"的在途操作标记**:`esc to interrupt` / `esc to cancel` / `Compacting conversation`(已验证 compact 完即消失)。**已知局限**:真冻在 extended-thinking(无 interrupt 提示)与"idle-after-thinking"单帧不可分,选择抑制(罕见 + tmux 可观察)。新增 fixture:`idle-product-lead-ctx100.txt`(must-suppress)+ `freeze-compacting.txt`(must-NOT-suppress)。

## 9. 部署注意

- Bridge 重启会碰**活的生产**(GEO-371/397 runner 在工作中)。FLY-172 已让 Bridge 重启不再误判 runner failed,但要确认。
- `restart-services.sh:523` 有 multi-PID kill bug(FLY-176,已撞 4 次):重启 Bridge 需盯着,可能要手动 `pgrep -f run-bridge | xargs kill -9` + `launchctl kickstart`。
- 部署有 worker 在 hot-deploy 时,先协调(feedback_coordinate_bridge_restarts)。
