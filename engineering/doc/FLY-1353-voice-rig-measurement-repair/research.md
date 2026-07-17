# FLY-1353 voice-rig 测量基建修缮 — 调研

Issue: FLY-1353 (https://linear.app/geoforge3d/issue/FLY-1353/voice-rig-测量基建修缮-presence-qa-seam窄布尔-e2e-脚本跟上-config-化-pack-42-更正hl-测量)
日期: 2026-07-17
基于: exploration.md(同文件夹)

> 目的:把 exploration 选定的方案落到**逐个改动点**的技术事实层,供 plan 直接引用。
> 所有行号基于本分支 HEAD(fork 自 main `fae547750`)。

## 1. 改动点 A — presence QA seam(wiring.ts)

### 1.1 精确落点

`packages/voice-bridge/src/assistant/wiring.ts`,`wireAssistantMode()`:

- **读点(唯一)**:函数开头 env 校验区(约 L117-135 之后)加:
  ```ts
  // FLY-1353 QA presence seam (AUTOSTART philosophy): headless rigs have no
  // human in the VC, so founderPresent() can never turn true — this narrow
  // opt-in makes presence read as satisfied. Unset (or any value ≠ "1") is
  // byte-identical to today. NEVER set in production.
  const qaPresenceOverride = env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE === "1";
  ```
- **生产误用守卫(Codex R1 #2 后定稿:staged-target allowlist,非 :9876 黑名单)**:
  紧随其后,armed 时解析 effective `bridgeUrl`(L129-130 已就位,**只来自
  env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? 默认 :9876,`config.bridgeUrl`
  不参与** —— 测试必须走 env 面):
  ```ts
  if (qaPresenceOverride) {
      let ok = false;
      try {
          const u = new URL(bridgeUrl);
          ok =
              u.protocol === "http:" &&
              ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) &&
              u.port === "9877";
      } catch {}
      if (!ok) {
          throw new Error(
              "voice-bridge: FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE=1 only allowed against the loopback staged Bridge (http://127.0.0.1:9877) — QA-only seam",
          );
      }
  }
  ```
  黑名单只挡已知端口(反代/无端口/非默认生产形态全漏);「loopback + 任意非 9876
  端口」也只是 denylist 换皮(R2 #1:`127.0.0.1:43210`、`https://localhost:8443`
  全漏)。allowlist 钉死仓内唯一有出处的 staged Bridge 形态:**http + loopback +
  端口 9877**(`e2e/staged-bridge.mjs` 默认、两 rig `??=` 默认、FLY-1047 安全合同
  assert 9877;此前文档里的「9882」是 /glaw venue 记录端口,无 staged Bridge 出处,
  不列入)。将来第二个 staged 端口 = 改常量 + 补出处。**边界如实声明**:检查在
  `wireAssistantMode`,此时 `runVoiceBridge` 已起 health server、登录 bots、
  Note-taker 已进 VC(`cli.ts:188-270`)—— fail-stop(boot 失败走既有
  catch/teardown),非零接触 preflight;换取 seam 单一读点(registry readSites
  单条)。
- **生效点**:`founderPresent` 闭包(L361-367)改为:
  ```ts
  founderPresent: () => {
      if (qaPresenceOverride) {
          log("[presence] founderPresent()=true (QA OVERRIDE — humanCount ignored)");
          return true;
      }
      const present = humanCount > 0;
      log(`[presence] founderPresent()=${present} (humanCount=${humanCount})`);
      return present;
  },
  ```
- **armed 日志**(证据诚实性,防假绿):autostart seam 同款,armed 时 boot 打一条
  `log("QA presence override armed — founderPresent() forced true (FLY-1353; QA-only, never production)")`。

### 1.2 行为边界(核实过状态机)

- armed → `AssistantSession.start()` post-connect(`AssistantSession.ts:249-252`)
  直接 `enterLive("initial-check")`;no-show timer(L263-267)永不挂;
  `onFounderJoin` 订阅分支(L254-262)不进入。
- `onFounderLeave`(L241-248)照旧订阅:headless 下 humanCount 恒 0,
  `wiring.ts:209` 的 leave 广播只在「1→0」时触发,恒 0 不触发 → 会话由 rig 的
  `runtime.close()` → `activeSession.stop()` 收尾。真人进又出(1→0)时 landing 照常。
- AssistantSession / GeminiCommand / SessionSlot 零改动。eleven wiring 零改动
  (exploration §3.4:它不 gate 进 live,无结构性阻塞)。

### 1.3 测试(负向对照先行)

`packages/voice-bridge/src/__tests__/assistant-wiring.test.ts`(fixture `CONFIG`
已含全字段,env 经 `opts.env` 注入;autostart seam 测试 L533-565 是模板)。
**两个输入面陷阱(Codex R1 #1 核出,用例必须绕开)**:`makeFakes()` 把
`voiceChannelHumanCount` 固定 `async () => 1`(L143-145)—— 不覆写成 0,「无人」
场景根本不存在,sentinel 会假绿;守卫走 env 面(见 §1.1),不走 `CONFIG.bridgeUrl`。

1. **负向(sentinel)**:`f.deps.voiceChannelHumanCount = async () => 0`(等 seed
   落定)+ env 不含 override + `FLYWHEEL_BRIDGE_URL=http://127.0.0.1:9877` →
   无人 join 时 session 停 `invoked`、不发 OPENING —— 断言与现状逐字一致(防
   「fixture 没开启被断言机制」的空绿:先在现状代码上突变验证断言真的在测 gating)。
2. **正向**:同 1 + `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE: "1"` → 无 join 事件即进
   live(OPENING 控制提示送达),并断言「override armed」boot 日志 +
   「QA OVERRIDE — humanCount ignored」日志。
3. **窄解析**:override ="0"/"true"/"" → 与 sentinel 同行为。
4. **守卫(allowlist 负向矩阵;R2 #3:守卫在 wire-time reject,occupancy seed
   尚未启动 —— 这几条不覆写也不等 seed,只断言 reject)**:override=1 + env 分别为
   `FLYWHEEL_BRIDGE_URL=…:9876` / `BRIDGE_URL=…:9876`(alias)/ 非 loopback
   `https://bridge.internal.example` / 无显式端口 `http://127.0.0.1` /
   loopback 任意端口 `http://127.0.0.1:43210` / `https://localhost:8443` /
   非 http 协议 `ftp://127.0.0.1:9877` → 全 reject(`/QA-only seam/`);
   `http://127.0.0.1:9877`(正向用例)放行。
5. 既有 presence 测试(`qa-fly967-round3-presence.test.ts` 等)不动,全绿 = unset
   路径未被扰动的回归证据。

## 2. 改动点 B — registry + drift guard

### 2.1 registry 条目

`packages/config/src/feature-flags/registry.ts`(`envSite(file, symbol, timing,
pattern?)` helper,pattern 默认 `"process.env"`,本条要显式传 `"env-param"`):

```ts
{
    name: "voice_qa_presence_override",
    category: "feature",
    source: "env",
    scope: "bridge_global",
    envVar: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
    polarity: "opt_in",
    valueKind: "bool",
    default: false,
    description:
        "FLY-1353: voice-bridge /gemini headless 声学 E2E 的 presence QA seam —— =1 时 founderPresent() 视为满足(仅 staged rig;armed 时 allowlist 只放行 http://127.0.0.1:9877 staged Bridge,其余 boot 拒启)",
    readSites: [
        envSite(
            "packages/voice-bridge/src/assistant/wiring.ts",
            "wireAssistantMode",
            "object_construction",
            "env-param",
        ),
    ],
    // The owning reader is the voice-bridge daemon (external process), not the
    // Bridge whose env the direct-toggle surface mutates. QA-only: never a
    // founder dashboard toggle, never set in production.
    toggleable: "readonly",
    note: "QA-only seam(FLY-1353)。生产永不置位;armed + 生产 Bridge URL = boot 拒启。",
},
```

### 2.2 drift guard 核实(为什么这样注册能绿)

`packages/config/src/__tests__/feature-flags-drift.test.ts`:

- forward 扫描面 `SCAN_DIRS` = teamlead/config/flywheel-comm/edge-worker src,
  **不含 voice-bridge** → 新读点不会被 forward 方向要求;注册是 issue 的政策要求
  (FLY-1329 教训:readSites 必须真实)。
- reverse 方向逐条读 registry 声明的 readSite **文件本身**(路径从 REPO_ROOT
  resolve,不限 SCAN_DIRS),断言文件里出现该 env var 名 —— wiring.ts 里
  `env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE === "1"` 直接满足。乱填文件名才会红。
- registry 结构测试(`feature-flags-registry.test.ts`):`liveToggleTest` 仅
  `toggleable: "direct"` 强制;`readonly` 无额外要求。governance-gate 强制 readonly
  的规则与本条无冲突(本条 category=feature 且主动选 readonly)。

## 3. 改动点 C — 两个 rig 的 config 对齐

### 3.1 事实矩阵(exploration §2.2 的落地形)

`HuddleBridgeConfig`(`packages/voice-bridge/src/config.ts:68-112`)要求 vs 两 rig
字面量(`gemini-staged.mjs:51-65`、`gemini-voice-loop.mjs:111-135`)缺口与取值:

| 字段 | 取值(两 rig 相同) | 依据 |
|------|--------------------|------|
| `bridgeUrl` | `process.env.FLYWHEEL_BRIDGE_URL` | rig 已 `??= "http://127.0.0.1:9877"` + 9876 拒跑守卫;crash 点 `BridgeLinearClient.ts:56` |
| `apiToken` | `need("FLYWHEEL_API_TOKEN")` 的返回值 | rig 已校验只是没穿进 config;`cli.ts:277` |
| `geminiApiKey` | `need("GEMINI_API_KEY")` 的返回值 | `cli.ts:281` createGenaiTransport |
| `geminiModel` | `process.env.FLYWHEEL_HUDDLE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview"` | 镜像 loader 默认(`config.ts:122/372`),注释标明镜像关系 |
| `founderUserId` | `process.env.DISCORD_OWNER_USER_ID ?? ""` | 消费点全在 /glaw 交互路径,boot 容忍;诚实对齐 schema(`config.ts:86/362`) |
| `bargeInMinRms` | `0` | boot 路径 `cli.ts:336`(EarsReceiver)。**刻意的 rig override,非 loader parity**(Codex R1 #5 更正:loader 默认 700,`config.ts:335-339`;0 是 EarsReceiver 收 undefined 的 off 语义,`EarsReceiver.ts:70,99`)—— 选 0 = 保留旧 rig 有效行为:噪声门关死,合成探针不被 RMS 门吃掉。注释按此措辞写死 |
| `bargeInHoldoffMs` | `1000` | boot 路径 `cli.ts:687`;与 loader 默认 `DEFAULT_BARGE_HOLDOFF_MS = 1000` 一致 |
| 不补 | `claudeBin`/`brainTimeoutMs`/`earconPath`/`fillerPath`/`brain` | 只在 /glaw 会议装配或 optional-chain 内消费;scope 纪律 |

### 3.2 rig 内 seam 默认

两 rig 在 AUTOSTART 附近加:
```js
// FLY-1353: headless rig has no human in the VC — presence gating would hold
// the session in `invoked` forever. Overridable: HL's negative control runs
// with FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE=0 first (must reproduce the stall).
process.env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE ??= "1";
```
(`??=` 与 rig 既有 `FLYWHEEL_BRIDGE_URL ??=` 同款可覆盖默认。)

### 3.3 rig 修完的可验证性(Codex R1 #3 更正)

~~不带 staged env 干跑死在 env 校验~~ —— **假绿**:`need("STAGED_GUILD_ID")` 在
config 字面量与 `runVoiceBridge()` **之前**执行(`gemini-staged.mjs:35`、
`gemini-voice-loop.mjs:47`),该断言修前也成立,永远触达不了
`BridgeLinearClient.ts:56` 的 crash 点。

替代证据:两 rig 的 config 构造抽成共享 `e2e/lib/rig-config.mjs` 的
`buildStagedConfig(env)`,新增 `src/__tests__/rig-config.test.ts` 喂 stub env,
逐字段断言 boot-read 字段真进了返回对象(= 传给 runVoiceBridge 的对象)。
全链真机数据由 HL 的 measurement run 出(负向对照先行)。

## 4. 改动点 D — pack 文档更正(跨分支)

- 文件:`engineering/doc/FLY-1347-voice-measurement-pack/voice-measurement-pack.md`,
  **只在未 merge 的 `flywheel-FLY-1347` 分支**(无 PR;main 无此文件夹)。
- 更正 1(§4.2 表):`INJECTOR_BOT_TOKEN` 行 pool-05 → **pool-06**,并补一句失败
  形态备注:「不得与 HUDDLE_ORCH_BOT_TOKEN 同 bot —— 同 bot 同房只有一条语音
  session,实测复现 IP discovery socket closed + ready↔signalling 打摆」。
- 更正 2(§0 表 /gemini 行「机器可测什么」):「WAV 经 ears seam 注入可测全部时序
  判据」→「WAV 经 ears seam 注入可测全部时序判据(需 FLYWHEEL_VOICE_QA_PRESENCE_
  OVERRIDE=1,FLY-1353 seam;负向对照:=0 须复现停 invoked)」。
- 排序(Lead 指令「三件事一单修完」;Codex R1 #4 + R2 #4:pack-correction.md 式
  fallback = 变相拆单,已废弃):**硬前置,命令级合同与 plan Step 5 逐字一致** ——
  ① `git fetch origin main`(失败即停);
  ② `git cat-file -e origin/main:engineering/doc/FLY-1347-voice-measurement-pack/voice-measurement-pack.md`
  (exit 0 = pack 已真进 main;非 0 → 停在该 step 并 ask Lead:先 merge FLY-1347,
  或明确重批拆单口径,其余 step 先做完);
  ③ `git merge origin/main`(冲突/失败即停);④ 确认工作树里该文件存在再改。
  不复制 pack 文件夹进本分支(必撞冲突)。design 阶段已发非阻塞 ask 预热此排序。

## 5. 风险与非目标

- **不碰生产 presence 语义**:unset 路径 diff 仅多一个 `qaPresenceOverride` const
  与 false 分支;所有既有 presence 测试原样绿。
- **不做通用 hook**(FLY-1323 testHookPoint 前车):一个窄布尔、一个读点、一个守卫。
- **不接 /eleven**(exploration §3.4)。
- **不动 loadHuddleBridgeConfig / HuddleBridgeConfig schema**:rig 侧补字段,
  loader 零改动。
- 唯一外部依赖:FLY-1347 分支 merge 时点 —— **硬前置**(§4;fetch + cat-file 核
  存在性,不满足则 implement 停在 pack step 问 Lead,其余 step 先做完)。
