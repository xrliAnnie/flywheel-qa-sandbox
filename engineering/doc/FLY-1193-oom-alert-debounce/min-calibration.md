# FLY-1193 MIN 重校准 — ship gate 判定报告

Issue: FLY-1193 (https://linear.app/geoforge3d/issue/FLY-1193)
日期: 2026-07-12
基于: plan.md §5(MIN 重校准 ship gate)、evidence-soak-collect.mjs、evidence-replay-gate.mjs

---

## 判定:维持 MIN=0(不新增 §2.2 的 MIN 校准 commit)

plan §5-4 的 ship gate 是:**「选定 MIN(含 0)下完整 busy trace 零达到 N 的 page episode」才可继续 ship**。
本次繁忙**峰值**窗口 soak + 离线 replay 显示 **MIN=0 + N=120 下 busy trace 零 page**,MIN=0 是 debounce 结构性修复下的正确选择(无正样本时不安全调大 MIN,§5-6)。

> **未决项(诚实标注,交 gate owner Tadashi):** plan §5-1 明文写的是 **pre-ship ≥2h busy soak**;本次实采是 FLY-1189 campaign 的繁忙**峰值段**(load 62–90,~30 min),它决定性捕捉到病灶(30s 即自愈 episode),但**时长未达字面 2h**。合成压力被禁(7-09 先例)、且峰值后负载已回落到 ~20(安静段对校准无增益),要凑满 2h 的**繁忙** soak 需再等一个不可预测的繁忙窗口。因此这是一个 **gate-duration 改约**决定,不由 Runner 单方拍板 —— 已经 `flywheel-comm ask` 知会 gate owner Tadashi(见 PR 描述)。在改约确认前本报告**不声称 §5-1 字面达成**;`soak-extended.jsonl` 继续累积供 merge 前复跑,plan §4-4 的部署后 ≥1 天观测窗是**全时长 standing gate**,ship 本身也是 founder-gated。

## 证据

### 负样本 soak(繁忙窗口,只读 vm_stat,零合成压力)

- 采集脚本:`evidence-soak-collect.mjs`(30s 节拍,`vm_stat` inline parse)。两份轨迹:`soak.jsonl`(繁忙峰值窗口,61 样本 / ~30 min)+ `soak-extended.jsonl`(峰值后延长采集,负载回落,gate 同样 PASS,零 danger)。
- 采集时机:**2026-07-12 晚,load average 62.9→90.7、~166 个 claude/codex 进程** —— 正是 FLY-1189 N-to-N campaign 类的繁忙**峰值**(本 issue 的现场条件);之后负载自然回落到 ~20。
- 分布(峰值窗 `soak.jsonl`,**61 样本 / ~30 min**):
  - **freePct**:min 17.4% / p10 19.6% / p50 22.6% / p90 25.2% / max 26.5% —— **全部远高于 LOW=8%**;`free<8` 计数 = **0/61**。
    → **证实审计更正**:告警文案里的「19%」不是任何阈值,free% 分支从头到尾没触发过。
  - **swapoutDelta**:**60** 个可算 delta 中 **56** 个为 0;仅 **4** 个非零脉冲:`14652 / 19160 / 34380 / 50028` 页/tick。
    → 起新 runner 的瞬时内存分配造成的**孤立** swapout 脉冲;每个脉冲后下一 tick 即回 0。

### 离线 replay gate(同一 detector + debounce)

`evidence-replay-gate.mjs` 用与 `machine-watermark.ts` 逐字一致的状态机(2-tick 确认 + 三态 health)加 `maybePage` debounce 回放 trace:

| 配置 | danger ticks | triggers(episodes) | 最长 episode | **page episodes(≥N)** | gate |
|---|---|---|---|---|---|
| **MIN=0 + N=120(本修正)** | 4 | 1 | **30s** | **0** | **PASS** |
| MIN=0 + N=0(旧行为对照) | 4 | 1 | 30s | **1** | FAIL |

**解读**:繁忙窗口里 swapout 脉冲偶有 2 连 → 触发 1 个 episode,但该 episode **30 秒即自愈**(30s ≪ 120s)→ 新 debounce 结构性地把它过滤成**零 page**;而旧行为(trigger 即 page)在**同一** 30 秒 episode 上会 page 一次。
这与生产 `alert_threads` 表的病灶形态**逐字吻合**:7-12 09:04:31 opened → 09:05:01 resolved = 30 秒 episode 的误 page。debounce 正是治它。

## 为什么不调大 MIN(scope discipline + 安全)

观测到的脉冲量级很大(14k–50k 页/tick ≈ 230–800MB)。把 MIN 抬到这些脉冲之上确实能让它们连 danger 都不算(防御纵深),但:

1. **MIN 正交作用于 danger 与 healthy**(`delta > MIN` 判 danger、`delta ≤ MIN` 判 healthy)。把 MIN 抬到 50028 之上,会让「一个吐 40k 页/tick 的**真** thrash」被判成 healthy → **hold 被提前解除** —— 正是 plan §5-6 警告的失效模式。
2. plan §5-4 明确:**只有拿到正样本(真实压力 trace)验证「真实压力区间内 detector 始终 trigger、维持 hold、绝不提前 clear/lift」才允许调大 MIN**。本次**没有正样本**(生产 host 合成内存压力有真 OOM 风险,7-09 事故先例,不做),故**不能**安全地调大 MIN。
3. debounce 已在合入前的 replay gate 里挡掉「MIN=0 会 page」的情形(本报告),它是结构性的时间维度区分,不依赖阈值猜得准。

**结论**:维持 MIN=0;debounce(N=120)是本单的结构性修复,busy-trace gate 以 MIN=0 通过。MIN 的进一步调大留给有正样本时的独立校准(或 FLY-517 多机根治)。

## 复现命令

```
# 采集(繁忙窗口,后台并行,只读 vm_stat)
node evidence-soak-collect.mjs ./soak.jsonl 30000 200
# 判定
node evidence-replay-gate.mjs ./soak.jsonl 0 120   # → GATE: PASS
node evidence-replay-gate.mjs ./soak.jsonl 0 0     # → GATE: FAIL(旧行为对照)
```
