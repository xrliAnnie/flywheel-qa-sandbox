# FLY-2866 Lead 声线写进配置 — 调研
Issue: FLY-2866 (https://linear.app/geoforge3d/issue/FLY-2866/语音声线-按-prd-把每个-lead-的声线写进配置projectsjson-realtimevoice现在-17-个全是-marin)
日期: 2026-09-24
基于: exploration.md

## 1. 实测方法

同一句话：「Annie 你好，我是 Tadashi，现在有两件事要你看。」10 个 PRD 声线都各录一遍。

| 组 | 引擎 / 模型 | 接入 | 次数 |
|---|---|---|---|
| A | GPT Live `gpt-live-1` | `wss://api.openai.com/v1/live/sessions`，`session.start` 带 `audio.output.voice`，再用 `session.commentary.append` 让它开口（协议同 FLY-2799 `91534ea9e`） | run2 10 + run3 10 + run4 6 + run5 5 = 31 |
| B-2.1 | Codex 0.156.1 app-server，realtime V2，`gpt-realtime-2.1` | `thread/realtime/start` 带 `voice`，再调 `thread/realtime/appendSpeech` | run2 10 + run6 3 = 13 |
| B-1.5 | 同上，模型换成 `gpt-realtime-1.5` | 同上 | run15 10 |
| 参照 | founder 8-21 听过的原样本 | `product/doc/FLY-1911-codex-voice-prototype/voices/*.mp3` | 10 |

密钥只从 `~/.flywheel/.env` 的 `OPENAI_API_KEY` 读取，只通过环境变量传递。证据文件已检查，密钥残留为 0。
没有接真实房间，也没有碰任何 Lead、Bridge 或生产配置。

测量项（脚本：`evidence/voice-probe.py`、`analyze.py`、`pitch.py`）：
- 服务端是否接受该声线：A 看 `session.started` 回显的 voice；B 看 `realtime/start` 是否成功、有没有出声。
- 中文准确度：把录音用 `gpt-4o-transcribe` 转回文字，只比较中文部分「你好我是现在有两件事要你看」的字错率。两个人名 ASR 转得五花八门（安妮、田中、直樹……），属于识别噪声，不计入。
- 音高：用 YIN 算法取有声帧基频的中位数，用来区分男声和女声。**用 founder 亲耳听过的原样本做校准**，不套教科书阈值。
- 语速：17 个音节（12 个汉字 + An-nie + Ta-da-shi）除以有声时长。

作废的一项：先试过让 `gpt-audio-1.5` 盲听，描述性别、年龄和口音。结果它把 marin、coral、sage、shimmer 全判成「男声」，校准失败，整项作废。原始输出留在 `evidence/run2|run3/judge.json`，结论里没有用。

## 2. 结果

### 能不能用

- **A（gpt-live-1）**：10/10 声线被接受，服务端都回显了同名 voice，也都出了声。
- **B（Codex 0.156.1 V2）**：2.1 和 1.5 两个模型上都是 10/10 出声，23 次正式录制全部完整。Codex 0.156.1 的 `RealtimeVoice` 枚举有 19 个值，比我们多出 arbor、breeze、cove、ember、juniper、maple、sol、spruce、vale 这 9 个。仓库的 `REALTIME_V2_VOICES`（`packages/teamlead/src/realtime-voices.ts`）只放行 10 个。多出来的 9 个不在本单范围内。

### 音高（Hz，中位数；多次录制逐个列出）

| 声线 | founder 原样本 | B-1.5 今天 | B-2.1 | A gpt-live-1 |
|---|---|---|---|---|
| alloy | 145 | 151 | 135 / 150 | 125 / 145 / 152 / 152 |
| ash | 112 | 101 | 126 | 100 / 101 / 102 |
| ballad | 154 | 156 | 178 | 138 / 174 |
| cedar | 135 | 123 | 141 | 129 / 130 / 148 |
| coral | 194 | 194 | 212 | 169 / 200 / 273 |
| echo | 97 | 110 | 132 | 107 / 118 / 119 |
| marin | 194 | 211 | 211 / 226 | 164 / 194 / 200 |
| sage | 185 | 197 | 222 | 188 / 211 |
| shimmer | 150 | 156 | 167 | 145 / 148 |
| verse | 138 | 133 | 158 / 177 | 156 / 163 / 188 |

读法：
- **B-1.5 和原样本对得上**，10 个声线都在 ±17 Hz 内。说明 founder 8 月听的就是 Realtime 家族的这套声线（Codex V2 通道；按 FLY-2032 research.md:61，V2 默认模型是 `gpt-realtime-1.5`）。这也是今天生产 legacy 链路用的模型。
- **alloy**：原样本本身就是 145 Hz，founder 当时判为「低沉」女声。新模型在 125–152 Hz，和原样本同一区间，**不算和预期不同**。
- **verse**：原样本 138 Hz，新模型高了 20–50 Hz（2.1 是 158–177 Hz，Live 是 156–188 Hz）。它分给了 Tadashi，**需要 founder 亲耳确认**。echo、ballad 在新模型上也高了约 20–40 Hz，但这两个没分给任何人。
- 其余声线的男女区间都没变：ash、echo、cedar 稳定在男声区，marin、coral、sage 稳定在女声区。

### 中文与稳定性

- 两个引擎上，中文主体的字错率基本都是 0。只有 run3 的 sage 和 verse 的 ASR 输出了繁体字，以及把「你好」听成「米豪」，这些是识别噪声：模型自己的输出转写是正确的。
- A 的语速更快：alloy、ballad、coral 的中位数在 6.3–7.2 字/秒，B 大多在 4.5–5.6 字/秒。
- A 的偶发问题（和声线无关，留给 FLY-2798 参考）：
  - 31 次里有 1 次整段没出声（run4 ballad）。
  - run2 按「静音 3 秒就断开」判定时，coral 和 echo 句尾被截。看起来是 Live 说到一半停顿超过 3 秒；改成 6 秒后，21 次都没有再截。

## 3. 配置绑定与生效方式

（只读审计，引用基于本分支 `637752fcc`）

- **摘要与回执**：
  - `lead-identity.ts` 的 `identityDigest` 字段清单里没有 `realtimeVoice`（`:123-139`、`:426-446`）。
  - summary 回执只比对 `summaryAssignmentDigest`（`summary-registry-migration.ts:473-491`），也不含它。
  - 整文件的 `projectsDigest` 只在同一次请求内部比较，或在 Lead 启动时取值后比较，没有长期存下来的副本需要重铸。
  - 唯一持久的整文件绑定是 raya 的 persona 门（`persona-startup-gate.ts:133-157`），但只在 raya 项目带 `personaProjection` 时生效。线上配置里没有这个字段，所以今天不生效。写入前要再核一次。
  - 结论：只改 `realtimeVoice` 不会让任何回执失配。
- **受控写入路径**：
  - `voice-host-configure.mjs` 会给所有 Lead 重新写 `voiceRoom` 和 `voiceModes`，也不接受逐 Lead 指定声线（`:305-309` 的 `candidate_scope_conflict`），**不能用**。
  - `lead-registry` 和 `LeadConfigRegistry` 都不写声线。
  - 所以写入时照现有写者的做法：持有 `projects.json.cfglock`（`scripts/flywheel-config-lock.sh` 的 `config_write_locked`），原子写（临时文件 → fsync → rename），写之前备份。
- **写后校验**（在已部署的主仓里跑）：
  - `node packages/teamlead/dist/bin/validate-projects.js ~/.flywheel/projects.json`
  - `node packages/flywheel-comm/dist/index.js summary-registry verify-activation --projects-file … --receipt-file ~/.flywheel/state/summary-registry/migration-receipt.json`
  - 对 3 个相关 Lead 跑 `lead-identity resolve`，确认 `identityDigest` 前后不变。
- **读取时机**：
  - Bridge 只在启动时 `loadProjects()` 一次（`packages/teamlead/src/index.ts:21`）。语音会话从内存里的 `input.projects` 取 `realtimeVoice ?? "marin"`（`voice-session-services.ts:232`），没有热加载。
  - voice-codex 只使用 Bridge 下发的 projection 里的声线（`cli.ts:266`）。
  - **所以改完要等 Bridge 重启才生效**：本单不重启，等定时部署（00:00 / 12:00）。
- **引擎 A**：
  - FLY-2798 分支（`6ee3c7dd2`）上，引擎 A 的声线来自进程级环境变量 `FLYWHEEL_VOICE_OPENAI_LIVE_VOICE`，默认 marin（`voice-core/src/config.ts:169-173`），**不读每个 Lead 的配置**。
  - 生产上没有设置 `FLYWHEEL_VOICE_ENGINE`，FLY-2798 也还没合并，所以今天跑的是 legacy 引擎，它会读这份配置。
  - 切到引擎 A 以后，要等 FLY-2863 / 2797 接上这份配置，声线才会按 Lead 分开。

## 4. 交付与停点

- founder 报告（线上版，音频做成附件）：https://fw-reports-356a6d.vercel.app/r/404cf3f87f1f3e997e444d913660cf8d/
  - 仓库版 `founder-voice-report.html` 内嵌了全部试听。托管页的 CSP 是 `default-src 'none'`，没有 media-src（`report-registry.ts:58`），放不了内嵌音频。所以把 6 段 mp3（`founder-attachments/`）交给 Lead，作为 Discord 附件一起发。
- 按工单第 3 步的要求，**停在这里等 founder 决定**。触发停点的原因有两个：
  1. verse 在新模型上音调明显偏高，是否仍给 Tadashi；
  2. 5 位男性人设 Lead 是否保持 marin（和「男性 Lead 用男声」规则冲突）。
