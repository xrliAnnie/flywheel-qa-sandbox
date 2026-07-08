# FLY-980 V4（部分）— claude -p 脑首 token 延迟矩阵（本地 shim 侧口径）

Issue: FLY-980
日期: 2026-07-07（取证 PT 晚间）
基于: plan.md §S4 V4；本文件只覆盖「脑首 token」分量 —— 全链
speech-end→首音口径待 S3/S4 平台真机补齐（等 ELEVENLABS_API_KEY）。

## Verdict（部分）: 脑侧数据已测定；最优配方 = sonnet + 全量注入 ≈ 3.2s 首 token

按判据带（≤1.2s 优 / ≤2s 可用 / >3s 难用）：**claude -p 所有配方的脑侧首
token 单独就已 ≥3.2s** —— 全链（+平台 STT/TTS ≈0.7s + 隧道往返）预计落在
4s+，进「难用带」。go/no-go 的最后变量 = V5b Soft timeout 垫话体验（平台
真机测）。

## 数据（每配置同一会话连打 6 轮；turn1 单列，2+ 轮取中位）

| 配置 | turn1 首 token | 2+ 轮中位首 token | 2+ 轮中位全轮 |
|------|---------------|-------------------|----------------|
| haiku × resume | 6815ms | 5635ms | 7609ms |
| haiku × 全量注入 | 6363ms | 7154ms | 10647ms |
| sonnet × resume | 4061ms | 4547ms | 8141ms |
| **sonnet × 全量注入** | **3391ms** | **3159ms** | **6201ms** |
| haiku × resume × MAX_THINKING_TOKENS=0 | 5376ms | 5479ms | 8156ms |
| opus × resume（铁证 2 轮） | 7639ms | 5225ms | 9507ms |

口径：客户端「POST 请求发出 → 首个 content SSE chunk」，本机回环（网络
≈0），含 claude CLI 冷启动（实测 ≈1.0s，每轮 spawn 都要付）+ 模型 API
TTFT + thinking。

## 发现

1. **sonnet 5 首 token 显著快于 haiku 4.5**（反直觉）：haiku 每轮先输出
   thinking 块再出文本；sonnet 的 thinking 更短/TTFT 更好。模型档选择上
   /eleven 应默认 sonnet 而非 haiku。
2. **全量注入(fresh) 对 sonnet 反而最快**：resume 有 session 加载开销；
   fresh 模式下 sonnet 3.2s 中位。haiku 则相反（fresh 7.2s 劣于 resume
   5.6s）—— 两模型的 resume/注入 权衡方向相反，不能一概而论。
3. `MAX_THINKING_TOKENS=0` 在 shim 全链里无显著改善（5479 vs 5635，噪声
   级）—— thinking 并未被完全禁用（stream 里仍见 thinking_delta）。
4. Opus 5.2-7.6s，符合 D9' 预期（founder 说的"Opus 对话会很慢"成立）。
5. 与 FLY-543 先验（Opus 满上下文 resume 全轮 6.5s）对照：空 cwd + 快模型
   把全轮从 6.5s 压到 sonnet 6.2s / 首 token 3.2s —— 有改善但没跨代。

## 复现

```bash
cd engineering/spike/FLY-980-eleven
node bench-brain.mjs --turns 6         # 全 6 配置
node bench-brain.mjs --configs sonnet-fresh --turns 6
# 原始逐轮数据: out/bench-brain.json
```

样本量注：每配置 5 个 2+ 轮样本（Opus 2 轮），中位数稳健但非大样本；
S4 平台真机每格 ≥5 轮会再验证一遍脑侧分量（shim jsonl 自动打点）。
