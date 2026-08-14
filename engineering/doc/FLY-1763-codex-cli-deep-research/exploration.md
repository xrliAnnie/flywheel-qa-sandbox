# FLY-1763 Codex CLI 能否直接跑 ChatGPT Deep Research — 探索

Issue: FLY-1763 (https://linear.app/geoforge3d/issue/FLY-1763/research-codex-cli-能否直接跑-chatgpt-deep-research替代浏览器路-codexchatgpt)
日期: 2026-08-13
基于: 无

---

## 1. Annie 的原问题

> 「我们现在都是用浏览器的方式来用 ChatGPT Deep Search。但理论上来说，现在 Code 和 ChatGPT 都已经 Unify 了，那是不是实际上用 CLI 就可以去做这个 ChatGPT 的 Deep Search，我们就不用这么麻烦了呢？」

拆成可证伪的三问：

1. codex CLI **有没有** deep research 能力（命令 / flag / 模型 / 工具）？
2. codex 的 **ChatGPT 账号授权** 能不能**到达** Deep Research 后端？
3. 若都不行，**最薄的替代**是什么？对 1751 这类工程调研够不够？

## 2. 为什么这问题值得问（现状痛点）

现行 `deep-research` skill（`~/.agents/skills/deep-research/`，Flywheel 自写）的链路：

```
Claude agent → claude-in-chrome MCP → headed Chrome（需登录态 + 每 session 交互配对）
             → chatgpt.com Deep Research UI（合成点击/键盘）
             → 原生 export 拿 markdown
```

脆点，全部是真实踩过的：

- 必须 **headed** Chrome + 只能连一个 browser + 每次要人点 "Connect"
- **串行**：chrome.debugger 单 client，一次只能跑一个 DR
- 8-13 晚实测：**取报告那半截在现版扩展上已坏**（合成点击进不了跨域 OOPIF），靠 conversation API 新路才绕通
- 整条链没有一步是无人值守的

如果 CLI 能直接发起，上面全部消失。所以这问题的价值很高——但也正因为价值高，**不能靠「看起来像」下结论**，必须一手证据。

## 3. 先摆假设（避免自己骗自己）

| # | 假设 | 若为真意味着 |
|---|------|-------------|
| A | 「Unify」是**产品/账号层**的合并（同一个 ChatGPT 账号能登 CLI），不等于**能力层**合并 | CLI 能用订阅付费，但能用哪些能力由后端 allowlist 决定 |
| B | Deep Research 是 **ChatGPT 的产品面**（一个长时程编排 agent），不是一个「模型」 | 就算能选到 DR 模型，也未必等于拿到那套编排 |
| C | OpenAI 平台侧确实有 `o3-deep-research` / `o4-mini-deep-research`，但走 **API key 计费**，与 ChatGPT Plus 订阅是两个钱包 | 「能跑」可能要另外掏钱，那就不叫「不用这么麻烦」了 |

这三条都要用证据打，不能用直觉。

## 4. 调查手法（每条都要一手证据）

不接受二手博客当权威。允许的证据源，按可信度排序：

1. **本机 codex 二进制 / 实跑输出**（最硬）——`--help` 全量、feature flag 全表、binary strings、真实 `codex exec` 的 JSONL 事件流、服务端返回的原文错误
2. **服务端下发的数据**——`~/.codex/models_cache.json`（ChatGPT 后端针对当前 auth 下发的模型目录）
3. **官方文档 / 官方 repo issue**——`developers.openai.com`、`github.com/openai/codex`

配套纪律：

- 每个 grep 结论必须有**阳性对照**（证明尺子没坏）
- 「工具说成功」不算证据，看**服务端原文**
- 模型自述「我有/没有 X 工具」是**弱证据**，必须落到可验证的物证
- 归因要有对照臂：A/B 同一分钟、同一 auth、只换一个变量

## 5. 红线（本单自持）

- 只读为主；实验用 `--ephemeral` + `-s read-only` + 独立 sandbox 目录，不碰生产配置
- 不动 codex profile 登录态；若 wrapper 自己轮转了，**先 save 再复原**并如实上报
- 不绕 ToS：非官方后端调用只记录「存在与否」，不做成配方
- 零生产代码改动

## 6. 期望产出形态

结论先行的 research.md：**行 / 不行 / 部分行**。

- 「行」→ 附真机跑通一例的完整配方（命令 + 输出留证），下一个人能照跑
- 「不行」→ 精确到**缺什么**：能力不存在 / 授权不覆盖 / 官方明确不支持——三者是不同的补救路径

相关：[[FLY-1751]]（这类工程调研是 DR 的典型消费方）
