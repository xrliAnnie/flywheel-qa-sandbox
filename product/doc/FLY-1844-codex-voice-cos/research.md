# Research: Codex 语音总管的技术事实与证据 — FLY-1844

**Issue**: FLY-1844(https://linear.app/geoforge3d/issue/FLY-1844)
**日期**: 2026-08-17
**基于**: `exploration.md` · FLY-1451(产品定位 + Annie 逐字留档)· FLY-1443(七月的能力验证 + 探针资产)· FLY-1827(语音线考古)

> 本文只记录**技术事实与证据出处**。产品形态、优先级、拆单不在本单范围(FLY-1451 红线)。
>
> **文件夹导航**(doc-flow 三件套 + 两份附加):
> `exploration.md` 当时怎么想的 / 哪些假设被推翻 → **本文** 技术事实与证据 →
> `plan.md` 实现路径(并列选项 + 代价) · `decisions.md` Annie 的逐字决定 ·
> `implementation.html` founder 面说明 · `evidence/` 9 组原始实验记录
>
> 本文原名 `findings.md`,2026-08-17 按 doc-flow 正式命名改为 `research.md`(git mv,历史保留)。

---

## 结论(一句话)

**v3 realtime 没有被服务端拒绝过。**本账号在 `codex-cli 0.147.0` 上开 v3 会话成功,独立复现 2 次。
七月记录的 `Voice session access denied` 是**用 websocket transport 去要 v3** 的产物 —— v3 走的是 WebRTC。

---

## 1. 实验矩阵(全部在 0.147.0 上跑,2026-08-17)

环境 pin(由探针自己 resolve + 自算 hash 写进 manifest,非调用方声明):

```
codexResolved  /Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.147.0-aarch64-apple-darwin/bin/codex
codexSha256    19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37
codexArgv      <resolved> --enable realtime_conversation app-server
auth           auth.json 的 OPENAI_API_KEY 为 null(纯订阅身份,全程未配置/未改动)
```

> ⚠️ 复现时请 pin 上面的 versioned 绝对路径。`~/.local/bin/codex` 是被争用的可变 symlink
> (FLY-1443 §3.1 记录它在反复摆动);本次实测它指向 `.codex-mufasa/.../current` → 0.147.0。

| # | version | voice | modality | transport | 结果 | 后端/本机原话 |
|---|---------|-------|----------|-----------|------|--------------|
| P1 | v3 | cove | audio | websocket | 拒 | `stream disconnected before completion: Voice session access denied.` |
| P2 | v2 | marin | audio | websocket | **started** | — (账号健康对照) |
| P3 | v1 | cove | audio | websocket | 拒 | `failed to send realtime request: Connection closed normally` |
| P4 | v3 | cove | **text** | websocket | 本机拦 | `text realtime output modality requires realtime v2` |
| P5 | v3 | cove | audio | webrtc(无 sdp) | 请求即拒 | `-32600 Invalid request: missing field \`sdp\`` |
| **P6** | **v3** | **cove** | **audio** | **webrtc(真 SDP)** | **started** | 收到 `thread/realtime/started` + `version:"v3"` + 后端 SDP answer |
| **P7** | **v3** | **cove** | **audio** | **webrtc(真 SDP)** | **started** | 独立复现,另一个 thread |
| P8 | v1 | cove | audio | webrtc(真 SDP) | 拒 | 后端结构化 JSON:`AVAS requires OpenAI-Alpha: quicksilver=v2.` code `invalid_quicksilver_alpha_header` |
| P9 | v3 | marin | audio | webrtc(真 SDP) | 本机拦 | `realtime voice \`marin\` is not supported for v3; supported voices: juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove` |

P6/P7 的 SDP offer 由 `werift`(纯 TS WebRTC,装在 scratchpad,未进仓库依赖)生成,
`m=audio` 行存在,offer/answer 均记 sha256。

### 只差一个变量的两组对照(判据:Lead 定的「只有一个变量不同的两次运行才叫对照」)

上表 9 组里,真正承担结论的是这两组。其余是边界探测或健康检查,**不作对照用**。

| 对照 | 固定不变 | 唯一变量 | 结果 |
|---|---|---|---|
| **A · 隔离 transport** | version=v3 · voice=cove · modality=audio | websocket → **webrtc** | P1 拒 → **P6/P7 started** |
| **B · 隔离 version** | voice=cove · modality=audio · transport=webrtc | v1 → **v3** | P8 拒(结构化 JSON)→ **P6 started** |

A 证明**被拒的原因是 transport,不是账号权限**。
B 之所以成立,是因为 **v1 与 v3 共用同一张音色单**(`cove` 在其中)—— 换句话说 version **是**可以被单独隔离的。

**不成对照的组合**(明确标出,免得被误引):P1 vs P2 同时变了 version 与 voice(v3/cove ↔ v2/marin),
是两个变量,只能当「账号健康」的旁证,不能用来归因。

## 2. 为什么七月会看错 —— 二进制里的结构性事实

`strings` 扫 0.147.0 二进制(读取,未修改):

```
AVAS realtime calls require realtime v1 or v3      ← v1/v3 = "calls" 路径
/backend-api … realtime/calls
multipart/form-data; boundary=codex-realtime-call-boundary
Content-Disposition: form-data; name="sdp"          ← SDP offer 以 multipart POST
[BACKEND] v1v2v3, quicksilver=v1 / quicksilver=v2
/v1/realtime  ws wss                                ← API-key 的 websocket 路径
codex-api/src/endpoint/realtime_websocket/methods.rs
```

⇒ **v1/v3 = WebRTC「calls」路径;v2 = websocket 路径。**
FLY-1443 的探针按 issue 要求只用 websocket(「优先试 WebSocket,不用 WebRTC 栈」),
因此结构上不可能拿到 v1/v3 的准入。这是**实验设计盲区,不是数据问题**。

### 字符串溯源(与 FLY-1443 同法,同样的边界)

| 字符串 | 0.147.0 命中 |
|---|---|
| `Voice session access denied` | **0** → 强推论 server-originated |
| `stream disconnected before completion` | 1 → 本机包装词 |
| `failed to start realtime conversation` | 1 → 本机包装词 |
| `Quicksilver sessions require WebRTC` | 0 → 该 0.145.0 文案在 0.147.0 已不存在 |

P8 证明:后端**确实会**原样透传结构化 JSON 错误。`Voice session access denied` 是纯文本、
经 websocket 路径返回 —— 与 P8 的形态不同。这支持「它是 websocket endpoint 对 v3 的拒绝」,
但**未做 wire-level 抓包,不作更强断言**。

## 3. 对三处前提的更正

1. **FLY-1451 称旧归因不可靠(理由:schema 里 cove 与 marin 同一张单)——** 这是误读。
   `thread/realtime/listVoices` 返回的是**分版本子集**(v1/v2 两张单),schema 的 `RealtimeVoice`
   只是全集类型联合。P9 的运行时报错逐字证明 **v3 用的是 v1 那张单,`cove` 合法**。
   七月的 D3 干净对照正是用 cove 跑的 → 越过本地校验 → 拿到服务端的话。**旧证据比转述更硬。**
2. **旧报告并未把拒绝归因于 version**(§2.3 原文:「现有证据不能进一步归因」)——
   这个克制是对的,**但它给出的理由是错的,不要当权威引用**。
   §2.3 说「v2 与 v3 音色集不重叠 ⇒ 无法把 version 与 voice 隔离开」。
   这句在 *v2-vs-v3* 这个比法内成立,却被写成了一个死结 —— **换成 v1-vs-v3 就能隔离**(共用同一张音色单),
   即本单的对照 B。⇒ 引旧 evidence 时请引 **E1/D3 那组参数对照**,不要引 §2.3 那句推理。
   更关键的是:真正的混淆变量**根本不是 voice,是 transport**,而当时没有任何一组变过它。
3. **FLY-1443 §4.5 留的 follow-up「换 API key 能不能开 v3」可以关掉** —— 不需要。
   纯订阅身份(`OPENAI_API_KEY = null`)即可开 v3。

## 4. 实现路径的代码级核实(只读)

| 块 | 核实结果 | 出处 |
|---|---|---|
| 嘴/耳朵 | Codex 自带,headless 可跑(纯 stdio JSON-RPC,不碰系统音频设备) | FLY-1443 C1/C2 全链;本单 P6/P7 |
| CLI 入口 | **无** voice/realtime 子命令;`features list` = `under development` | `codex --help`、`features list` 实测 |
| 脑子 | Codex-as-Lead 是既有生产形态:16 Lead 中 **2 个** `backend: codex-app-server`(mufasa-lead / codex-infra-bot-lead,均 `canSpawnRunners:false`) | `~/.flywheel/projects.json` |
| 脑子(跑法) | 三档 profile:`read-only`(companion)/ `write-capable`(Z,headless-only,带 gateway+broker)/ `full-access`(Claude-equal,无 confinement);TUI 启动器已上线 | `codex-lead-runtime.ts:195-199`、`codex-lead-tui-runtime.ts:839-845`、`run-codex-lead-mufasa-tui-fullaccess.sh` |
| Discord 语音腿 | `packages/voice-bridge` 13,225 行,已有 joinVoiceChannel / DAVE opus 解密 / EarsReceiver / LeadSpeaker / barge-in / BrainPort | 包内实测 |
| Discord 语音腿(部署) | **今天零运行**:无 launchd plist、无进程、`projects.json` 中 `huddle` 块数 = **0**(config fail-closed) | 本单独立复核,与 FLY-1827 ③ 一致 |
| 接 Codex 的缝 | `BrainPort` 是 **text-in / text-stream-out** loopback(Bearer + 127.0.0.1);Gemini 走 audio-direct 无文本缝 | `src/brain/BrainPort.ts` |
| 跨 Lead 情报面 | A 舰队快照 `/api/fleet/snapshot`(loopback 免 token,含 leads.online + dags)· B Linear · C `terminal-mcp`(`runner_terminal_capture/search/list/status`)· D `flywheel-comm ask`。另有 `/api/sessions` `/api/runs`(需 token)、`/api/standup`、`/api/digest`、`/api/voice/*`(FLY-546 耳机 daemon 的 Bridge 面) | Bridge 路由实测 + 活体探测 |

## 5. 安全前置(FLY-1453)的今日状态 —— 比 issue 记录的更差

FLY-1453 指出 `sandbox_mode=workspace-write` 只管写不管读 → 凭据可经回复外泄。

- FLY-260 曾实现「read-deny hardening for read-only Codex Leads」(PR #286,独立 QA PASS,PR #287)。
- **该机制随后被 FLY-1241 删除**(`123da93cf chore(FLY-1241): delete codex_lead_read_deny flag + read-deny-profile.ts + content-coordination profile (#589)`)。
- 今日全仓 grep `readDeny|read-deny|denyRead|READ_DENY|sandbox_permissions`:**生产代码零命中**
  (只剩 `codex-lead-runtime.ts:219` 一句注释「read/exfil surface is FLY-260, out of scope here;
  the guarantee here is WRITE」,以及 `qa-fly310/` 下的历史 QA 脚本)。

⇒ **今天没有任何一档 Codex Lead 约束读取。**FLY-1453 的前置完全敞着,且已上线的 companion Lead 也在此面内。

## 6. 未验清单(按缺什么分类)

**缺权限/授权**:① 安全执行边界(FLY-1453,设计题)② 点亮 voice-bridge(要改生产 `projects.json`)

**缺真机**:③ v3 的音质/延迟/barge-in(本单只验准入,**没让它说过一句话**)④ 长会话稳定性、断线重连
⑤ Codex 的嘴接进 Discord 语音房(两端现成,**从未接过**)⑥ v3 上「边说边真执行命令」(七月在 v2 上验过)

**缺外部信息**:⑦ `realtime_conversation` 何时转正(协议可变)⑧ v3 的用量/限流天花板

## 7. 纪律

- 全程裸 `codex`,未用 `codex-with-fallback`;未调用 `codex-profile`,未切账号。
- **未写** `~/.codex/config.toml`(mtime 仍为 2026-08-14 01:05:39,早于全部实验);只用 `--enable` 单次生效。
- 未改任何生产代码/配置,未启动任何服务。`werift` 只装在 scratchpad,未进仓库依赖。
- 每次会话拿到 `started`/`error` 即 `stop`,**零 model turn**,额度消耗≈0。进程均已退出(每份日志末尾有 `EXIT`)。
- 证据日志性质:**探针事件日志**,非逐字节 raw stdout(过滤 `mcpServer/*` 噪声、SDP/音频以 sha256 记录)。
- 已扫无凭据泄漏。

## 8. 证据清单

| 文件 | 内容 |
|---|---|
| `evidence/admit.mjs` | 只测准入的探针(websocket) |
| `evidence/admit-webrtc.mjs` | 同上 + 真 SDP offer(WebRTC) |
| `evidence/P1-v3-cove-audio.jsonl` + `P1-manifest.json` | v3/websocket → access denied(0.147.0 复现七月现象) |
| `evidence/P2-v2-marin-audio.jsonl` + manifest | v2/websocket → started(账号健康对照) |
| `evidence/P3-v1-cove-audio-ws.jsonl` + manifest | v1/websocket → 连接被关 |
| `evidence/P4-v3-cove-text.jsonl` + manifest | v3+text → 本机拦(v3 仅 audio) |
| `evidence/P5-v3-cove-audio-webrtc.jsonl` + manifest | webrtc 无 sdp → 请求即拒(证明 sdp 必填) |
| **`evidence/P6-v3-webrtc.jsonl` + `P6-manifest.json`** | **v3/webrtc → started(翻案证据)** |
| **`evidence/P7-v3-webrtc-repro.jsonl` + manifest** | **v3/webrtc → started(独立复现)** |
| `evidence/P8-v1-webrtc.jsonl` + manifest | v1/webrtc → 后端结构化 JSON 拒绝 |
| `evidence/P9-v3-webrtc-marin.jsonl` + manifest | v3+marin → 本机音色校验(证实 v3 用 v1 音色单) |
| `implementation.html` | founder 面说明(可留 comment + 一键复制) |

`implementation.html` 交付前实测:proofshot 视口(`DEFAULT_REPORT_SHOT_WIDTH = 860`)下高度 **5071px ≤ 6000**;
localStorage 持久化 PASS;复制成功路径 PASS;**复制失败路径**(同时打断 `navigator.clipboard` 与
`document.execCommand`)如实报「复制没成功」并回落到可手选文本,**未谎报成功**。
