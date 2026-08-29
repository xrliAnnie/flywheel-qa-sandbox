# FLY-2126 Raya 语音链路 529 房标准场景 — 调研

Issue: FLY-2126 (https://linear.app/geoforge3d/issue/FLY-2126/rayae2e-把-raya-语音链路做成-529-房标准场景真-voice-进程tts-注入判据脚本化)
日期: 2026-08-28
基于: exploration.md

> 世界标记:[raya-2097] = raya worktree `raya-FLY-2097`(head `4a67508`,QA attempt 2 PASS 版);
> [raya-2031] = raya worktree `raya-FLY-2031`(FLY-2031 实施分支);[fw] = flywheel 本 worktree(基于 main `5ec16b227`)。
> 引用行号以上述版本为准,实施时须复核。

---

## 1. 被测对象:voice 进程的可观察面(判据只吃这些)

### 1.1 evidence 事件流(judge 的唯一输入之一)

- 落点:`RAYA_STATE_DIR/voice-evidence/events.jsonl`([raya-2097] `apps/voice/src/config.ts:405`)。
- 判据依赖的事件(均已在 FLY-2097 真机证据中实测出现):
  - `realtime_transcript {ts, role: "user"|"assistant", text, generation}` —— 逐字转写;
  - `spoken_exit_detected` —— 退出哨兵检测([raya-2097] `runtime.ts:675`);
  - `voice_exit {code, reason}` —— reason 区分 `"spoken-exit"` / `"last-human-left"` / `"sigterm"`(`runtime.ts:450`);
  - `spoken_exit_grace_capped` / `spoken_exit_cancelled`(`runtime.ts:742/765`)—— S1 要求为零。
- ⚠️ FLY-2097 attempt 2 §B 的更正必须继承:**Codex wire 日志计数不是送达证据**,judge 不许引用任何 wire 级计数。

### 1.2 启动合同

- CLI:`node apps/voice/dist/cli.js run`;`run` 启动先读 marker,不存在 ⇒ 输出 `{status:"voice_mode_not_requested"}` exit 0(`cli.ts:157`)。
- marker:`RAYA_STATE_DIR/voice-mode.requested`,JSON `{requestedAt: ISO, requestedBy: snowflake}`(contracts `voice-mode.ts:17–38`;0600 temp+rename 原子写)。harness 每场自己写。
- 必需 env(contracts `integration-contract.ts:21–36`):`RAYA_CODEX_BIN/HOME/CWD`、`RAYA_WORKSPACE_ROOTS_JSON`、`RAYA_IDENTITY_FILE`、`RAYA_MEMORY_FILE`、`RAYA_OPENAI_API_KEY`、`RAYA_DISCORD_GUILD_ID`、`RAYA_DISCORD_VOICE_CHANNEL_ID`、`RAYA_DISCORD_TEXT_CHANNEL_ID`、`RAYA_FOUNDER_DISCORD_USER_ID`、`RAYA_BOT_TOKEN`、`RAYA_METRICS_DIR`、`RAYA_STATE_DIR`。
- 可选 env(同文件 :38–42):`RAYA_SESSION_TRIGGER_USER_IDS_JSON`、`RAYA_VOICE_QA_ALLOW_USER_IDS_JSON`、`RAYA_VOICE_OPTIONS_JSON`。
- QA 白名单:`RAYA_VOICE_QA_ALLOW_USER_IDS_JSON`(`config.ts:375–379`)—— emitter bot user id 放进去即被当作授权说话人。FLY-2097/2031 两轮 QA 都用了 `["1516207680836866219"]`。

### 1.3 指令注入通道(stage-0 阳性对照骑的腿)

- `RAYA_VOICE_OPTIONS_JSON.startInstructionsFile`(`config.ts:292–294`)→ `composeStartInstructions(fileContent, spokenExitEnabled)`(`config.ts:317–320`)把【退出语音的规则】块拼在自定义内容之后。
- 送达通道:自 `4a67508` 起走 realtime `prompt` 字段(FLY-2097 返工的唯一机制变更);旧字段 `realtimeStartInstructions` 在本机 Codex 上已被证明是死腿(attempt 1 根因)。
- ⇒ 阳性对照的写法与 FLY-2097 attempt 2 §B 完全一致:startInstructionsFile 换成英文-only 强指令,中文提问,判 assistant final 无 CJK。**对照失败 = 指令腿死 = INSTRUMENT_FAIL,不是行为 FAIL**。

### 1.4 spoken-exit 配置与判据参数

- `RAYA_VOICE_OPTIONS_JSON`:`spokenExitEnabled`(默认 true)、`spokenExitGraceMs`(1500)、`spokenExitDrainTimeoutMs`(5000,须 ≥ graceMs;`config.ts:296–314`)。
- FLY-2097 attempt 2 实测 detect→exit 延迟 1827–2127ms —— 判据窗口 `[graceMs, drainTimeoutMs]` 有实证锚点。
- 退出哨兵逐字:`好，退出语音模式。`;检测器只吃 assistant·final·当代(attempt 1 §2.3 真机确认过角色门)。

### 1.5 会话生命周期(单场 = 单进程)

- on-demand 模型:marker 在 → 进程起 → 连 Discord voice channel(公告「✅ 已进入语音模式…」)→ 授权用户说话 = Live → 最后一个人离房 `voice_exit{reason:"last-human-left"}` / 说退出哨兵 `voice_exit{reason:"spoken-exit"}` → 进程 exit 0。
- ⇒ **一场判据会话 = 一次进程生命周期**,天然的 per-session 隔离边界。launchd 的 `ThrottleInterval=60` 曾在 FLY-2097 造成 O1 观察(冷却期 kickstart 假失败);**直接 spawn 子进程可整类消掉**(见 plan Q6)。

## 2. 仪器:emitter 与 TTS

### 2.1 emitter([raya-2031] `probes/c9-voice-emitter{,-lib}.mjs`,193 行 lib + 单测)

- CLI 合同(`parseEmitterArgs`):`--bot-env <文件,唯一行 DISCORD_BOT_TOKEN=,强制 owner-only 0600> --bot-id --guild-id --channel-id --raya-bot-id --audio-file --evidence-file --mute-ms --response-timeout-ms`。
- lib 暴露**可组合原语**:`connect / play(path) / setSelfMute / waitForRayaAudio(userId, timeoutMs) / destroy` + `appendEmitterEvidence` —— 静默场(不 play 只等)、长超时场(委托后台)都能用原语拼,不必改 canned flow。
- 依赖:raya 仓的 `@discordjs/voice` + `discord.js`(经 `createRequire(apps/voice/package.json)` 解析)—— **这是 harness 主体必须放 raya 仓的硬理由**。
- 产出:emitter evidence.jsonl(含下行音频包计数)—— eligibility 判据的「downlink 包 > 0」一腿来自这里。

### 2.2 TTS 源

- FLY-2097/2031 均已实测:macOS `say -o <aiff>`(零成本)与 OpenAI TTS(wav)都能被 STT 正确转写(attempt 2 S1 5/5 即 TTS 注入达成)。QA 目录里现存两种素材(`emitter-source.aiff` / `emitter-openai.wav`)。
- 句子表 → 音频缓存:按 `sha256(text+voice+source)` 命名缓存文件,重复 run 不重复合成。

### 2.3 emitter bot 凭据

- emitter 需要一个**非 Raya 的 QA bot**(进房说话的一方):FLY-2097 用 flywheel-eng-lead 测试 bot。flywheel 侧 `~/.flywheel/.env` 有 `TEST_BOT_TOKEN_N` 池([fw] `scripts/test-deploy.sh:41–47`)。wrapper 负责把选定 token 落成 emitter `--bot-env` 格式(0600)。
- QA bot 须在 guild 内有目标语音房的 Connect/Speak 权限(FLY-2097/2031 已配置过的 bot 满足)。

## 3. 隔离配方(P1b/2031/2097 三处配方的合并事实)

| 项 | 配方 | 出处 |
|---|---|---|
| 凭据来源 | 生产 `~/.flywheel/raya/raya.env`,读取前强制 `(mode & 0o077) === 0` | [raya-2031] `probes/c0-lib.mjs:32–34` |
| 目录隔离 | `~/.flywheel/raya/qa/<id>/{state,metrics,logs,workspace,evidence}` 全套独立 | FLY-2097/2031 QA 目录实存 |
| Discord 隔离 | `RAYA_DISCORD_VOICE_CHANNEL_ID` + `TEXT_CHANNEL_ID` 都指到 voice-test 房(文字公告也不碰 `#raya`) | FLY-2097 QA plist |
| 进程隔离 | FLY-2031 形态:独立 label `com.xrli.raya.voice.fly2031.qa`,不碰 `~/Library/LaunchAgents/` | `~/.flywheel/raya/qa/FLY-2031/launchd/` |
| 被测 build | `RAYA_CODEX_CWD` / workspace roots / cli.js 路径全部指向被测 worktree 的 dist | 两轮 QA plist 同款 |
| 授权 | `RAYA_VOICE_QA_ALLOW_USER_IDS_JSON=[emitter bot user id]`;founder id 保持真值 | 同上 |

## 4. 529 家族约定([fw])

- 场景入口 = `scripts/` 独立脚本;纯函数抽 `scripts/lib/`;bash harness 测试放 `scripts/__tests__/`(`test-deploy-qa-room.test.sh` 等先例)。
- 并发锁先例:`test-deploy.sh` `claim_slot()` 的 mkdir 原子锁 + 陈旧检测(`test-deploy.sh:96–140`)。
- **本场景不需要 Bridge/Lead slot**:五项判据均不经 Linear/teamlead/Bridge;`test-deploy.sh` 的 slot 机制不复用,只抄锁模式。

## 5. 判据 ↔ 证据映射(全部来自 FLY-2097 已真机验证的人工判据)

| 判据 | 场次 | PASS 条件(judge 可执行) | 证据源 |
|---|---|---|---|
| C0 指令腿(前置) | 1 | assistant final(游标后)零 CJK 字符 | events.jsonl |
| C1 spoken-exit | N=5 | 每场:assistant final NFKC 含逐字哨兵 + `spoken_exit_detected` + `voice_exit{0,"spoken-exit"}` + detect→exit ∈ [graceMs, drainTimeoutMs] + 零 grace_capped/cancelled + marker 已清 | events.jsonl + state 目录 |
| C2 误退 0 | 3 反例 + 3 含糊 | 每场:零 `spoken_exit_detected`、`voice_exit.reason === "last-human-left"`;含糊场的确认问句只记录不作门 | events.jsonl |
| C3 静默窗 | 1(默认 40s) | 窗内零 user/assistant transcript、零检测、无异常退出 | events.jsonl + emitter evidence |
| C4 委托后台 | 1 | assistant final(归一化)含 canary nonce(nonce 只存在于 workspace 文件里,不在提问里) | events.jsonl + workspace fixture |
| C5 身份自称 | 1 | assistant final 含「Raya」;`我是 Codex` 类自称另记 advisory 不作门 | events.jsonl |
| eligibility(每场) | — | user final ≥1 + assistant final ≥1 + emitter 下行包 > 0;不齐 ⇒ INSTRUMENT_FAIL(可重跑,预算显式) | 双侧 evidence |

## 6. 依赖与缺口(如实)

| 项 | 现状 | 对本单的含义 |
|---|---|---|
| emitter 库 | 只在 raya `FLY-2031` 分支(未合 main) | 实施排序开放:(a) 排在 2031 合入后;(b) emitter 先行落 main。由 Lead 定;plan 按「可 import」写 |
| spoken-exit 协议 | 只在 raya `fly-2097-raya-voice-ux` 分支(PR raya#3,QA PASS 待 ship) | C1/C2 判据要求被测 build ≥ 2097;harness 对老 build 的 C1 会 FAIL —— 这是正确行为(回归尺) |
| `startInstructionsFile` | FLY-2074+ 已有 | C0 可用 |
| raya main HEAD | `0b954db`(老);生产跑 worktree build(raya-FLY-2074) | 场景的 `--raya-root` 必填,不默认 main |
| 静默场 emitter 形态 | canned `runEmitter` 是单发流;原语已够拼 | harness 用 lib 原语组场,不 fork canned flow |

## 7. 会过期的结论

| 结论 | as-of | 重核方式 |
|---|---|---|
| evidence 事件名/形状(§1.1) | raya `4a67508` | `grep -n "kind:" apps/voice/src/runtime.ts` |
| 必需/可选 env key 表(§1.2) | 同上 | `packages/contracts/src/integration-contract.ts` |
| 指令走 `prompt` 字段、旧字段死 | 同上 + 本机 Codex 0.150.x | 换 Codex 版本后重跑 C0 即知(这正是 C0 存在的意义) |
| emitter CLI 合同(§2.1) | raya-2031 worktree 现状 | 2031 合入后以 main 为准 |
| voice-test-2/3 房 id | Lead 2026-08-27/28 | 房间变动以 Lead 最新指令为准 |
| `TEST_BOT_TOKEN_N` 池在 `~/.flywheel/.env` | fw main `5ec16b227` | `scripts/test-deploy.sh` 头部 |
