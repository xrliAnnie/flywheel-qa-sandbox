# FLY-545 QA 结论 — Huddle 模式(三段式 QA 阶段,Opus)
Issue: FLY-545 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md §8 验收标准 + PR-2 v2 · 被验 HEAD = 195f90b2(与 origin/PR #503 一致)

## ⭐⭐ 当前 Verdict(2026-07-11,founder 真机复测 FLY-1158,head f53166d2)→ **FAIL(kickback 给 implement 3dcb1b94)**

R2 修复(F1 reconnect + F2 cue + F3 上屏)之后,Annie **再次真机跑 /glaw**(会议 FLY-1158)。收音全程 OK
(她每句都被转写上屏 🗣️、F3 工作),但**对话在第一轮后卡死约 7 分钟**,founder 体感依旧「说话没人理」。
→ **FAIL**。铁证 = FLY-1158 daemon log + TIV 面板时间线(见 evidence/fly1158-evidence.txt)。

### 时间线(founder 可见的真相)
- 03:05:43 Lead 首次应答(唯一一次正常回)。
- 03:06:15 / 03:08:39 / 03:09:17 Annie 连问三句(全上屏 🗣️),Lead **零回应、面板也无 🧠在想** —— 死沉默。
- 03:10:09 面板才弹「⚠️ 线路闪断了一下,已自动接回 — 刚才那句请再说一遍」(daemon: abort → reconnected resumed=true)。
- 03:11:30 / 03:11:56 / 03:12:08 / 03:12:51 Annie 再问四句(含「你到底能不能听到我说话啊?」),**reconnect 后 Lead 仍不回**。
- 03:13:28 Lead 才**真正恢复应答**。→ 从 03:06 哑到 03:13 回 = **~7 分钟死窗**;03:10 reconnect 只接回连接、对话层到 03:13 才恢复。

### Defects(founder-caught,按 Annie/Tadashi 定级)
- **① P0 连接脆弱 + 重连后对话不恢复**:log『Gemini Live connection closed unexpectedly: The operation was aborted』→『reconnected (resumed=true)』——**F1 连接层重连 OK,但对话层没跟着恢复**(Annie 后续零回复直到 3 分钟后)。要:(a) **根治连接脆弱**(assembly-concurrency / keepalive starvation 根子 —— 让它**更不容易断**,不只是断后重连);(b) **重连后对话必须真接上**(turn / ears / 回话全恢复,不能只接线不接脑)。另 log **4 次**『[turn-mouth] stream backpressure — model audio outrunning playback beyond highWaterMark』一并查(可能相关)。
- **② P1 状态撒谎(cue 不反映真实处理)**:Annie 发现『🎙在听 / 🧠在想』只是 **VAD**(她说话=在听、她停=在想),**不反映真实处理状态** —— 真卡死时也显示『在想』,误导她以为在正常工作。要让 cue 反映**真实态**(真在处理才显示在想;卡了要能看出卡了)。
- **③ P1 音效缺 + 识别 gap 无即时反馈(round-2 F2 未达标)**:补提示音 + 「说完 → 字出现」那几秒的即时反馈。
- **④ P1 环境杂音误打断(VAD 太敏感,Annie 复测中现场报)**:环境噪音会误触发打断 / turn-end —— VAD 把环境音当成她说话或停顿。要降 VAD 敏感度 / 加噪音门限,别被杂音打断。
- **⑤ P2 识别延迟**:查为什么比 /gemini 明显慢。

### 🔁 QA 复盘(我的 Monitor 这次的盲点,写进判据)
我 headless 自灌只跑到「meeting live + host 招呼 + 单轮」就判 GREEN,**没抓到「第一轮后断联 + 对话不恢复」** —— 因为(a)合成音喂不进 STT、我根本没能自灌出真多轮;(b)我没主动打断连接看断后能否接上。**新判据(下次语音 QA 必做)**:真多轮(**≥3 轮连续对话不掉线**)+ **主动打断/触发连接 abort,验证断后对话层能否真恢复**(不只连接层 reconnect)+ **环境噪音场景(验 VAD 不被杂音误打断,defect ④)**。earsJoined / 单轮 / 连接层 reconnect 都不算过。

---

## ⭐ 上一轮 Verdict(2026-07-10,真机 founder 测,head c0769057)→ **FAIL(kickback 给 implement 3dcb1b94)**

Annie 亲手在 staged VC 打了 /glaw 全程测 —— **A8 北极星真机验收 = FAIL**。这是代码级 PASS
**漏掉**的一层:earsJoined:true / 单测全绿 都通过了,但真人跑一整场时暴露 3 个 founder 级缺陷。
3 findings 已存 FLY-545 comment 79d45094:

- **F1(P0,ship-blocker)= Gemini Live 会议中途 abort。** 我的深挖(1144+1146 两场真会):
  daemon log 两场都在 **meeting assembling 那一刻** 抛
  `line flywheel-eng-lead error: Gemini Live connection closed unexpectedly: The operation was aborted`。
  **2/2 可复现,不是瞬时随机**(我最初据 1144 + 隔离探针误判成「瞬时」,1146 复现后修正)。
  `sessionResumption` **有时**救得回:FLY-1146 抖完 resume、Lead 真聊了 2 轮(transcript 519B、
  答了 Annie 关于 FLY-1146 的问题);但**用户在 abort 那几秒开口 = 说话没人理**(FLY-1144,
  transcript 0B)。根因方向:`genaiConnector.ts` 的 `client.live.connect()` **没传 abort-signal**;
  疑 **assembly 阶段并发**(`createBrain` 起 claude 子进程 / `WorktreeManager.create` 建 worktree)
  阻塞 event loop、饿死 Gemini WS keepalive。**load 10 也断** → 不是纯负载,是并发时序。
  **很可能与 /gemini(1065)共用底层** → 修在共享 voice 基建、别只补 huddle。
  独立佐证:隔离裸连 Gemini Live(同 key+model)0.48s open / 稳住 10s 零 close → 单连健康,
  只有真会 assembly 并发才断。
- **F2(P1)= 延迟大 + 等待无反馈。** 说完到回话之间没有「在听 / 在想」的提示,founder 不知道
  系统收到没 → 容易误判成死了就退(直接放大了 F1 的杀伤)。需 listening/thinking cue + 压延迟。
- **F3(P1)= 不显示 founder 自己被转写的话。** 面板只见 Lead 侧,founder 看不到自己那句被听成
  什么 → 无法自查收音对不对。

### ⚖️ NEW 验收门(本单起,写死为硬规则)
**语音命令的 QA,必须由 QA 自己灌真音频跑一整场端到端**
(说话 → 收到 → 回话 → **连续几轮不掉线**)**才算过**。
**earsJoined:true / 代码级单测全绿 一律不算过** —— 正是这条空档让 round-2「代码级 PASS」放行了
一个 founder 亲测才暴露的 P0(F1)。工具已备:`packages/voice-bridge/e2e/glaw-injector.mjs`
(灌探针音频 + 抓非注入者音频)。retest 时我先自灌音频跑通整场,再 @Annie。

→ **FAIL,belt 交回 implement 3dcb1b94。** 修 F1/F2/F3 → 我灌音频端到端复验 → 通了才 @Annie。

---

## RE-TEST 更新(2026-07-09,epoch=5,head d7261e3e)→ Verdict: PASS(代码级)

implement 阶段推了 5 个修复 commit(QA kickback R1 → Codex R8-R11),新增共享模块
`confirm-heuristics.ts`,把「肯定开头 = 无条件 YES」换成**结构保持的分段判定**:
必须以 yes token 开头、按分隔符切段后**每一段整体都是同意词**、且拒绝「X是X」让步框架
(`可以是可以`)。两处确认面(HuddleSession.concluding + ConfirmationLadder.submitB)都改走
`isUnconditionalAffirm`;qualified 的走更正/decline 路径。**额外**:concluding 阶段的更正
现在会**进 journal**(exclude 两个 first-hand 方),我原先指出的「更正从 summary 消失」也一并根治。

复验证据(head d7261e3e):
- 我的 kickback 测试 `qa-fly545-confirm-heuristic.test.ts` 现全绿(原 5 fail → PASS)。
- 我**新增对抗性边界探针**(同文件):9 条 leading-yes 更正/让步/模态疑问/中英混
  (`对对对,但时间改一下` / `可以是可以,但是` / `嗯,那个第二条呢` / `yes but change the date` …)
  全部**不落地**;10 条干净肯定(`对`/`对的`/`好的`/`确认`/`对对对`/`确认没问题`/`yes` …)
  **仍落地** → 25/25 PASS(修复既堵住漏洞又不误伤真 YES)。
- implement 阶段的 `confirm-heuristics-hardening.test.ts` 41/41 PASS。
- **全回归**:voice-bridge 332/332、voice-core 201/201、两包 typecheck 干净、改动文件 lint 0、
  我的 kickback 断言未被削弱(diff 只有 linter 重排 import)。

→ **代码级验收全绿,kickback 已闭环。** 唯一 gated 项仍是 A8 北极星(见文末),须 Annie 部署后亲跑。

---

## 原始 Verdict(round 1,head 195f90b2): FAIL(kickback 给 implement 阶段)

一处真·correctness 缺陷,落在 plan 明确标为**关键**的 recap-确认合同上
(§C「关键在 recap 合同措辞」)。可复现、有可执行 RED 证据(见下)。其余全绿。
修法很轻、implement 阶段还活着 parked —— 按三段式退回,由它在本分支修,我复验。

---

## 缺陷:确认启发式把「肯定开头的更正/部分同意」误当成无条件 YES

### 根因
两处确认面共用同一条正则,只锚定句首:

```
AFFIRM = /^(对|是|确认|可以|好的|好|行|没问题|嗯对|就这样|yes|...)/
```

founder 对 recap 的「…对吗?」最自然的一类回答是**先应后改**:

- 「对,不过第二条改成下周三」
- 「好,但时间不对」
- 「可以,不过先别建 worktree」
- 「是这样,但还差一条 action」

它们都以 对/好/可以/是 开头 → 命中 AFFIRM → 被当成完全同意。且 AFFIRM 在
DENY **之前**判,所以「yes-but-no」永远解析成 yes。

### 影响(两个高风险落点)

1. **HuddleSession(concluding)**:`handleFounderUtterance` 里
   `if (AFFIRM_RE.test(text)) landNow(true)` 立即落地。主持**不再** re-recap;
   又因为 concluding 阶段 founder 的话**不进 feed journal**(所有 `feed.append`
   都在 `if (state==="concluding") return` 之后),她的更正被**整段丢弃**——
   summary 用的是**原始(错误)recap**、标 `confirmed=true`、建 worktree、issue→Done。
   teardown 之后无法口头补救。这不是「误检便宜」的域(AddressRouter 那种口头纠正可救),
   这是**落地一个错的 Done 产物**。

2. **ConfirmationLadder.submitB(b 档「可恢复但有后果」)**:`notifyFounderUtterance`
   先判 AFFIRM 再判 DENY → 「好,但先别动」命中 AFFIRM → `execute()` 照跑,
   等于在她限定/否决时执行了那个动作。设计注释自己写的是「silence≠consent」,
   但 affirm-leading 的 decline 也不该算 consent。

> 设计注释原话:确认词表应「only leading, **unambiguous** forms count」。
> 但 好/是/行/可以 恰恰是高频、**歧义**的句首字 —— 现状偏离了它自己声明的意图,
> 不是「按设计工作」。

### 可执行证据(RED,驱动真类,非只测正则)
`packages/voice-bridge/src/__tests__/qa-fly545-confirm-heuristic.test.ts`

- 4 条 affirm-leading 更正喂给真 `HuddleSession` → 现状全部 `land(confirmed:true)`
  (期望:留在 concluding、不落地)→ **FAIL**。
- 1 条喂给真 `ConfirmationLadder.submitB` → 现状 `execute()` 被调用
  (期望:不执行)→ **FAIL**。
- 对照:干净的「对,没问题」仍正确落地 → **PASS**(守住修复不能过度、别误伤真 YES)。

结果:`5 failed | 1 passed`。

### 建议修法(轻、窄;不扩范围)
两处共用的确认判定加一道「更正/对比标记」闸:当同句同时出现对比/否定/延后类
标记时,不算 consent(交回更正路径 / b 档保持等待)。标记集参考:
`不过 / 但 / 但是 / 可是 / 除了 / 还差 / 漏 / 改成 / 先不 / 别 / 等等 / 不对`。
并把 DENY 类判定放在 AFFIRM 之前(先否后肯)。务必保「对/对,没问题/好的/确认」仍算 YES
(对照测试守着)。改完两处 + 复用同一 helper 更干净。

---

## 已验证通过(其余全绿)

| 项 | 结果 | 证据 |
|----|------|------|
| A1 全测 + typecheck + lint | ✅ | voice-bridge 266/266、voice-core 201/201;两包 tsc 干净;`pnpm lint` exit 0(15 warnings 全在本分支未碰的既有文件) |
| CI / PR mergeable | ✅ | PR #503 `Build & Test` SUCCESS、mergeable=MERGEABLE、state=CLEAN、head 三方一致 195f90b2 |
| 引擎骨架(A10 多 session) | ✅ 读码 | LeadLine(session+mouth+rotator+brain)/ AddressRouter sticky / FeedPipeline first-class / HuddleSession conductor,接线见 wireMeeting.ts |
| 一张嘴纪律(B3) | ✅ 单测 | 未持牌 turn 被 interrupt + 计数,mouth 不开(huddle-session.test.ts) |
| sticky 切换(B2) | ✅ 单测 | 点名 → 旧线 cut、新线拿 text turn、frames 跟随 |
| 补喂 first-class(B1) | ✅ 单测 | journal fan-out 游标、投递失败 hold+retry、rebuild replay、onLag once |
| A6 失败路径显式 | ✅ 读码 | ConclusionPipeline:summarize/comment/worktree/setStatus 失败全部 `tiv.warn` + 停在该步、不静默;getState 查询失败 resolve undefined 不阻落地 |
| A7 argv/日志卫生 | ✅ 读码 | config.ts 所有 token 从 env 解析;cli 注释「secrets only via env (never argv/logs)」;缺 env → 带指引的显式 throw(config.ts:345) |
| 幂等落地 | ✅ 读码+单测 | SUMMARY_MARKER + Done-guard + 本地 landing ledger(commented/worktreePath 断点续跑) |
| R6 HIGH(/glaw 与 /gemini 共享房间单 SessionSlot) | ✅ 读码+单测 | 195f90b2 两向收敛测试:hold 互斥、零副作用 |

## 未覆盖(非本阶段可及,如实标注,非 PASS)
- **A8 北极星**(Annie 真用一次 /glaw 全程)= 唯一 issue-Done 凭据 —— **founder-gated**,
  当前**未具备运行条件**,不能由 QA 代跑:
  - `~/.flywheel/.env` 缺 `HUDDLE_ORCH_BOT_TOKEN` / `HUDDLE_EARS_BOT_TOKEN`(现只有 `DISCORD_GUILD_ID`);`GEMINI_API_KEY` 在 `~/.zshrc` 未进 `.env`(launchd wrapper source 不到)。
  - `projects.json` 无 `huddle` 块(schema 见 config.ts)。
  - Huddle 编排 bot(pool-06)未入 guild(需 founder 点邀请,见 evidence/bot-provisioning.md)、#huddle VC 未定。
  - → staged E2E / B4 全链 / 北极星 是 founder 部署清单落地后的一步,不阻塞代码级验收,但**必须在 ship 前由 Annie 亲跑**。
- 实时音频链路延迟(§15 首音/静默端点)= 真机项,同上 gated。

## 结论
代码级验收 A1–A7 + 引擎骨架全绿;**唯一拦停项 = 确认启发式误判 affirm-leading 更正**,
落在关键 recap 合同上、可复现、修法轻。→ **FAIL,退回 implement 阶段修**,修好复验;
之后 A8 北极星仍须 Annie 亲跑(部署清单先落地)才是最终 issue-Done 凭据。
