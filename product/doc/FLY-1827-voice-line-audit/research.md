# FLY-1827 Voice 线评估 — 调研方法与来源

Issue: FLY-1827 (https://linear.app/geoforge3d/issue/FLY-1827)
日期: 2026-08-17
基于: `exploration.md`(同文件夹)· 全部一手取证见 `audit.md`

> **本文件的分工**:这份写「**怎么查的、查了哪些源、每个源多可信、什么查不到**」。
> **不重复** `audit.md` 的结论 —— 那份是逐条出处台账。
> 三个月后有人接手时,这份回答的是「**我能不能相信上一个人查的东西,以及我该从哪继续查**」。

---

## 1. 检索策略

这单是**考古 + 时效核查**两种活的组合,用了两套不同方法。

### 1.1 考古(问题 ①②③)—— 三条互相独立的线索源

| 源 | 用来回答 | 为什么需要它 |
|---|---|---|
| **Linear**(MCP) | 聊过什么、决策与否决、issue 状态 | 唯一记录「Annie 说过什么」的地方 |
| **仓库文档**(`product/doc/` `engineering/doc/`) | PRD / 研究 / QA 记录的实体 | issue 描述常与实际产出不符 |
| **代码 + 运行时**(`packages/` `~/.flywheel/` `launchctl`) | **今天实际是什么状态** | 派单红线:「issue 描述与代码不符时**以代码为准**」 |

**三条必须交叉**。本单最重要的几个发现全部来自交叉而非单源:
- 「PRD 锁 `/meet`」(文档)vs「代码是 `/glaw`」(代码)→ 不符 #1
- 「FLY-545 = Done」(Linear)vs「其描述写着折进别单、最后一次 founder 结论是 FAIL ×2」(文档)→ 不符 #3
- 「voice 代码俱全」(代码)vs「无 launchd job / 无 huddle 配置」(运行时)→ 休眠结论

### 1.2 时效核查(问题 ④)—— 只认一手

派单明写「查官方,不要查二手转述」。执行时把来源分成三档并**在产物里逐条标注**:

| 档 | 含义 | 本单用例 |
|---|---|---|
| **一手** | 官方文档 / 官方公告 / **本机实测** | OpenAI 模型目录、changelog、`codex features list` |
| **二手** | 技术博客、社区聚合、新闻站 | Moshi/Kyutai 现状、Codex CLI 版本史 |
| **不可用** | 需要我没有的权限或工具 | Discord 聊天记录 |

**二手来源在 explainer 页面里被显式标注为二手**,不与一手混排。

---

## 2. 来源清单(可复核)

### 2.1 Linear

检索式(全部经 `list_issues`,每次 25–60 条):
`voice` · `Codex 语音` · `CoS 跨项目 总管 prioritization` · `Aunt Cass 总管 所有项目 主管` · `glaw huddle barge-in enablement`

逐单细读:FLY-542 / 906 / 968 / 997 / 1018 / 1034 / 1311 / 1347 / 1362 / 1443 / 1451 / 1453 / 212 / 545 / 546 / 1158

### 2.2 仓库文档

| 路径 | 价值 |
|---|---|
| `product/doc/FLY-906-voice-product-experience/prd.md` | **唯一一份成文的 Voice PRD**,42KB,含完整版本记录 v0.5→v0.17 |
| `product/doc/FLY-1443-codex-realtime-probe/` | Codex realtime 验证:`conclusion.md` 25KB + `evidence/` 20 项 + `probe.mjs` + `demo-voice.mjs` |
| `engineering/doc/FLY-1347-voice-measurement-pack/voice-measurement-pack.md` | **四条管线状态的最佳单一来源**(§0 一页速览),含 latency 基线与当时 load |
| `engineering/doc/FLY-968-voice-model-bakeoff/bakeoff.md` | 三家真机横评定稿,含被否方向的实测理由 |
| `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md` | `#leads-roundtable` 的定义与范围 |

### 2.3 运行时取证(本机,只读)

```bash
launchctl list | grep -i voice                    # → 只有 macOS 自带三个,无 flywheel voice job
ls ~/Library/LaunchAgents | grep -i voice         # → 无(该目录有 60+ 个 flywheel plist)
ps aux | grep voice-bridge                        # → 无进程
curl http://127.0.0.1:9878/health                 # → 无响应
grep -c huddle ~/.flywheel/projects.json          # → 0(voice-bridge fail-closed 的必需块)
codex --version                                   # → codex-cli 0.147.0
codex features list | grep realtime               # → realtime_conversation  under development  false
codex --help | grep -iE "voice|realtime"          # → 无输出
```

### 2.4 外部一手(Web)

| 来源 | 取到什么 |
|---|---|
| `developers.openai.com/api/docs/models/all` | 模型目录**无 `gpt-live-1`**(强否定证据) |
| `developers.openai.com/api/docs/changelog` | 2026-07-28 `gpt-live-transcribe` 进 API |
| `developers.openai.com/api/docs/models/gpt-live-transcribe` | 只做流式转写、只支持转写端点、$0.017/分钟 |
| `developers.openai.com/api/docs/models/gpt-realtime-2.1` | $32/$64 每 1M 音频 token、128k context |
| `community.openai.com`(OpenAI staff 帖) | 2.1 / 2.1-mini 于 2026-07-06 公告,p95 延迟 ≥25% |
| Google AI / Cloud 文档 | Gemini 2.5 Flash Native Audio 已 GA;`gemini-3.1-flash-live-preview` |

> `openai.com/index/introducing-gpt-live/` 返回 **403**,未取到。GPT-Live 未开放 API 的判定
> **不依赖**该页 —— 依赖的是模型目录里查不到,那是更强的否定证据。

---

## 3. 可靠性分级(接手的人请照这个信)

| 结论 | 强度 | 依据 |
|---|---|---|
| voice 线今天休眠 | **强** | 4 条独立运行时证据互不依赖 |
| FLY-906 PRD 存在且 Annie 批过 | **强** | 文件抬头 + 完整版本记录 |
| 四条管线状态 | **强** | measurement pack 是当时的一手 QA 记录 |
| GPT-Live API 未开放 | **强** | 官方模型目录否定 + changelog |
| Codex CLI 无正式语音功能 | **强** | 本机三条命令实测 |
| `/glaw` 未在生产配置跑过 | **中** | 所有 7 月起 projects.json 备份 huddle=0 + measurement pack 记为「待定」;**但这是缺席证据** |
| 「新 CoS」讨论无留档 | **中** | 4 次 Linear 检索 + 全仓 grep 零命中;**但我读不到 Discord** |
| 7/24 后 voice 为何停 | **无** | 查不到,无任何记录 |

---

## 4. 明确查不到的(不是没查,是查不了)

1. **Discord 聊天记录** —— 我没有任何读 Discord 历史消息的工具。
   Annie 明确让我看「我们的聊天记录」,这部分**必须由 Lead 或有读权限的人代做**。
   → 这直接导致「新 CoS 那次讨论」只能给出「Linear 与仓库零留档」,给不出「不存在」。
2. **`codex app-server generate-json-schema` 的 0.147.0 schema 级复核** ——
   Bash 权限被拒,**未执行,未绕行**。
3. **FLY-1311 情报包正文** —— 只在 `origin/rescue/FLY-1311-worktree-local-20260723`,未进 main;
   本单未展开读(可捞)。

---

## 5. 一个必须传下去的方法论教训

本单在核 FLY-1443 结论时连续犯了同形态的错,**接手的人复核任何「对照实验」时请照这三步走**:

1. **别把上游报告当结论来源。** 我照抄了原报告「无法隔离 version 与 voice」——那句是错的,
   它只比了 v2 vs v3,漏了自己 evidence 里 v1 vs v3 共用音色这一组。
2. **别把类型定义当运行时约束。** schema 里 `RealtimeVoice` 是所有音色的并集;
   per-version 合法性是 `thread/realtime/listVoices` 返回的**另一张运行时表**,且本机真的按它拦。
3. **🔴「共同固定 ≠ 受控」。** E1/D3 四字段三个逐字相同、三个 hash 全等 —— 看起来极硬,
   但两次**共同固定的 `transport=websocket` 本身就是错的**(v1/v3 都该走 WebRTC)。
   **共同的错误值不构成有效控制**,只是把整组实验关进了一个无效 regime。
   **自检问法:每个被我「固定住」的字段,这个固定值本身是不是有效的?**

> 最终真因由 FLY-1844 破:**v3 从来没被拒**,是 v1/v3 走 WebRTC 而探针全程只试了 websocket,
> `Voice session access denied.` 是协议不匹配的误导性报错。真 WebRTC + SDP offer 下 v3 在 `0.147.0` 上通,复现两次。
> **承重对照请用 FLY-1844 的 P1-vs-P6(只差 transport)与 P8-vs-P6(在对的 transport 上只差 version),不要用 E1/D3。**

---

## 6. 下一个人该从哪继续查

| 想回答 | 从哪起 |
|---|---|
| 「新 CoS」那次讨论的原文 | **Discord**(需 Lead 代捞);向 Annie 要时间锚点 |
| 7/24 后为什么停 | 只有 Annie 知道,直接问 |
| Codex 语音总管怎么落地 | **FLY-1844**(已派 runner);先读本文件夹 `audit.md` 的「📌 可直接引用块」两块 |
| FLY-1311 情报包内容 | `git show origin/rescue/FLY-1311-worktree-local-20260723 -- product/doc/FLY-1311-voice-qa-intel/` |
| 老四条管线要不要删 | `/eleven` 已立 **FLY-1843**;其余三条 Annie 定「暂留、之后看时候删」 |
