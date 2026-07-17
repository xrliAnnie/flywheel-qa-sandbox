# FLY-1353 voice-rig 测量基建修缮 — 探索

Issue: FLY-1353 (https://linear.app/geoforge3d/issue/FLY-1353/voice-rig-测量基建修缮-presence-qa-seam窄布尔-e2e-脚本跟上-config-化-pack-42-更正hl-测量)
日期: 2026-07-17
基于: 无(上游为 HL /gemini 机器层测量第一轮实录 + FLY-1347 measurement pack)

## 1. 问题背景

HL 的 /gemini 机器层测量第一轮(2026-07-17)拿到了冒烟双 PASS(invoked→conversation
ready 0.64-0.77s),但声学全链(WAV 注入 → Gemini 听懂 → 回话音频干净)结构性跑不出。
三个实证发现对应本单三件事:presence gating 挡死 headless E2E、两个 gemini e2e rig
按仓库原样 crash、measurement pack §4.2/§0 有两处与实测不符。

## 2. 现状审计(逐条核实过代码)

### 2.1 presence gating 为什么挡死 headless E2E

- `AssistantSession.start()`(`packages/voice-bridge/src/assistant/AssistantSession.ts:249-268`):
  post-connect 查 `this.opts.voice.founderPresent()`;false 时**不 enterLive**,订阅
  onFounderJoin + 挂 no-show timer(`DEFAULT_FOUNDER_JOIN_MS`,10 分钟)→ 到时
  `abortNoShow()` 关 issue、关会话。
- `founderPresent()` 的实现在 `packages/voice-bridge/src/assistant/wiring.ts:361-367`:
  `humanCount > 0`。`humanCount` 由两条路供给:boot 时
  `deps.voiceChannelHumanCount(...)` seed(只数非 bot 成员)+
  `deps.onVoiceStateUpdate` 增量(`wiring.ts:194-211`,**`if (u.isBot) return` 直接
  过滤 bot**)。
- 结论:headless rig 里只有注入 bot 进 VC → `humanCount` 恒 0 → session 永停
  `invoked`,10 分钟后 no-show abort。**opening prompt 在 `enterLive()` 里才发**
  (`AssistantSession.ts:297-303`),所以连「开场→首音频」这段都测不到,遑论
  IN-leg/OUT-leg 声学判据。
- 现有 wiring env seam 只有两个:`FLYWHEEL_GEMINI_AUTOSTART`(`wiring.ts:483`,
  unset = 零行为变化,QA 注入哲学的既有范本)和 `FLYWHEEL_VOICE_IDENTITY`
  (voice-core 侧 brain persona)。presence 没有 seam。

### 2.2 两个 rig 的 crash 根因

`runVoiceBridge`(`packages/voice-bridge/src/cli.ts:105`)在 /glaw config 化
(FLY-545 era)后从 `config` 读四个字段:

- `cli.ts:276-277` → `new BridgeLinearClient({ bridgeUrl: config.bridgeUrl, apiToken: config.apiToken, ... })`
- `cli.ts:281-282` → `createGenaiTransport({ apiKey: config.geminiApiKey })` + `profile: { model: config.geminiModel }`

两个 rig(`packages/voice-bridge/e2e/gemini-staged.mjs:51-65`、
`packages/voice-bridge/e2e/gemini-voice-loop.mjs:111-135`)手工构造 config 字面量,
**都没带这四个字段**。crash 现场就是 `BridgeLinearClient.ts:56` 的
`opts.bridgeUrl.replace(/\/+$/, "")` → `TypeError: Cannot read properties of
undefined (reading 'replace')`,与 issue 描述完全吻合。讽刺的是两个 rig 都已经
`need("FLYWHEEL_API_TOKEN")` / `need("GEMINI_API_KEY")` 校验过 env,只是没把值
穿进 config。

顺带核对 `HuddleBridgeConfig`(`config.ts:68-112`)全字段与 boot 路径消费:

| 缺失字段 | boot 后果 | 处置 |
|---------|-----------|------|
| `bridgeUrl` | **crash**(.replace) | 必补(env 已有 :9877 默认 + 9876 拒跑守卫) |
| `apiToken` | 不 crash,但所有 Linear proxy 调用 401 | 必补 |
| `geminiApiKey` | Live connect 失败 | 必补 |
| `geminiModel` | Live connect 失败 | 必补(镜像 loader 默认 `gemini-3.1-flash-live-preview`,可被 `FLYWHEEL_HUDDLE_GEMINI_MODEL` 覆盖) |
| `founderUserId` | 不 crash(消费点都在 /glaw 交互路径) | 建议补 `DISCORD_OWNER_USER_ID ?? ""` 传递,诚实对齐 schema |
| `bargeInMinRms` / `bargeInHoldoffMs` | boot 路径消费(`cli.ts:336/687`),undefined → NaN 比较静默异常 | 建议补 0 / 1000。注意 0 **不是** loader 默认(loader 默认 700;0 是 EarsReceiver 收 undefined 的 off 语义)—— 选 0 = 刻意关噪声门保合成探针,measurement-rig override;1000 = loader 默认 |
| `claudeBin` / `brainTimeoutMs` / `earconPath` / `fillerPath` / `brain` | 只在 /glaw 会议装配或 optional-chain 内消费 | 不补(scope 纪律) |

HL 有 scratch patch 未进仓库;本设计按代码事实独立重建,修法由 crash 点唯一确定。

### 2.3 registry / CI drift guard 现状

- registry:`packages/config/src/feature-flags/registry.ts`(FLY-709)。每个 flag
  声明 envVar/polarity/default/**readSites(file+symbol+pattern+timing)**/toggleable。
- drift guard:`packages/config/src/__tests__/feature-flags-drift.test.ts`。
  forward 方向扫 `SCAN_DIRS`(teamlead/config/flywheel-comm/edge-worker src —
  **不含 voice-bridge**);reverse 方向逐条读 registry 声明的 readSite 文件,断言
  文件里真有该 env var 名 —— **文件在 SCAN_DIRS 外也会被读**,所以 readSite 必须
  指向真实读点,乱填必红(FLY-1329 当日实证的教训)。
- 先例:owning reader 是外部 daemon(非 Bridge 进程)的 flag(如
  `FLYWHEEL_ACCOUNT_IDENTITY_CHECK`)注明「the owning reader is the external
  daemon」;QA-only / 非 founder 面板的用 `toggleable: "readonly"`。
- `FLYWHEEL_GEMINI_AUTOSTART` 本身没注册(voice-bridge 不在扫描面 + 它是 topic
  字符串非布尔 gate)。新 seam 是**布尔 gate**,按 issue 要求注册。

### 2.4 pack 两处更正的事实核

pack 文件 `engineering/doc/FLY-1347-voice-measurement-pack/voice-measurement-pack.md`
**目前只在未 merge 的 `flywheel-FLY-1347` 分支上**(FLY-1347 无 PR;main 上无此
文件夹)——见 §4 跨分支依赖。

- **§4.2 bot 自撞**:§4.2 表写 `INJECTOR_BOT_TOKEN` = pool-05,而 HL 的 staged env
  (`~/.flywheel/qa-fly967-staged/.env.staged`)里 `HUDDLE_ORCH_BOT_TOKEN` 也是
  pool-05(`gemini-staged.mjs` 头注释「pool-06, or pool-05 rig」佐证这个历史用法)。
  同一个 bot 同房只有一条语音 session → 实测复现 IP discovery socket closed +
  ready↔signalling 打摆。更正:injector 写死 pool-06,并把失败形态记进表(防再踩)。
- **§0 /gemini 行**:「WAV 经 ears seam 注入可测全部时序判据」在 presence gating
  现状下不成立(§2.1)。更正为:需 presence QA seam(本单)armed 才成立,并写明
  flag 名与负向对照要求。

## 3. 设计选项

### 3.1 seam 放哪(核心决策)

| 选项 | 内容 | 评价 |
|------|------|------|
| **A. wiring 层包 founderPresent 闭包(推荐)** | `wireAssistantMode` 开头读一次 `env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE === "1"` 进 const;armed 时 `founderPresent()` 返回 true 并在日志里**显式标注 override**;armed 时打一条 boot 日志 | 单一读点、AUTOSTART 同款哲学(unset = 字节级零行为)、AssistantSession 状态机零改动、测试经现有 `opts.env` 注入即可 |
| B. 伪造 humanCount seed = 1 | boot 把计数器置 1 | 污染共享计数器;真人 join/leave 增量叠加后语义混乱;日志撒谎(看不出是 override) |
| C. AssistantSession 加 option | session opts 加 `presenceOverride` | 改公共 session API,扩散面大;env seam 本来就住 wiring(AUTOSTART 先例);被 FLY-1323 testHookPoint 前车明确否掉的「通用 hook」方向 |

选 A。行为边界:armed 时 post-connect 直接 `enterLive("initial-check")`,no-show
timer 永不挂;`onFounderLeave` 依旧订阅 —— headless 场景 humanCount 恒 0、leave 回调
永不触发,session 由 rig 的 `runtime.close()` 收尾;若真人进又出(1→0),landing 照常
触发(QA seam 不改真人语义,可接受且值得保留)。

### 3.2 flag 命名与解析

- 名:`FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE`(FLYWHEEL_ 前缀对齐全仓;VOICE_ 而非
  GEMINI_ 因它语义上是 voice presence 而非某条命令;当前只接 assistant wiring,
  /gemini-advanced 共用 wireAssistantMode 自然覆盖,/eleven 不接 —— 见 §3.4)。
- 解析:`=== "1"` 严格 opt-in(最窄布尔);其它任何值(含 "true"/"0"/unset)=
  字节级现状。fail-closed。
- **不做通用 hook**:不加 testHookPoint/回调注入(FLY-1323 被 Codex 打回的前车),
  就一个窄布尔、一个读点。

### 3.3 生产误用防线(Codex R1 #2 后定稿:allowlist)

armed 时解析 effective `bridgeUrl`(注意它只来自 env,`config.bridgeUrl` 不参与),
仅允许有据的 staged Bridge 形态(`http://` + loopback host + 端口 `9877`;R2 #1:
「任意非 9876 端口」只是 denylist 换皮),否则 wiring 直接
throw 拒启 —— 黑名单只挡已知端口,反代/无端口/非默认生产形态会漏;allowlist 把
「有人把 QA flag 塞进生产 .env」这条误用路径在 boot 掐死。检查是 fail-stop
(位于 wireAssistantMode,bots 已登录后;boot 失败走既有 teardown),非零接触
preflight —— 换取 seam 单一读点。unset 时该检查完全不存在(零行为)。

### 3.4 /eleven 为什么不在本单接 seam

eleven wiring 有自己的一套 humanCount(`eleven/wiring.ts:251-272`),但语义不同:
它**不 gate 进 live**,只驱动 no-show abort timer —— session 直接开跑,harness 在
no-show 窗口内足以完成注入测量(pack §0 说 /eleven「WAV 注入全链可测」与此吻合)。
/gemini 是「不 present 永不 live」,才是结构性挡死。scope 纪律:只修被挡死的。

### 3.5 registry 注册形态

新条目(`packages/config/src/feature-flags/registry.ts`):

- name `voice_qa_presence_override`,category `feature`,source `env`,scope
  `bridge_global`,polarity `opt_in`,valueKind `bool`,default `false`;
- readSites:`packages/voice-bridge/src/assistant/wiring.ts` / symbol
  `wireAssistantMode` / pattern `env-param` / timing `object_construction`
  (值在 wiring 装配时捕进 const —— 真实读点,reverse drift check 可过);
- toggleable `readonly` + note:owning reader 是 voice-bridge daemon(外部进程,
  非 Bridge live-toggle 面);QA-only seam,永不进 founder 面板,生产永不置位。

### 3.6 rig 修法

两个 rig 的 config 字面量补 §2.2 表中「必补/建议补」字段,值全部走既有 env
(`FLYWHEEL_BRIDGE_URL`(已有默认+守卫)/`FLYWHEEL_API_TOKEN`/`GEMINI_API_KEY`/
`FLYWHEEL_HUDDLE_GEMINI_MODEL ?? 默认`/`DISCORD_OWNER_USER_ID ?? ""`),并
`process.env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE ??= "1"`(与 rig 内
`FLYWHEEL_BRIDGE_URL ??=` 同款可覆盖默认 —— HL 跑负向对照时显式置 "0" 即可)。

### 3.7 pack 更正内容

§2.4 两条。落法取决于 §4 的跨分支排序。

## 4. 跨分支依赖(开放问题,提请 Lead 拍)

pack 文件只在未 merge 的 `flywheel-FLY-1347` 分支上,本分支(自 main fork)没有。
选项:

- **(i) FLY-1347 先 merge(推荐)**:纯 docs 分支,merge 后本分支 merge main,
  在 implement 阶段直接改 pack 文件。干净、无重复、无冲突。
- (ii) 把 pack 文件夹复制进本分支改:与 FLY-1347 PR 必撞冲突,否。
- (iii) pack 更正拆给 FLY-1347 分支自己补:更正内容与 seam flag 名强耦合
  (§0 更正要写 flag 名),拆开反而两边等,否。

推荐 (i),且(Codex R1 #4 + Lead「三件事一单修完」合同)(i) 是**硬前置**:
pack-correction.md 式 fallback = 变相拆单,不作数;若 FLY-1347 短期不 merge,
implement 停在 pack step 请 Lead 拍(先 merge FLY-1347,或明确重批拆单口径),
其余 step 先做完。

## 5. 验收对齐

- seam:unset = 零行为(负向单测 + 现有 presence 测试不动);armed = headless
  enterLive(正向单测);armed 且非 `http://` loopback `:9877` staged 形态 = 拒启
  (allowlist 守卫负向矩阵单测)。
- rig:config 构造抽共享 builder 并单测 boot-read 字段真进对象(干跑「死在 env
  校验」是修前也过的假绿,不作证据);全链由 HL 的 measurement run 真机验
  (负向对照先行防假绿 —— 先 override=0 复现「停 invoked」,再 =1 跑全链)。
- registry:drift suite(forward+reverse)绿。
- 不碰生产 presence 语义:diff 层面 wiring 仅新增 armed 分支;unset 路径字节级等价。
