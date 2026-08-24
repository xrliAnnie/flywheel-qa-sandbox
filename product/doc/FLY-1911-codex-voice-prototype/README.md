# FLY-1911 · Codex 语音 PoC 存档 —— **从这里开始读**

> **这是什么**:2026-08-20 ~ 08-24 做的一次可行性验证(PoC)的**全部原件**:能跑的桥、量出来的账、
> 走过的弯路、以及为什么某些路走不通。
> **它不是产品,也不是给工程的规格。** 规格在 **FLY-1850**(B 随身语音)和 **FLY-1851**(C 会议模式)两份 PRD 里。
> **留它的理由(Annie 2026-08-24 原话)**:「它怎么样做 poc 的这些东西,我们都先保留下来,
> 等之后实际去真正做这部分的时候就可以参考。」

## 一句话结论

**Codex 语音这条路做得成 —— 用 v2 通道,端到端真的会说、会听、会干活,founder 本人真机跑通过。**
**v3 通道当前被上游堵死**(见下面「上游阻塞」),**不是我们没做出来。**

---

## 从哪读起(按你有多少时间选一条)

| 你有 | 读这些 | 你会拿到 |
|---|---|---|
| **5 分钟** | 本文件 + [`HANDOFF.md`](HANDOFF.md) | 结论、v2/v3 的差别、别重做什么 |
| **半小时** | ↑ 再加 [`evidence/Z6-FINAL-LEDGER.md`](evidence/Z6-FINAL-LEDGER.md) + 本文「坑清单」 | 每个数字的出处 + 前人踩过的坑 |
| **要动手建这个功能** | ↑ 再加 [`HANDOFF-2026-08-24.md`](HANDOFF-2026-08-24.md) + [`prototype/`](prototype/) + 两份 PRD | 能跑的代码 + 产品化时必须改形状的那几格 |

⚠️ **[`decisions.md`](decisions.md)(36 万字符、按时间追加)不是给人从头读的。** 它是流水账;
入口是上面这张表。

---

## 口径:**验到了什么 / 没验什么**

### ✅ 验到了(都有实测原件)

| | 结论 | **原件在哪**(可自行复核) |
|---|---|---|
| 真出声 | 录到真实语音波形,不是静音文件 | `evidence/S1-v2-ws-speech.wav` + 同名 `-manifest.json` |
| 真听懂 | **合成音**下 v3 逐字全对(节拍器 ≥47.9 帧/秒时 5/5);v2 会把 `flywheel`→「李维尔」 | `evidence/S2-v2-ws-listen.*`;逐字对那张表在 `evidence/Z6-FINAL-LEDGER.md` |
| 打断 | 服务端 150 / 217 毫秒停口,两次独立 | `evidence/S4-bargein-long.jsonl` · `evidence/S5-long10-manifest.json`(probe = `barge-in + long session`) |
| 长会话 | 连聊 10.4 分钟零故障;另测 30 分钟静默不断线 | `evidence/S5-long10.*` |
| 端到端一圈 | 她说一句 → 它真跑 `gh pr list` → 中文念出正确答案(数字独立复核过) | `evidence/E1-endtoend.*` · `evidence/E2-endtoend.*` + 回答音频 `E2-endtoend-reply.wav` |
| 耳朵归谁 | **Codex 能自己扛嘴+耳**,不必混合别家 | `evidence/S2-*` + `evidence/X3-v3-complete.*` |
| Discord 语音腿 | 进房 701ms · 它的回答从房里放出来 · 另一个 bot 听见并解码成 wav | `evidence/D1-join-orchestrator.jsonl` · `D3-speak-in-room.jsonl` · `D4-ears-heard.wav` |
| 桥真的把声音放进房 | 静音负对照峰值 **0** vs 它回答时峰值 **17465**;Codex 交出 10.95s → 房里响 10.73s(2% 内) | `evidence/AN1-result.json` · `AN1-room-speech-only.wav` · 尺子 `AN1-measure.py` |

⚠️ **成色标注(别略过)**:上表里 **`AN1-*` 那一行是我(08-24 这一轮)亲手量的**;
**其余各行是前几轮 runner 量的,我没有逐条复跑** —— 我核的是**原件在不在、指得对不对**。
⇒ 真要拿某个数字去定参数,**先打开它的原件**,别只信这张表。

### ⛔ **没验**(别当成验过了)

- **v3 在真人语音上听得准不准 —— 零场次。** 七场合成音的结果**不能外推到她的声音**;
  她本人那场 v3 在她开口之前就死了(`evidence/Z6-FINAL-LEDGER.md` 末节)。
- **「像不像人」** —— 这一栏是她的,我们听不见,不替她判。
- **开半小时会的同时还能不能 orchestrate** —— 最糟的失败模式已排除,真正那条**未量**。
- **是不是所有 Lead 都该换 Codex** —— 本单没碰。

---

## 目录

```
README.md              ← 你在这里(入口)
HANDOFF.md             结论 + 「不要重做什么」
HANDOFF-2026-08-23.md  语音起不来那一夜(⚠️ 其「挡在最前面」已过期,见 08-24)
HANDOFF-2026-08-24.md  最新:她听不到那一场 + 播放账仪器 + 撤不掉的 founder 卡
exploration.md / research.md / plan.md   立项三件套
decisions.md           流水账(36 万字符,查证用,不通读)
codex-voice-*.html     四张 founder 卡(codex-voice-silence.html 已作废,文件内有戳)
prototype/             ⭐ 能跑的代码(含 起桥.sh)
evidence/              286 份实验原件(README.md 说明命名法;Z6-FINAL-LEDGER.md 是账本)
beds/ cues/ voices/ box/ speak/   等待音 / 提示音 / 音色 的挑选实验
```

---

## 怎么跑起来

```bash
cd prototype && npm install          # @discordjs/voice · discord.js · opusscript · werift 等
# 起一场给人真聊的会话(v2 通道)
GUILD_ID=… VOICE_CHANNEL_ID=… TEXT_CHANNEL_ID=… \
  HL=1 RT_VERSION=v2 RT_VOICE=marin OUT=x-bridge RUN_MIN=60 TOKEN_VAR=TEST_BOT_TOKEN_1 \
  node bridge-hl.mjs
```

🔴 **两个必踩的坑,先看这里**:

1. **`bridge-hl.mjs` 里 codex 二进制路径是【硬编码绝对路径】**
   (`~/.codex-mufasa/packages/standalone/releases/0.148.0-…/bin/codex`)。
   换机器一定要改,或用 `CODEX_BIN` 覆盖。
   ⚠️ **它和 `PATH` 上的 `codex` 不是同一个版本** —— 凡是用 `codex --version` / `login status`
   量到的东西,量的是**另一个二进制**。
2. 🔴 **`prototype/起桥.sh` 的默认值现在会失败** —— 它默认 `RT_VERSION=v3` / `RT_VOICE=cove`,
   而 **v3 已被上游堵死**(见下面 FLY-2021)。⇒ 现在要跑,必须覆盖成 `RT_VERSION=v2 RT_VOICE=marin`。
   ⚠️ 这个文件**按原样存档、一个字节没改**(它记录的是当时的样子),所以坑写在这里,不写进它。
3. **`RT_VOICE` 必须匹配通道**:`marin` 是 v2 音色,`cove` 是 v1/v3 音色。
   **配错不会报错,会安静地【会话根本没建立】**,而 manifest 里照样写 `outcome: alive`(见坑 ①)。

**跑 `evidence/` 里的探针**:那些 `.mjs` 用的是同一批依赖,但 `evidence/` 下没有自己的 `package.json`
⇒ 从 `prototype/` 里跑,或把脚本复制到 `prototype/` 下再跑。
✅ 已核过:`prototype/package.json` **覆盖了两个目录里所有脚本用到的外部包**
(`@discordjs/voice` · `discord.js` · `libsodium-wrappers` · `opusscript` · `werift`);
所有相对 import 也都指在仓库内。`prism-media` 声明了但没人用 —— **存档照原样留着,不清理。**

### 两个从实验目录捞进来的工具(出处)

| 文件 | 是什么 | 出处 |
|---|---|---|
| `evidence/tadashi-v3-probe.mjs` | **v3 握手探针,不碰 Discord** —— FLY-2021 那张证伪矩阵就是它跑出来的 | Tadashi 写的,原在 `~/.fly1911/`,**按原样存档** |
| `prototype/起桥.sh` | 起一场给真人聊的会话(包着 `bridge2.mjs`) | 原在 `~/.fly1911/`,**按原样存档**;⚠️ 默认值已失效,见上面坑 2 |

📌 **为什么探针放 `evidence/` 而不是 `prototype/`**:仓库的 lint 有一条既有豁免
`!product/doc/**/evidence/**` —— 一次性探针**按原样存档**(不重排格式)正是那条豁免要保护的东西,
而 `prototype/` 不在豁免里。⇒ 放进 `evidence/` 既保住了**字节不变**,也不用去改仓库配置。
(而且那里本来就是探针的家:`v3probe.mjs` / `v3full.mjs` 都在。)

⇒ **为什么要捞进来**:它们原本只存在于 `~/.fly1911/`(仓库外)。
文档里指着一个仓库外的路径,**半年后那里什么都没有,而且不会有任何东西报错** ——
这正是坑清单第 ⑤ 条(靠匹配活着的东西,失败方式是安静地什么都没有)在文档上的同一种形态。

---

## 🔴 坑清单 —— 试过但不成立的路,以及为什么

> **这一节对后来人比成功路径更值钱。** 每一条都是真花过时间的。

### 关于「怎么判断成功」

| ① **`manifest.outcome` 有已知假绿** | 八场 v2 全部 `never_started`,manifest 里写的全是 `alive`。⇒ **别读那个字段**,用 `evidence/Z4-recompute.mjs` 三层重算(键不存在 / 值空 / 有值)。 |
|---|---|
| ② **判据会随字段演化悄悄冤枉历史场次** | 旧判据要求 `realtimeStartedAt` 非空,而那个字段是后加的 ⇒ **48 场落在射程里**被一律判失败(其中 9 场能当场证明是成功的)。⇒ **两个数必须并排写**:只报 9 会让人以为影响很小。 |
| ③ **检查器和被检查对象会一起过时** | 修「键不存在 ≠ 值为空」时,同一个病在读取器自己身上又犯了一次。⇒ 修字段的历史兼容性时,**先问用来检查它的工具有没有同一个毛病**。 |
| ④ **只收当前命名的筛子会静默挡掉历史** | `-bridge-manifest.json` 这个 glob 把老场次挡在视野外,不报错。⇒ 正确写法是**列出已知不该算的**,然后收其余。 |
| ⑤ **靠 glob 活着的监视器,匹配到 0 个时必须尖叫** | 监视器盯错文件名 ⇒ 一个都没匹配 ⇒ 循环「继续等」⇒ 跑到超时报「没检测到关闭」——**读起来像好消息**。 |
| ⑥ **正式路径上的修复不会流进随手写的临时检查** | 「只提到脚本名的进程不算并发」修进了 `bridge2.mjs`,但收尾时命令行随手 `pgrep` 用的仍是修复前写法。**临时检查最容易漏掉修复。** |

### 关于「怎么量」

| ⑦ **`缓冲见底次数` 不是断音次数** | 它是我们在**自己的时刻**看到的近似(30 秒里 80 次),而**播放器自己记的 `missedFrames` 是 0**。⇒ **判断断音只能用后者。** |
|---|---|
| ⑧ **Discord 的「开始说话」事件量不了首声延迟** | 下行是**常开流**(不送静音流就会被 idle 掉),服务端眼里它一直在说话。⇒ **只能量波形。** |
| ⑨ **播放账目原来只在整场收尾记一次** | ⇒ 中途被放弃的场次**一条记录都不留**,而那正是最需要复盘的。**已修**:每 30 秒记一次(`OUT-ACCOUNT`)。 |
| ⑩ **`pkill` 收桥会静默吞掉计数器** | 计数器只在正常收尾写一次。她那四场的音频计数就是这样没的。 |
| ⑪ **要判「房里到底有没有声音」,必须有静音负对照** | 只录到波形说明不了什么;**先证明没人说话时录出来是逐样本 0**,那条空白才是硬度所在(`evidence/AN1-*`)。 |

### 关于「上下文进不进得去」

| ⑫ **语音侧拿到的是【有预算的摘要】,不是我们塞给 thread 的那份** | 语音 prompt = `params.prompt` + `build_realtime_startup_context`(**总预算 5,300 tokens**)+ `realtime_start_instructions`(**逐字**,上限 8,192)。而我们塞进 thread 的身份载荷是 **73,354 字符**。⇒ ⭐ **要让语音侧可靠知道的东西,必须走逐字通道。** |
|---|---|
| ⑬ **「让它自己去读议题」不可靠** | 短间隔(24/34/38 秒)会去读,长间隔(510/798 秒)不会;客户端侧无 idle 机制(源码 grep `idle/reconnect/heartbeat/keepalive` = 0 命中),剩下的(服务端 / 模型判断)**我们够不着**。⇒ 修法是**把那个变量从产品里拿掉**:有人进房那一刻直接把议题喂进逐字通道。 |
| ⑭ **⚠️ 但「二次进房重新喂」没实现** | 代码级事实:一次性 `await new Promise` + `dc.off`,`realtime/start` 只走一次。⇒ **她进→出→再进,第二次会复发。** 试过改成「每次进房重建会话」,那一版第一次进房就不能说话,已回滚。<br>📌 **教训:改动能工作的代码时,重构和行为变更不许放在同一次提交** —— 回归时分不开。 |

### 关于「运行环境」

| ⑮ **realtime 烧的是【平台预付余额】,不是订阅额度** | 余额烧到 $0 时服务端回 `insufficient_quota`,而 **codex 二进制把它吞成「Connection closed normally」**。⇒ 查了半夜的「会话起不来」根因在这里。<br>⭐ **同名的两本账**:「额度 33%」量的是订阅账。**说「X 已排除」前,先确认量的是不是同一个 X。** |
|---|---|
| ⑯ **`bridge-hl.mjs` 的 v3 麦克风不能停** | 停止推流 **24.7 秒**后服务端关闭会话;持续送静音帧则活 **169.9 秒**。⇒ 产品化时**「沉默」必须实现成「持续送静音」**。 |
| ⑰ **中继发给 Lead 的消息 100% 被吞** | 发件身份必须是**注册过的 session**,否则 `revoked_orphan` 且**永久**撤销(`question-admission.ts:226`)。对照:未注册身份 9 条 100% 死 vs 已注册 250 条 246 ACKED。<br>⛔ **修之前先答**:给一个不是 runner 的东西登记 session,会不会污染巡检名册 / 被当 orphan 回收? |

### 关于「给 founder 看东西」

| ⑱ **托管卡的 CSP 没有 `media-src`** | `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'; img-src data:;` ⇒ **内嵌 `<audio>` 会被【静默】拦掉**(页面照开,点了没反应)。⇒ 波形要用**内联 SVG**;音频只能由 Lead 在 Discord 当附件发。 |
|---|---|
| ⑲ **founder_review 开了就撤不掉 —— 任何角色都不行** | `respond.ts` 对 founder_review **无条件 throw,不分调用者**;`mailbox` 虽有 `superseded_at`/`superseded_by`,**全仓唯一写它们的 SQL 在测试文件里**。⇒ 已两次撞上(卡 `3d832c54`、卡 `70c23dd4`)。 |
| ⑳ **开 `founder_review` 这个动作本身就是投递** | Bridge 会 @ 她并带托管链接。⇒ ⭐ **任何会到达她的动作都算「叫她」**:开卡 / 发链接 / 开 gate / @她,同一类。 |
| ㉑ **她要的不是「进去之后才刷出来」** | 她原话:「为什么房间里面本来是空的,我进去了之后才刷出来?**这个也不是我要的效果呀**」。⇒ WAIT-HUMAN 让她**必然先看到一个空房**。<br>⚠️ **这是需求不是 bug** —— 产品化时这一格要**改形状,不能照抄原型**。 |

---

## 上游阻塞:v3 现在走不通(**FLY-2021**)

**[FLY-2021](https://linear.app/geoforge3d/issue/FLY-2021)**(2026-08-24 02:32–02:39Z,Tadashi 的探针):
v3(WebRTC / AVAS 订阅后端)在 `thread/realtime/start` 之后**立即** `thread/realtime/error`:
`Field session.model is not allowed for this Codex realtime session` —— **SDP answer 永不回,握手第一步即死。**

证伪矩阵(每一格都试过):三个二进制版本(0.148.0 / 0.149.1 / 0.150.0-alpha.7)**逐字同错** ·
有 API key / 无 key 同错 · 音色无关(错在握手前) · config 旋钮改不掉(客户端恒发 `session.model`)。
⇒ **定性:上游客户端与 AVAS 服务端 API 漂移,我方没有 sanctioned 修复面。**

### ⚠️ 一处边界:**FLY-2021 不解释那个「约 35 秒硬切」**

两者**失败形状不同**,不许当成同一个根因:

```
FLY-2021        握手第一步就死,SDP answer 永不回,转写 0 / 回答 0
约 35 秒硬切     握手成功、有 SDP、有音频来回,跑到 33–35 秒被切
                (六次:33.03 34.84 35.13 34.93 34.94 34.78,全距 2.10 秒)
```
⇒ **35 秒硬切的成因仍然没有查出来。** 它是**在 v3 还能握手的时候**量到的。
⛔ 不许写成「v3 的问题已经定位了」——**定位的是「现在连握手都不行」,不是「当时为什么 35 秒被切」。**

---

## 会过期的结论(逐条给 as-of + 重核办法)

| 结论 | as-of | 怎么重核 |
|---|---|---|
| v2 端到端可用 | 2026-08-24 01:20(她本人真机) | 按上面「怎么跑起来」起一场 |
| v3 被上游堵死 | 2026-08-24 02:39 | 重跑 `evidence/tadashi-v3-probe.mjs`(已存进仓库);上游 release 后再试 |
| 桥跑的二进制 = 0.148.0 | 2026-08-23 | `grep -n 'releases/' prototype/bridge-hl.mjs` |
| 托管页 CSP 无 `media-src` | 2026-08-24 01:45 | `curl <托管URL> \| grep -o 'content="default-src[^"]*"'` |
| 约 35 秒硬切 | v3 还能握手的那几天 | ⛔ **现在无法重核** —— 握手已被上游拒,复现不了 |

---

## ⛔ 别重做的

- **不要重跑「30 秒静音会断线」那个假说** —— 已推翻(判据事先写死并交到她手上)。
- **不要拿 `rate-v2-*` 当数据** —— 整批作废(`evidence/Z5-rate-v2-VOID.md`),音色配错导致会话从未建立。
- **不要拿 ChatGPT App 的体验去推 v2/v3 任何一方** —— GPT-Live 是独立第三套系统。
- **不要把 PoC 的实现方式当成给工程的规格** —— 规格在 FLY-1850 / FLY-1851。
