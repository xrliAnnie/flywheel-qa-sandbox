# FLY-980 V2-V5 — 端到端延迟阶梯 + 慢脑行为（真机）

Issue: FLY-980
日期: 2026-07-07/08（取证 PT 夜间；**机器负载 20-35**，全部绝对值偏悲观，
形态结论不受影响）
基于: plan.md §S4；agent=agent_7801...（已删）；隧道 cloudflared quick tunnel

## Verdict

- **V2 PASS**：echo 脑真机握手通过；平台+隧道基线 speech-end→首音
  **中位 179ms**（83/347/228/179/41，5 轮）—— 平台侧开销可忽略，
  全链延迟几乎 100% 是 claude -p 脑。
- **V4 测定**：claude 档全链「用户听到真答案」中位 **≈6.0s**（负载夜），
  「用户听到垫话」**≈3.0s**（soft timeout 配置值）。轻负载时段（V8 会话）
  脑侧 2.8-3.6s → 答案 ≈4s 可达。
- **V5a PASS**：turn_timeout 语义=用户静默端点（7s→11.1s 接话 vs
  15s→20.7s，差值≈配置差）；与慢 LLM 无关，坐实 research §2 更正。
- **V5b（生死实验）**：**soft timeout 垫话把体验从「断线」救回「能用」**——
  详见下文；另发现隐藏旋钮 `cascade_timeout_seconds`。

## 1. 全链阶梯（每档 5 轮，opus 2 轮；soft timeout 3s 开）

| 档 | 垫话首音（用户首次听到声）中位 | 真答案首音中位 | 逐轮答案(ms) |
|----|------|------|------|
| echo（基线） | **179ms**（即答案） | — | 83/347/228/179/41 |
| sonnet×全量注入 | 3006ms | **6067ms** | 6819/5917/6067/6858/5518 |
| sonnet×resume | 3029ms | 6063ms | 5749/6247/6063/6167/5297 |
| haiku×全量注入 | 2914ms | 5953ms | 5877/6846/5953/6706/5476 |
| haiku×resume | 3114ms | 6067ms | 6005/6554/6067/7055/5685 |
| opus×resume（铁证） | 2971ms | 6028ms | 6007/6050 |

口径：e2e-session.mjs 喂 16k PCM，事件流重建（音频段间隙>1.5s 分段：
段1=垫话，段2=真答案）。**负载夜各模型档差异被抹平**（重试动力学+负载主导）；
本地低负载基准（evidence/v4-brain-latency-local.md）才体现 sonnet 3.2s vs
haiku 5.6s 的模型差。

shim 侧脑 first_delta（同窗，负载夜）：haiku-resume 5.6-10.3s /
sonnet-resume 7.9-13.0s / v8 时段 2.8-5.0s —— 波动带宽极大，
**产品化必须按"垫话兜底 + 答案尽力"设计**。

## 2. V5b 慢脑行为 —— go/no-go 命门（对照实验）

### 关闭 soft timeout（默认态）

平台对 custom LLM 有 **~7.8s 硬超时**（=`cascade_timeout_seconds`，默认 8，
见 §3）：脑没在窗口内出首 token → **abort HTTP → 自动重试（多次）→
全部失败 → WS 1002 关会话**。实录：4 连 abort（t≈7.8-7.9s）→ 会话死。
**不开垫话 = 慢脑必死。**

### 开启 soft timeout（timeout_seconds=3，中文垫话×2）

- 垫话在 ~3s 准点播出（"稍等哈，我想一下。"/"嗯……让我理一理。"，
  randomize_fillers 生效）；
- 会话全程存活（5 轮零断连）；
- **硬超时不被垫话延长**（abort 仍在发生）——超窗的请求被 abort 重试，
  重试重付 spawn+TTFT，答案最终落 ~6s；
- 副作用实录：慢答案会跨进下一轮（用户已开始问下一句，上一句的答案才到）——
  产品化需在 shim 侧对 stale 回答做丢弃/衔接设计。

### 隐藏旋钮：`agent.prompt.cascade_timeout_seconds`

- 默认 **8**（=观测到的 ~7.8s abort），**API 可调，上限 15**（>15 被
  422 拒：`Input should be less than or equal to 15`）。
- 调到 15 后实测 abort 延至 12.8s+ —— 配合 3s 垫话，脑预算从 8s 扩到 15s，
  **正常负载下 sonnet/haiku 首 token（3-6s）稳定落窗内**。
- 推荐生产配方：cascade=15 + soft timeout 3s + max 2 垫话。

## 3. STT 观察（附带）

- 中文轮全对；专有名词波动："Huddle"→"哈豆/哈斗"、"FLY-968"→"Flight 968/
  Fly968"（V10 当时全对——平台 STT 版本随时间漂移，R4 佐证）；
- 英文轮逐字全对；
- eager endpointing 实录：英文轮平台在用户音频尾帧前 203ms 就开始回答
  （firstAudio=-203ms）。

## 复现

```bash
cd engineering/spike/FLY-980-eleven
# 起 shim(claude 档) + cloudflared + create-agent 见 runbook.md
node e2e-session.mjs <agent_id> --label X --rounds u1,u2,u1,u2,u3en --wait-ms 40000 --tail-ms 6000
node v5a-silence.mjs <agent_id> tt7 22000   # V5a
node patch-agent.mjs <agent_id> '<soft_timeout_config json>'  # V5b 开关
# 原始数据: ~/fly980-eleven/e2e-archive/（jsonl+wav+results.json 全量）
```
