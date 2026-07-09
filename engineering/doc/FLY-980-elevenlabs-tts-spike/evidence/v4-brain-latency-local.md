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

## 追加：常驻脑 / 预热实验（Lead 指令② —— 1-2s 能不能拉到）

**答案：拉不进 1-2s。** claude -p 形态的脑首 token 硬地板 ≈ 2-3.5s（模型
TTFT 本身），spawn 开销只占其中 ~0.8-1.0s。三形态实测（sonnet，5 轮中位）：

| 形态 | 中位首 token | 区间 | 说明 |
|------|--------------|------|------|
| baseline：每轮 spawn+立即写（fresh） | 3159ms | — | bench-brain.mjs |
| **persistent：单进程 `--input-format stream-json` 常驻** | 3294ms | 2206-3551 | 进程 init 831ms 只付一次，但每轮首 token 没变快 —— 地板是 API TTFT |
| **prespawn-fresh：提前 2.5s 起进程 + 全量历史注入** | **2974ms** | 2069-3813 | 最优中位；省下的 ~1s 冷启动被 TTFT 方差吃掉大半 |
| prespawn + --resume | 7766ms | 2283-14684 | resume 加载 + 方差爆炸，弃 |

分解归因（Lead 指令③的本地半边）：CLI 冷启动→首事件 ≈ 0.8-1.0s；其余
全部是 Anthropic API 经 CLI 的 TTFT。**要进 1-2s 只有换 API 直连形态
（违背 D10' 订阅要求，如实报，不偷切）或换更快的 serving 路径。**

## 追加：thinking 开关排查（Lead 指令①）

- 根因找到：本机全局 `~/.claude/settings.json` 有 `alwaysThinkingEnabled:
  true` + `effortLevel: xhigh`，每个 claude -p 子进程都继承。
- 但实测 **sonnet 对语音短答本来就不出 thinking**（first_thinking=None），
  `--settings '{"alwaysThinkingEnabled":false}'` / `--effort low` 均无收益
  （2623 vs 3566 vs 3446ms，噪声级）。
- **haiku 4.5 则默认每轮先吐 thinking 块**（首 thinking 3.1-5.5s 后才出
  文本）—— 这是 haiku 比 sonnet 慢的主因。结论：**选 sonnet 即绕开
  thinking 问题**，不需要额外开关。

### S4 真机测法（模型选择注记，Lead 指示 2026-07-08）

- **生产脑模型是 founder 的决定**（Annie 原话 sonnet/haiku、最新倾向
  haiku）—— sonnet 更快只是数据，不是答案；报告里 present 成
  「最快选项待 founder 拍」。
- spike 可行性判定用 **sonnet + FLY980_RESUME=0（全量注入）作 best-case
  上界**（/eleven 到底行不行，先看上界）；haiku 档同矩阵一起测供拍板。
- prespawn 优化只有 ~200ms 中位收益、复杂度不值，不进 shim。预计全链
  speech-end→首音 ≈ 脑 3.0s + 平台/隧道（echo 档实测补齐）≈ 3.7-4.5s ——
  **V5b soft timeout 垫话（边算边垫）能否救回 4s+ 体感 = /eleven 生死
  实验，S3 通后第一优先做**。

## 复现

```bash
cd engineering/spike/FLY-980-eleven
node bench-brain.mjs --turns 6         # 基线 6 配置 → out/bench-brain.json
node bench-warm.mjs --model sonnet --turns 5   # 常驻/预热 → out/bench-warm.json
node bench-warm.mjs --model sonnet --turns 5 --modes prespawn-fresh
```

样本量注：每配置 5 个 2+ 轮样本（Opus 2 轮），中位数稳健但非大样本；
S4 平台真机每格 ≥5 轮会再验证一遍脑侧分量（shim jsonl 自动打点）。
