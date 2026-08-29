# FLY-2126 Raya 语音链路 529 房标准场景 — 探索

Issue: FLY-2126 (https://linear.app/geoforge3d/issue/FLY-2126/rayae2e-把-raya-语音链路做成-529-房标准场景真-voice-进程tts-注入判据脚本化)
日期: 2026-08-28
基于: 无(上游素材为 FLY-2097 QA 报告与 FLY-2031 隔离配方,见 §2)

---

## 1. 问题与动机

Founder 2026-08-28 在 FLY-2097 QA 报告页问:「你觉得有必要把 Raya 做成 Flywheel 的 529 房场景吗?」Lead 判:有必要,本单 track。

**实证动机(FLY-2097 两轮真机 QA)**:为了验语音语义门,QA runner 每单手搓一次性台架,重复发明同样的四大件:

| 部件 | FLY-2097 的手搓形态 | 每单重复成本 |
|---|---|---|
| ① 隔离拉起真 voice 进程 | launchctl **生产固定 label 改绑**(`com.xrli.raya.voice` 指到 QA plist) | 每次都要 Lead 审批边界:≤15min 窗口 + 四条硬边界 + byte-identical 复原证明 |
| ② TTS 注入 | 手写 emitter(QA bot 进语音房播放合成音频、录 downlink 包计数) | 每单重写/重调;FLY-2031 已演化出参数化版本但未成标准件 |
| ③ 逐字转写取证 | voice 进程自己的 evidence.jsonl + emitter evidence 人工比对 | 判据(逐字哨兵/误退/静默窗)人工核,一场一场看 |
| ④ A/B 对照探针 | 英文-only 阳性对照(证指令腿活着)+ 新旧 build 对照 | attempt 1 因为没先跑对照,把「指令腿死」误读成行为问题,烧掉一整轮 |

**代价已经发生两次**(attempt 1 + attempt 2 各搭一次),且 FLY-2030/2031/2032 等在飞 Raya 语音单的 QA 节点都会再付一遍。

## 2. 素材盘点(已实证可用的资产)

### 2.1 FLY-2097 QA 报告(`flywheel-FLY-2097` 分支 `engineering/doc/FLY-2097-voice-mode-commands/qa-report.md`)

- **语义判据的完整定义与真机通过记录**(attempt 2, head `4a67508`):
  - S1 明确退出 5/5:五句不同措辞 → assistant final **逐字** `好，退出语音模式。` → `spoken_exit_detected` → `voice_exit{code:0, reason:"spoken-exit"}`;detect→exit 延迟 1827–2127ms(1.5s 安静窗被遵守,< 5s drain 上限)。
  - S2 意图相反 0/3 误退;S3 含糊 0/3 误退(确认问句只记录不作门)。
  - 静默窗 40s:无 transcript、无检测、无异常退出。
  - eligibility 判据:user final + assistant final + downlink 音频包 > 0 三者齐才算一场有效场次。
- **英文阳性对照**:`You must ALWAYS reply in English only. Never use Chinese` + 中文问水果 → 英文回答 = 指令腿活;中文回答 = 指令腿死。这是 attempt 1 → attempt 2 的承重腿。
- **A/B 对照素材**:身份自称(「你是谁」→ 自称 Raya 2/2 vs 自称 Codex 0/2)、委托后台(「后台数工程目录文件」→ 2/2 成功)。
- **现成阴性对照 build**:raya `46b5b6b`(`realtimeStartInstructions` 死字段版)—— 指令腿死的实锤版本,可以用来证明尺子能区分。
- **wire 计数已被证明不是送达证据**(attempt 2 §B 更正)—— 判据脚本化时不许把 wire 日志计数当判据。

### 2.2 FLY-2031 隔离配方(`~/.flywheel/raya/qa/FLY-2031/` + raya `raya-FLY-2031` worktree)

- **独立 QA label 形态**:`com.xrli.raya.voice.fly2031.qa` 独立 plist,RunAtLoad,隔离 `state/metrics/logs/workspace/launchd` 目录 —— **不碰生产 label,零审批成本**。这直接消掉 FLY-2097 手搓形态里最贵的那一格(①)。
- **P1b 隔离 env 配方**(probes/c0-lib.mjs):凭据从生产 `raya.env` 读(强制 0600 权限校验),但 probe 只取 Codex 侧 key(`RAYA_CODEX_BIN/HOME/CWD`、`RAYA_OPENAI_API_KEY`、workspace roots、identity/memory),**不取 `RAYA_BOT_TOKEN` / `RAYA_DISCORD_*`** —— 不碰 Discord 的探针腿。
- **参数化 emitter**(`probes/c9-voice-emitter.mjs` + lib):`--bot-env <DISCORD_BOT_TOKEN 文件,0600 校验> --bot-id --guild-id --channel-id --raya-bot-id --audio-file --evidence-file --mute-ms --response-timeout-ms`;进语音房播音频、观测 Raya 下行、写 evidence.jsonl。**依赖 raya 仓的 @discordjs/voice / discord.js**。
- **QA 授权白名单**:`RAYA_VOICE_QA_ALLOW_USER_IDS_JSON`(voice config 已支持,FLY-2074+ 分支)—— 让 emitter bot 的 user id 被当作授权说话人。

### 2.3 529 房家族现状(flywheel 主仓)

- 家族入口都是 `scripts/` 下的独立场景脚本(`qa-529-generalized-e2e.mjs`、`qa-fly-529-alert-smoke.sh`、`qa-fly-529-roundtable-smoke.sh`…),配 `scripts/lib/` 纯函数库 + `scripts/__tests__/` bash harness 测试。
- `test-deploy.sh` 起的是 **Bridge + Lead slot**(Discord 文字面)。Raya 语音场景**不需要 Bridge/Lead slot**:判据全在 voice 进程行为层(spoken-exit / 误退 / 静默窗 / 委托后台 / 身份自称),既不需要 Linear 也不需要 teamlead。ship-approval(P3)才需要 Bridge,不在本单判据清单里。
- 语音验收房已建好:`voice-test-2`(1542708795720081408,FLY-2031 在用)、`voice-test-3`(1542709028742893699,FLY-2097 用过)。

## 3. 目标与非目标(探索版)

### 3.1 目标

**529 房新增标准场景 `raya-voice`**:一条命令 → 拉起真 voice 进程(隔离 plist/env,独立 QA label)+ 真 Discord 语音房 + TTS 注入逐场跑 + 判据脚本化 → 证据包 + verdict。

判据清单(issue 点名的五项,全部来自 FLY-2097 已真机验证过的人工判据):
1. **spoken-exit 逐字**(S1:N/N 逐字哨兵 + 事件链 + 延迟窗)
2. **误退 0**(S2 反例 + S3 含糊:0 误退)
3. **静默窗**(N 秒静默无自发行为)
4. **委托后台**(canary 委托,assistant final 含 canary 结果)
5. **身份自称**(自称 Raya、不自称 Codex)

外加一条**结构性前置**:英文阳性对照(指令腿活性探针)—— FLY-2097 O2 教训固化进场景本体。

### 3.2 非目标

- **brain→launchctl 固定 label 链路**(slash 命令、文字口令、marker kickstart、逃生梯三格)—— FLY-2097 attempt 1 已真机全过,且这条链才需要生产 label 改绑;要做是另一个场景,本单不背。
- **founder 听感 / 真人声轮次**(FLY-2031 §5.6.1b 成色纪律:纯 TTS 会给假结论的那一格)—— 本场景定位是回归/QA 自动化,真人声验收仍是人工轮次。
- **ship-approval(P3 / Bridge `/api/voice/ship-approval`)** —— 需要 Bridge + gate 绑定,依赖面完全不同。
- **不改 raya 产品代码**(判据只读 evidence,不为可测性改产品 —— 「别为了让尺子量得到而改被量的产物」)。

## 4. 方案空间

### Q1 隔离形态:生产 label 改绑 vs 独立 QA label?

| | A. 生产 label 改绑(FLY-2097 形态) | B. 独立 QA label(FLY-2031 形态)⭐ |
|---|---|---|
| 覆盖面 | 能测 brain→kickstart 固定 label 链路 | 只测 voice 进程本体行为 |
| 审批成本 | 每次 Lead 批 15min 窗 + 四条硬边界 | 零(不碰生产任何文件) |
| 风险 | 复原失败 = 生产语音瘫痪 | 结构性零风险(从不读写 `~/Library/LaunchAgents/`) |
| 本单判据需要哪个 | 不需要 | 够用 |

**选 B**。本单五项判据全部不经过 brain;改绑形态的存在意义(固定 label 链路)已划入非目标。场景脚本**结构性不碰生产**:不读写 `~/Library/LaunchAgents/`、不 bootout `com.xrli.raya.voice`,teardown 只处理自己的 QA label。

### Q2 harness 主体放哪个仓?

| | A. 全在 flywheel 仓 | B. 主体在 raya 仓 + flywheel 薄入口 ⭐ | C. 全在 raya 仓 |
|---|---|---|---|
| 依赖 | 要把 @discordjs/voice/opus 等语音重依赖搬进 flywheel | emitter/判据留在依赖所在地 | 同 B |
| 版本耦合 | 判据与被测代码跨仓漂移(spoken-exit 哨兵语句改了,flywheel 判据不知道) | 判据与产品合同同仓同版本,同 PR 更新 | 同 B |
| 529 家族归属 | 天然 | wrapper 落 `scripts/qa-raya-voice.sh` + 场景登记 | 529 家族里没有入口,QA runner 不易发现 |
| 反面 | 重依赖 + 漂移 | 双仓 PR(FLY-2097 先例:flywheel issue + raya PR,已走通) | 无 flywheel 侧存在感 |

**选 B**:judges/emitter/orchestrator 在 raya 仓 `scripts/qa/`(与被测合同同版本演化);flywheel 仓给 529 家族入口 wrapper(解析 raya root、核 dist、组 emitter bot env、透传退出码)+ 场景文档登记。wrapper **不复制任何判据逻辑**,漂移面收敛为 CLI 合同一条线。

### Q3 判据引擎形态:实时断言 vs 事后读 evidence?

**选事后读 evidence(离线 judge)**:每场跑完后,judge 纯函数读 voice evidence.jsonl + emitter evidence.jsonl,输出该场 verdict。理由:
- 判据可单测(拿 FLY-2097 真 evidence 形状做 fixture,不用起真会话);
- 判据与采集解耦,失败场次可以拿着证据复判;
- 「检测器 ≠ 被检者」:judge 不在 voice 进程里,不给产品加可测性钩子。

### Q4 TTS→STT 非确定性怎么处理?

TTS 注入后模型听错/STT 错译是物理现实。FLY-2097 的处理是 eligibility 门(user final + assistant final + downlink 包 > 0 齐才算数)。场景固化为**三态 verdict**:
- **PASS / FAIL**:场次 eligible 且判据判定;
- **INSTRUMENT_FAIL**:场次不 eligible(采集/注入侧问题)→ 允许有限重跑(预算显式、重跑次数如实进 verdict),不计入语义门。
防止两个方向的误报:harness 坏 ≠ 产品 FAIL(阳性对照本身也要有对照);重跑也不许掩盖真 FAIL(eligible 的 FAIL 不许重跑洗绿)。

### Q5 场景自身怎么验收?(尺子先证能区分)

天然素材已备齐:
- **正对照**:raya `4a67508`(FLY-2097 attempt 2 PASS head)→ 场景全绿,且与人工 QA 结论一致 = 判据脚本化对齐人工判据;
- **阴对照**:raya `46b5b6b`(attempt 1 FAIL head,指令腿死)→ stage-0 阳性对照必须报 INSTRUMENT_FAIL/指令腿死(而不是把 S1 判成行为 FAIL)= 尺子能区分「腿死」和「行为错」。

## 5. 依赖与排序(open,交 Lead)

- **emitter 目前只在 raya `FLY-2031` 分支**(probes/c9-voice-emitter*.mjs)。本单实施节点的排序选项:(a) 排在 FLY-2031 合入 raya main 之后,直接复用;(b) 与 2031 协调把 emitter 库先行落 main。设计不押注哪条,实施计划按「emitter 已可 import」写,排序由 Lead 定。
- `RAYA_VOICE_QA_ALLOW_USER_IDS_JSON` 在 FLY-2074+ 分支已支持,raya main 老 HEAD(`0b954db`)没有 —— 但生产实际跑的是 worktree build(raya-FLY-2074),被测对象总是 ≥2074 的 build,此前提成立。

## 6. 结论

方向:**独立 QA label + raya 仓 harness + flywheel 薄入口 + 离线 judge + 三态 verdict + 阳性/阴性对照自验收**。细节进 research(现有代码事实核对)与 plan(模块/接口/测试)。
