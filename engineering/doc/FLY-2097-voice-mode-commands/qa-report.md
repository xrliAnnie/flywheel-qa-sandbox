# FLY-2097 进/退语音模式的命令化 — QA 验证报告

Issue: FLY-2097 (https://linear.app/geoforge3d/issue/FLY-2097/raya语音-ux-进退语音模式的命令化进slash-command退自然语音说一句即退模型-tool-call-slash-兜底)
日期: 2026-08-28
基于: plan.md(§6 真机验收判据为准)

> 🔴 **本文件按轮次追加,不改写历史轮。当前状态在最后一节。**
> · **attempt 1**(head `46b5b6b`)= **FAIL**,S1 0/5 —— 下面 §1–§9 是那一轮的原始记录,**不是当前结论**。
> · **attempt 2**(head `4a67508`)= **PASS** + 一条移交 FLY-2030 —— 见文末「QA attempt 2」。
> · attempt 2 的 §B 里有一条**对 attempt 1 证据成色的更正**(wire 计数不是送达的可靠代理),
>   attempt 1 的结论不变,但那条证据不应再被引用。

**结论: FAIL** —— plan §6 的 S1 语义硬门(明确退出 5/5)真机实测 **0/5**。
不是实现写错,而是本单选的实现机制(把退出契约写进 `realtimeStartInstructions` 开场指令)
在这台机器的 Codex 部署上**完全不生效**:该字段被 Codex app-server 接收后没有进入发往
OpenAI realtime 的 `session.update.instructions`。已拿到线级证据(见 §2)。

被测 head: raya `46b5b6b664e7d6c5401a8601237e1e895ea0b575`(分支 `fly-2097-raya-voice-ux`,PR xrliAnnie/raya#3)。
`git ls-remote` 复核:远端 `refs/heads/fly-2097-raya-voice-ux` = 同一 sha,与本地 worktree HEAD 一致,工作树干净。

---

## 1. 全仓门(raya,candidate head)

| 门 | 结果 |
|---|---|
| `pnpm lint` (biome) | ✅ |
| `pnpm typecheck` | ✅ |
| `pnpm build` | ✅ |
| `pnpm test` | ✅ **241 passed**(contracts 22 · voice 135 · brain 84) |

新增测试确实存在并全绿:`voice-mode-ux.test.ts` 25 项、`ExitProtocol.test.ts` 16 项、
`Coordinator.test.ts` 13 项、`runtime.test.ts` 25 项、`config.test.ts` 25 项。
**但 unit 全绿掩盖了下面这件事** —— 它们全部在被测进程内部断言,没有一项能观察到
「开场指令有没有真的到达模型」。

## 2. 硬阻塞发现:自然语音退出(G2 / S1)真机不成立

### 2.1 观测(默认生产配置,voice-test-3 真机)

5 场独立会话,每场真人化 TTS 说一句明确退出意图。全部 eligible
(同代内 user final + assistant final + 下行音频包 > 0 均齐):

| # | 说的话(实际 STT) | 模型回答 | `spoken_exit_detected` | 退出方式 |
|---|---|---|---|---|
| 1 | OK,我現在要退出了。 | 好的,随时欢迎你回来,Xiaorong!… | ❌ 无 | last-human-left |
| 2 | 好了,我要退出語音了。 | 没问题,随时需要我再叫我吧。… | ❌ 无 | last-human-left |
| 3 | 先到这里吧,我们结束语音。 | 好的,**语音聊天就先结束啦**。… | ❌ 无 | last-human-left |
| 4 | 我们下次再聊。/ 拜拜 | 好的,下次再聊,保重哦! | ❌ 无 | last-human-left |
| 5 | 好,我要下线了,结束吧。 | 好的,随时想聊天再找我。保重,拜拜! | ❌ 无 | last-human-left |

**S1 = 0/5**(门要求 5/5)。注意第 3 场:模型**听懂了意图**(「语音聊天就先结束啦」),
只是没说约定的那句 `好，退出语音模式。` —— 它根本没收到那条规则。

另有 8 场早期/仪器场次,同样 0 次 `spoken_exit_detected`(累计 13 场 0 命中)。

### 2.2 根因(线级证据,已排除「模型不听话」这个读法)

先证 raya 侧全对:

- `parseVoiceConfig` 真读到 `startInstructionsFile`,`spokenExit = {enabled:true, graceMs:1500, drainTimeoutMs:5000}`;
- `composeStartInstructions(base, true)` 正确把整段【退出语音的规则】追加在 base 之后(实机打印比对无误);
- Codex 侧日志 `RealtimeConversationStart` 里 `realtime_start_instructions: Some("…【退出语音的规则】…")` **字面可见** ⇒ raya→app-server 这一腿是通的。

再证断在哪一腿(阳性对照 + 全量搜索):

- 把开场指令换成不可能被拒绝、也不可能被误读的强指令
  `You are Raya. You must ALWAYS reply in English only. Never use Chinese, no matter what language the user speaks.`
  → 模型**照样中文回答**(「我挺喜欢吃草莓的…」)。
- 同一场会话,Codex 发往 OpenAI realtime 的 `session.update.instructions` 是
  **Codex 自己的系统提示**(`You are Codex, an OpenAI general-purpose agentic assistant…`,payload 完整未截断,14,181 字符,结尾 tool 列表齐全)。
- 该会话窗口内**全部 251 条 realtime websocket wire 消息**,搜索
  `退出语音的规则` = **0 命中**,`ALWAYS reply in English` = **0 命中**。

⇒ **`realtime_start_instructions` 被 Codex app-server 丢弃,从不进入模型上下文。**
本单「口头合同」路线骑的正是这条腿,因此 G2 在真机上**没有任何工作面**。

先前一次弱对照(把水果偏好写进指令 → 模型答「芒果」)另附一个侧证:模型回答里出现了
「小蓉 / Xiaorong」这种**只可能来自 Codex 自身 startup context** 的称呼 ——
说明 persona 走的是另一条通道,不是本字段。

### 2.3 附带确认:检测侧的角色门是对的

有一场我让 emitter 直接说出那句约定语,STT 记为
`{"role":"user","text":"好,退出語音模式。"}` —— **没有**触发 `spoken_exit_detected`。
`isSpokenExit` 只吃 assistant·final·当代,这一条真机成立。

## 3. S2 / S3 语义门:**空过绿,不记为 PASS**

S2(反例不误退)与 S3(含糊先问)在这一版上**恒真** —— 因为触发器从未被触发过一次。
把它们写成 PASS 会是一个 vacuous green:它断言的那件事(判别力)在本次被测版本里
根本没有被行使。故如实记为 **N/A(机制未上线,判别力未被检验)**。

## 4. 已真机通过的部分(brain 侧,与 G2 无关)

在**隔离**环境下跑真 launchctl + 真 Discord(细节见 §6):

| 项 | 结果 | 证据 |
|---|---|---|
| V1 slash 注册 | ✅ | 未改动的 `registerGuildCommands` 在真 guild 建出两条命令:`voice` / `endvoice`,描述逐字一致,`default_member_permissions:"0"`,不发 `dm_permission`;Discord `/` 补全面板真机截图可见两条 |
| 文字口令进入(`进入语音模式`) | ✅ | brain 回「🎙️ 正在进入语音模式」→ marker 写入 → `launchctl kickstart` → job running(pid 69326)→ voice 公告「✅ 已进入语音模式，已连接现有 Voice Channel」 |
| 另一句进入口令(`现在我们进入语音模式`) | ✅ 解析正确 | marker 写入;当时 launchd 处于 `ThrottleInterval=60` 冷却,两次 kickstart 观察窗都不 running ⇒ 如实回「⚠️ 已请求语音模式，但语音进程仍未运行」(见 §5 观察 O1) |
| near-miss 提示 | ✅ | 「要进语音模式请发：进入语音模式，或用 /voice」真机可见 |
| V5 逃生门 · 健康格(文字门) | ✅ | 「正在退出语音模式」→ 2 s 内 job not running,`voice_exit{code:0,reason:"sigterm"}`,marker 清除,**无**强制结束告警 |
| V5 逃生门 · 腿死格(文字门) | ✅ | `kill -STOP` codex 子进程(pid 51954,state=T)后发停 → 3 s 内干净退出,`voice_exit{code:0,reason:"sigterm"}`,记录 `codex_stdin_error: write EPIPE` 但不影响收敛;停之前**没有**出现 `voice_exit{code:1}` |
| V5 逃生门 · 卡死格(文字门) | ✅ | `kill -STOP` voice 进程(pid 6244)后发停 → 「正在退出语音模式」(10:15:48)→ **32 s** → `last terminating signal = Killed: 9` → job 回到 not running → 才回「⚠️ 语音进程未响应，已强制结束」(10:16:20)。**先证收敛再回话**这条 R2 加固在真机上成立 |
| SIGKILL 后的 rebound 自终止 | ✅ | launchd `runs` 4 → rebound 实例读到 marker absent,输出 `{"status":"voice_mode_not_requested"}` 后 exit 0,最终 not running、marker absent |
| 离房退出(2074 既有第三道门) | ✅ | 每场 emitter 断开后 `voice_exit{code:0,reason:"last-human-left"}` |

## 5. 观察(非阻塞,交返工段判断)

- **O1 `ThrottleInterval=60` 与 `requested_but_down` 的相互作用**:一次强制结束之后立刻
  再进语音,launchd 在 60 s 冷却里只会 `spawn scheduled`,`start()` 的 2 次
  kickstart-观察都拿不到稳定 pid ⇒ 用户看到「⚠️ 已请求语音模式，但语音进程仍未运行」,
  而语音其实会在约 1 分钟后自己起来。回话在**说出口的那一刻是真的**,但对 founder 来说
  它读起来像失败。要不要在 `start()` 的重试预算里覆盖 throttle 窗口,是产品口径问题,
  不是缺陷 —— 交返工段和 founder 判。
- **O2 unit 与真机的落差本身值得记一笔**:241 项全绿、5 轮 Codex 设计评审通过,
  仍然整条核心路径不工作。缺的不是测试数量,是**一条能观察到「指令有没有到达模型」的判据**。
  返工时建议把这条做成可复跑的探针(阳性对照式:塞一条不可能被误读的指令,看模型行为变没变)。

销账记录(不改本报告 FAIL 结论):

- slash start 的 ACK 路径已由 `deferReply → editReply` 单测守住:`voice-mode-ux.test.ts:124,128` 验队列外 ACK 与最终文案，`:559,560` 验 gateway 真接线后的同一序列。
- connected 播报来自 voice 的 `DiscordReady` 既有路径，本 PR 对它零改动；真机在 10:07:37 / 10:08:36 / 10:14:25 / 10:15:34 各见一次「✅ 已进入语音模式，已连接现有 Voice Channel」。
- 因安全边界未验的只剩 slash ACK 在 Discord **真实用户客户端**里的渲染，不再把 ACK 顺序或 connected 播报记作代码缺口。

## 6. 隔离与生产零污染(teardown 已复核)

- 语音侧全部场次跑在 QA 目录 `~/.flywheel/raya/qa/FLY-2097/`(独立 state / metrics / logs / workspace),
  验收房 `voice-test-3`(`1542709028742893699`),文字回话也落在该房,**没有**碰 `#raya`、没有碰 General。
- brain 侧用的是 **QA bot**(flywheel-eng-lead 测试 bot),**生产 Raya brain 全程未停、未改**
  (`com.xrli.raya.brain` 持续 running)。
- launchctl 固定 label 临时改绑(Lead 已批准,plan §6 R6 预设路径):
  - 窗口 ≈ **10:10:20Z → 10:20:0xZ(约 10 分钟)**,低于 Lead 定的 15 分钟硬上限;
  - 改绑前 print:`path = ~/Library/LaunchAgents/com.xrli.raya.voice.plist`,args 指向 `raya-FLY-2074`,`state = not running`;
  - 改绑后 print:`path = ~/.flywheel/raya/qa/FLY-2097/launchd/QA-com.xrli.raya.voice.plist`,args 指向 `raya-FLY-2097`;
  - **复原后 print**:`path` 已指回 `~/Library/LaunchAgents/com.xrli.raya.voice.plist`,args 指回 `raya-FLY-2074`,stdout/stderr 指回 `~/.flywheel/raya/data/logs/`,`state = not running`(与改绑前一致);
  - 生产 plist 文件**全程零修改**:`diff` 与改绑前备份 **byte-identical**;
  - 生产 state 目录未被写入(`voice-mode.requested` 不存在,目录内文件日期仍为 8-27)。
- QA bot 在 guild 注册的两条 slash 命令已删除(DELETE 204 ×2,复查 `commands` 返回 `[]`),
  没有给 founder 的命令面板留下悬空条目。

## 7. 诚实边界(没测到的,以及为什么)

- **`/voice` · `/endvoice` 的真 slash 交互(V2 的 slash 半边、V5 六格里 slash 那三格)未跑。**
  slash 只能由**用户账号**发起,bot 发不了。以 founder 的登录态代她在 Discord 里发送消息
  被本会话的安全策略拦下(「代用户发消息」需要她本人授权),我没有绕过。
  ⇒ 这三格记 **「没测」,不是「不行」**。已覆盖的是同一段 `execute()`(marker + launchctl 梯子 +
  回话文案),未覆盖的是 `deferReply/editReply/followUp/ephemeral` 这层 Discord 交互适配
  (它有 25 项 `voice-mode-ux.test.ts` 单测,但没有真机)。
- **`spoken_exit_detected → 安静窗 → 干净拆除` 这条链的真机段未走通**:模型从不吐那句话,
  我也无法在不改代码的前提下让它吐(试过让它复述,它改写了)。该链只有单测覆盖。
- **founder 本人的听感(V3「听完结束语不被截音」)未验**:前置条件(自然退出)不成立。

## 8. 给返工段的最小清单

1. G2 的机制要换,不是调措辞。`realtimeStartInstructions` 这条腿在本机 Codex 上是死的
   —— 任何「把规则写进开场指令」的变体都会同样失败。
2. 换机制后,**先跑一次阳性对照**(塞一条不可能被误读的指令,证明这条新腿真能改变模型行为),
   再去量 S1。否则会重复本轮:5 轮设计评审 + 241 项绿测 + 0/5 真机。
3. slash 侧、逃生梯子侧、marker 契约侧本轮真机全过,**不需要返工**;
   返工请尽量不动 `apps/brain/src/voice-mode.ts` 已验证的部分。

## 9. 证据落点

`~/.flywheel/raya/qa/FLY-2097/`(未提交入仓,含 Discord/OpenAI 凭据派生物与音频):
`evidence/S1-run{1..5}/raya-evidence.jsonl`(每场 transcript + voice_exit)、
`evidence/INSTRUMENT-*`(仪器/阳性对照场次)、`evidence/brain-gateway.jsonl`、
`evidence/legdead-driver.jsonl`、`logs/voice.launchd.*.log`、
`launchd/{QA-,PROD-BACKUP-}com.xrli.raya.voice.plist`。
Codex 线级证据在 `~/.flywheel/raya/codex-home/logs_2.sqlite`(`logs` 表,
`target like '%realtime_websocket::wire%'`,窗口 2026-08-28T10:01:15Z–10:01:40Z)。

## 10. 返工节点机制证据(不改本报告 FAIL verdict)

返工 candidate raya `4a67508` 把退出合同从死字段 `realtimeStartInstructions` 移到行为阳性对照已证有效的 `thread/realtime/start.prompt`；同时只把 O1 回话改为观测事实 + 条件提示，不改 launchctl 状态机。

- 全仓门：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test` 全绿；仍为 **241 passed**(contracts 22 · voice 135 · brain 84)。
- 编译后探针走 `apps/voice/dist/codex/RealtimeTransport.js` 本身，不手拼 start RPC；start 后 1.5 s 输入前观察窗里 assistant final = `[]`，没有自发退出。
- 同一 compiled-transport session 用实际退出协议 + `appendSpeech`：三个明确意图 3/3 得到精确 `好，退出语音模式。`；「我不想退出这个话题」未出哨兵并继续聊天。
- 上述 probe 绕过 STT，是**合同送达与模型行为证据**，不是 S1/S2/S3 真声验收。权威 verdict 只有 QA 在新 head 上重跑英文阳性对照、输入前静默断言与真声 5/5 / 阴性门之后才能更新。
- Rework code review question `135e6638-1a97-4dd1-88ba-3bb0d6585976` 对精确 head `4a67508a86f2b12ee010f643fc4780901b8670fc` 给出 `reviewVerdict=APPROVED`。四条 MEDIUM/LOW advisory 已报 Lead，均不改变本报告的诚实边界：实现节点的机制证据已通过，真声验收 verdict 仍由下游 QA 重跑决定。


---

# QA attempt 2 —— 返工 head 复验(2026-08-28)

**结论: PASS**(硬门全绿),外加一条点名移交 FLY-2030 的项。
被测 head: raya `4a67508a86f2b12ee010f643fc4780901b8670fc`(远端 `fly-2097-raya-voice-ux` 已核一致,worktree 干净)。
返工 diff 极小:`RealtimeTransport.ts` 把 `realtimeStartInstructions` 换成 `prompt`(1 行),
brain 侧 `start_requested_but_down` 文案 1 行,加两处对应单测。launchctl 状态机零改动。

## A. 全仓门

`pnpm lint` / `typecheck` / `build` / `test` 全绿,仍为 **241 passed**(contracts 22 · voice 135 · brain 84)。

## B. 仪器先行(我上一轮给自己开的药方,这次先吃)

同一条不可能被误读的英文阳性对照 `You must ALWAYS reply in English only. Never use Chinese`:

| head | 用中文问「你最喜欢什么水果?」 |
|---|---|
| 46b5b6b(旧字段 `realtimeStartInstructions`) | 中文回答 ⇒ 指令**没到** |
| 4a67508(新字段 `prompt`) | **英文回答**(`I don't actually eat, but if I had to pick...`)⇒ 指令**到了** |

⇒ 送达腿活了。这是本轮所有结论的承重腿。

### ⚠️ 对第一轮一条证据的成色更正(结论不变,权重下调)

第一轮我把「该会话 251 条 realtime wire 消息里 0 命中」当成根因的强证据。**这条不成立**:
本轮对**已经生效**的 `prompt` 做同样查询同样是 0 命中(249 条 0 命中,而模型确实改说英文了);
再查下去,最后一条被记录的 `RealtimeConversationStart` 停在 10:50:50,我 15:44 之后跑的所有场次
**根本没有 start 期日志** —— 那个 0 是「没记」不是「没发」。
⇒ **wire 计数不是「有没有送达」的可靠代理**,已从证据链中剔除。
第一轮的结论本身不变(它真正的承重腿一直是行为阳性对照 + S1 门 0 命中),但读者不应再把 wire 计数当证据。

## C. 语义硬门(真机 voice-test-3,TTS emitter + 真 Codex realtime)

| 门 | 要求 | 实测 | 结果 |
|---|---|---|---|
| S1 明确退出 | 5/5 各拆除一次 | **5/5** | ✅ |
| S2 意图相反 | 0/3 误退 | **0/3** | ✅ |
| S3 含糊未确认 | 0/3 误退 | **0/3** | ✅ |
| 静默窗 | 无自发触发 | 40 s 全静默,无 transcript、无检测、无异常退出 | ✅ |

S1 五场逐字:五句不同的明确退出意图(「OK,我现在要退出了」「好了,我要退出语音了」「先到这里吧,我们结束语音」
「我们下次再聊/拜拜」「好,我要下线了,结束吧」)全部得到**逐字**`好，退出语音模式。`
→ `spoken_exit_detected` → `voice_exit{code:0, reason:"spoken-exit"}`。

- detect→exit 延迟:**1827 / 1886 / 1881 / 1827 / 2127 ms** —— 1.5 s 安静窗被遵守(结束语不会被截),远低于 5 s drain 上限。
- **零** `spoken_exit_grace_capped`、**零** `spoken_exit_cancelled`;marker 五场全部清除。
- Discord 下线文案正确区分:spoken exit 发「我下线了(语音退出)」,离房退出发「我下线了」。

S2 三句(含「我不想退出这个话题」「上次那个项目结束得太仓促了」「我最近在想怎么退出那个订阅服务」)
全部照常对话、无检测、session 保持 Live 直到 emitter 离房。

**S3 的精确读法**:三句含糊话(「差不多了吧」「就这样吧」「算了」)**0/3 误退,门通过**;
但模型**一次都没有**问出设计里那句「要退出语音吗?」,只是继续聊天。
按 plan §6 S3 的通过标准(0/3 误退为硬要求,确认问句是「记为符合预期」的加分项)它算过,
但「拿不准时先问一句」这个**设计意图在真机上一次都没有被观察到** —— 如实记,不当作已验证。

## D. 换通道的副作用:一次受控 A/B(同探针 · 同房 · 同 QA env · 相隔数分钟)

换 `prompt` 相当于把 realtime session 的系统提示从「Codex 自己的 agent 提示」换成了「Raya 的开场指令」。
我先怀疑这会打掉 Raya 的能力,做了 A/B,结果**方向和我最初的怀疑相反**:

| 探针 | 生产 2074 构建(旧字段) | 候选 4a67508(新字段) |
|---|---|---|
| 「你是谁?你的角色和职责是什么?」 | 「我是 **Codex**，你的全能助手伙伴…数字瑞士军刀」/ 泛化助手自述(0/2 自称 Raya) | 「我是 **Raya**…」(**2/2** 自称 Raya) |
| 「你还记得我是谁吗?叫我的名字」 | 「当然，**Xiaorong**」(2/2 叫得出) | 「没有办法记住你的身份」(**2/2** 叫不出) |
| 「帮我在后台跑一下,看看工程目录有几个文件」 | 30 s 窗内无回答(inconclusive,疑似慢) | **2/2 成功**:「4,376 个文件」 |

**读法**:旧字段是死的,所以**生产语音一直跑在 Codex 的系统提示上** —— 她之所以会喊「Xiaorong」,
是因为那段 Codex 提示里字面写着 `The user's name is Xiaorong`(第一轮 wire dump 可见),
**那是 Codex 的账号级个性化,不是 Raya 认识 founder**。换通道之后 Raya 的开场指令第一次真正生效,
她开始自称 Raya、委托后台的能力仍在;代价是 Codex 那段账号个性化连同名字一起不再下发。

⇒ 准确的说法不是「Raya 不再认识 founder」,而是「**Codex 不再替 Raya 认识 founder**」。
Raya 自己从来没有通过这条腿拿到过 founder 身份:生产 `raya.env` 与 voice plist **都没有配**
`startInstructionsFile`,语音侧一直用的是硬编码那一行
「你是 Raya。始终用简短、自然的中文口语回答；需要工具时可以委托后台 Codex。」,
`IDENTITY.md` / `MEMORY.md` 根本不走语音这条腿。

**founder 可感知格(必须写明)**:从这版起,她在语音里**暂时不会再被叫名字**,直到开场指令内容补上。
修法就是往开场指令里写清她是谁 —— 而「**开场指令的内容**」是本 plan §0.2 白纸黑字划给 **FLY-2030** 的非目标。
移交项已由 Lead 落地到 FLY-2030(Linear comment + M2 义务清单)。

## E. brain 侧定向回归(Lead 批准的 a/b/c 三格,不做六格全跑)

理由:brain 本轮 diff 只有一行文案常量,launchctl 梯子零改动;六格已在 attempt 1 的 46b5b6b 上全过。

| 格 | 实测 | 结果 |
|---|---|---|
| (a) 文字口令进入 | 16:14:39 `进入语音模式` → 「已在语音模式」(job running + marker present 的 fail-closed 正解) | ✅ |
| (b) 文字口令停止 | 16:14:59 → 「正在退出语音模式」→ voice「我下线了」→ `voice_exit{0,"sigterm"}` → job not running、marker absent | ✅ |
| (c) **新文案真机出现** | 强制结束/冷却期内再进语音,3 次拿到新文案「⚠️ 已请求语音模式，但暂未观测到语音进程运行；若刚强制结束过，请约 1 分钟后再确认。」 | ✅ |

**(c) 顺带把 O1 这条 advisory 验穿了**:16:12:24 请求 → 16:12:34 回新文案 → **16:13:25(61 秒后)**
voice 真的起来并公告「✅ 已进入语音模式，已连接现有 Voice Channel」。
新文案承诺的「约 1 分钟」在真机上**是准的**,O1 从「读起来像失败」变成「读起来是真话」。

## F. 隔离与复原(两个窗口,四条硬边界逐条留证)

- 窗口 1:`16:11:19Z → 16:12:46Z`(1m27s);窗口 2:`16:13:23Z → 16:15:02Z`(1m39s)。均远低于 15 分钟上限。
- 复原写在 `trap ... EXIT` 里,**任何失败都不会跳过**;两次复原后 print 均为
  `path = ~/Library/LaunchAgents/com.xrli.raya.voice.plist`、args 指回 `raya-FLY-2074`、
  stdout/stderr 指回 `~/.flywheel/raya/data/logs/`、`state = not running`。
- 生产 plist 文件与改绑前备份 **byte-identical**(两次窗口各验一次)。
- 生产 Raya brain 全程 running、未停未改;窗口内无 founder 使用迹象。
- 语音侧全部场次仍在 QA 目录 + `voice-test-3`,未碰 `#raya`、未碰 General。

## G. 诚实边界(attempt 2 仍未测到的)

- **slash 交互三格仍未测**:原因不变 —— slash 只能用户账号发起,代 founder 发消息被安全策略拦下,我没绕。
  记「没测」,不是「不行」。已覆盖同一段 `execute()`;未覆盖 `deferReply/editReply/followUp/ephemeral` 适配层。
- **「拿不准先问」未观察到**(见 §C)。
- **founder 本人听感**未验:她在睡;S1 五场的下行音频只由 emitter 的接收端确认有包(2,433/1,293/… packets),
  「她听完整句没被截音」这一格要她本人确认。detect→exit 的 1.8–2.1 s 与零 `grace_capped` 是间接支持,不是替代。
- **委托后台在生产 2074 那一格 inconclusive**(30 s 内无回答),我没有把它读成「旧版失能」。
