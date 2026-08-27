# FLY-2074 Raya 实时语音流水线正经重写 — 探索
Issue: FLY-2074 (https://linear.app/geoforge3d/issue/FLY-2074/raya语音通道-实时语音流水线按-prd-正经重写常开连接音频流断流重连语义原型权宜不带-自-fly-2029-拆出)
日期: 2026-08-26
基于: 无

> 读法:本文只回答「要做的到底是什么、哪些已经定了、哪些还开着」。技术事实与协议细节在 `research.md`,拆法在 `plan.md`。
> 成色标注沿用 PRD 的规矩:✅ 她的原话/她验过 · 🔶 Lead/HL 定向 · ⬜ 无出处/未验。**⛔ 不把 🔶 当成她说过的话。**

## 0. 一句话

把 FLY-1911 PoC 里「能跑但权宜」的 Discord 语音房 ↔ Codex realtime(v2)那条桥,**按 B/C 两份 PRD 的规格重写成 Raya 仓里的一个常驻语音管线**:常开连接、双向常开音频流、三条腿各自的断流重连语义、以及「没有声音 = 送静音」这套静音语义 —— 并为试用期三指标之一「实际 context 用量」留埋点。

## 1. 来源与边界(先把「谁的活」划清)

### 1.1 本单来自哪里

| | |
|---|---|
| 拆出自 | FLY-2029(Raya V1 地基)。founder 2026-08-26 裁定:「类型与复杂度不同的东西不揉一单」 |
| 规格来源 | **FLY-1850(B 随身语音)PRD v1.0** + **FLY-1851(C 会议模式)PRD v2.0** 里关于链路的条款;**FLY-1846(A)PRD v1.7** 里的架构判据(§8.5)与三指标(§9.1b/§13.0a) |
| 原型来源 | **FLY-1911**(PR #896 merged):`product/doc/FLY-1911-codex-voice-prototype/prototype/bridge-hl.mjs` + 21 条坑清单 + 286 份证据。**它是存档不是规格**(README 原话) |
| 挂载 | EPIC FLY-1451 |
| 形态 | 三段式(design → implement → QA),Fable |

### 1.2 「昨晚验证跑通的语音通道」指的是哪一条 —— 核过

Issue 写「昨晚验证跑通」。核 `~/.fly1911/` 最后写入时间 = 2026-08-23 19:37 PT(= 08-24 02:37Z),之后没有新场次;FLY-1451 comment(08-24)与 1911 `HANDOFF-2026-08-24.md` 记的正是 **2026-08-24 01:20Z 她本人真机那一场(v2,tad1 桥,`bridge-hl.mjs`)**。
⇒ **参考对象 = `bridge-hl.mjs` 跑 `RT_VERSION=v2 RT_VOICE=marin` 的那条路。** ⚠️ 若 founder 指的是别的场次,这一句要改;我没有找到更晚的场次。

### 1.3 本单管什么 / 不管什么

```
✅ 管:Discord 语音房 ↔ Codex app-server realtime(v2)之间【整条实时链路】
      ① 常开连接:桥常驻、bot 常在房、codex 进程与 realtime 会话的生命周期
      ② 音频流管线:上行(她→它)/ 下行(它→她)两条 20ms 常开流,含重采样、抖动缓冲、混音总线
      ③ 断流重连语义:Discord 腿 / codex 进程腿 / realtime 会话腿 三条腿各自的失效检测与恢复
      ④ 静音语义:线上「没声音 = 送静音」;她闭麦时链路怎么活;「它在忙」的可听指示怎么混进去
      ⑤ 状态面:文字频道的 listening / 双方转写 / 断线一行(她 2026-07-17 定的形态,8-20 改成跟着对话流走)
      ⑥ 埋点:realtime 会话的实际 context 用量(三指标 ③),以文件接口交给 2029 的记录器

⛔ 不管(各归其单):
      仓/身份/CODEX_HOME/模型参数/#raya 文字/状态频道/头像/三指标记录器本身 → FLY-2029
      它【说什么】:状态吸收、追问、议题、身份载荷内容                 → FLY-2030
      念读筛选、转达 Lead、用嘴批 ship、Lead relay(hl-relay.mjs 那条)   → FLY-2031
      会议模式:多 Lead 同房、会议产物                                  → FLY-2032 / 2033
      v3 上游阻塞的成因与解法                                          → FLY-2021(Tadashi 盯)
      语音控制电脑的 OS 级隔离                                          → FLY-1453
```

## 2. 已定前提(每条带出处,⛔ 不重新论证)

### 2.1 载体与版本

| 前提 | 出处 | 成色 |
|---|---|---|
| vendor = Codex,嘴和耳朵都是 Codex | A §8.6.1;C R-28 | ✅ 她拍的 |
| realtime 版本 = **v2**(websocket 传输,音频走 JSON-RPC) | B §6.5;C R-34/§30 | ✅ 她本人 2026-08-20 拍的 |
| v3 当前被上游堵死:`session.model` 字段被 AVAS 拒 | FLY-2021 | ✅ Tadashi 探针,三个二进制版本同错 |
| **选 v2 = 明知放弃「打断」与「先应一声」**,换连接稳定性 | B §6.5【3】;C §30 | ✅ 她实测过打不断(排队不丢);⛔ 不写成「以后补」 |
| 打断能不能做 → 交工程实施时判定 | B §6.5(2026-08-24 她裁) | ✅ 「如果打断可以做,我们就做;如果做起来很困难,就算了」 |
| 模型 gpt-5.6-sol · xhigh · 1M 仅单会话参数 | A §8.6.1/§8.6.6;FLY-2029 | ✅(参数本身归 2029) |
| 音色规则:音色跟 Lead 人设对上;主管 Lead = `marin` | B §6.5 | ✅ 她纠正过的规则 |

### 2.2 链路硬前提

| 前提 | 出处 | 成色 |
|---|---|---|
| **链路每一段都必须是常开流:没有声音必须实现成「送静音」,不能「不送」** | B §3.1d;C §17/§25 | ✅ 1911 实测(下行 player idle 不再消费;上行 Discord 只在说话时有包 ⇒ VAD 判不出说完) |
| Codex 会话腿:一直送静音能撑 30 分钟静默(v3 上 n=1);v2 结构上「永不空闲」 | C §25;B §6.2 | ✅ 实测(v3)/ ⚠️ v2 是源码读到,未量 |
| **Discord 腿在半小时量级上一个数都没有**(P-6c 只证了 codex 侧) | C §25/§4305 行 | 🔴 零 —— 本单必须补这条验收 |
| 她能不能闭麦:服务端有 pause 动作,CLI 没实现;真发生什么未验 | C §16.4;B §3.1d | ✅ 事实 / ⬜ 语义未验 |
| 语音侧启动上下文 = 5,300 token 预算摘要;逐字通道 `realtimeStartInstructions` 上限 8,192 | B §12.1;1911 坑 ⑫ | ⚠️ 产品侧读源码,未经工程复核 |
| 音频参数:v2 上行/下行都是 **24 kHz 单声道 s16le**;Discord 是 48 kHz 立体声 Opus | 1911 `bridge-hl.mjs`;HANDOFF 换算式 | ✅ 实测 |
| 上行帧率必须 ≥ 47.5 帧/秒,否则 ASR 听错(裸 setInterval 只有 ~48/秒且会漂到 80%) | 1911 达标线;坑「不漂移的节拍器」 | ✅ 实测(合成音 5/5 vs 2/2 错) |

### 2.3 她定的形态(产品层,本单要给它留位置)

| 形态 | 出处 | 成色 |
|---|---|---|
| 她进房时**房里要已经有人**(WAIT-HUMAN 让她先看到空房,「这也不是我要的效果呀」) | B §6.8 ① | ✅ 她原话 —— **改形状,不是修 bug** |
| 出去再进来**不能失忆** | B §6.8 ② | ✅ 她撞到的 |
| 状态显示在**文字频道**:`listening` / 双方转写 / 断线一行 —— 是**回归**(2026-07-17 截图) | B §6.5 三;C §30 三 | ✅ |
| 状态行**必须跟着对话流往下走**(原地改一条消息 ⇒ 她看不到,「不刷屏」被她推翻) | B §6.5 收账 ② | ✅ 她本人验的 |
| 「它在干活」的指示**必须走听觉通道**(B 的前提是不看屏幕);连续等待音成立,音色 B「更疏更慢-最安静」;状态行不带段名 | B §6.4.0b;§6.5 收账 ① | ✅ 她本人验的(46 秒等待那场) |
| 等待音语义 = **它在忙**,不是「这里有空隙」(她说完等它答时不许响) | 1911 bridge-hl 注释,她 2026-08-21 原话 | ✅ |
| 短提示音「还不如不放」;把预告念出来「we could try that in the prototype」(不是立项) | B §6.5 | ✅ 决定 / ⛔ 不当授权 |
| 沉默必须被主动打破:一小时不说话她会担心 —— 体感阈值,不是配置值;间隔**等她用起来再定** | B §5.4/§6.2 | ✅ 原话 / ⬜ 数值留空 |
| 一个阈值都不写是**故意的**(§8.2) | B §11.2 ④ | ✅ —— 本单不填验收数字 |

### 2.4 架构判据

| 判据 | 出处 |
|---|---|
| **假设使用者没有 flywheel 这个仓库** —— 「必须有 flywheel 源码才能用」就是设计错了 | A §8.5 ✅ 她原话 |
| Raya 有自己的仓、自己的 channel、常驻 | A §8.6.3 ✅ |
| 默认给全部能力,发现问题再针对性限制(⛔ 别提「先不给 X」) | A §8.4 ✅ |
| 先简单,让它在使用中长出来 —— **简单 = 部件少,不是能力少** | A §2.5 ✅ |
| 三指标之一「实际 context 用量」有人写代码记;验收 = 试用期末**有可查数据** | A §9.1b/§13.0a ✅ 她采纳 |
| 这是「接入」不是「建造」:先用原生的,不足才补 | C §5.10 ✅ |

## 3. 原型里哪些是「权宜」、哪些是「验过的形状」—— 逐条判

> Issue 写「原型代码只作参考,权宜实现不得带入」。**权宜和正确形状混在同一个文件里**,所以必须逐条判,不能整体判。

### 3.1 ⛔ 不带(权宜)

| 原型做法 | 为什么是权宜 |
|---|---|
| codex 二进制**硬编码绝对路径**(`~/.codex-mufasa/.../0.148.0/bin/codex`),且与 PATH 上的不是同一个 | 换机器必炸;违反 §8.5 |
| 直接解析 `~/.flywheel/.env` 拿 bot token | 寄生 flywheel 部署现状 |
| `import` flywheel 的 `voice-bridge/dist/TivPresenter.js` 绝对路径 | 违反 §8.5,而且那个 presenter 是「原地改一条消息」形态 —— 已被她推翻 |
| 身份载荷从 flywheel 仓 / `~/.claude/agent-memory` 的绝对路径读 | 归 2029/2030;且与 §8.5 冲突 |
| `WAIT-HUMAN`:等真人进房才建会话(而且议题只喂一次) | 她明确说不是要的效果;二次进房复发 |
| 一次性 `await new Promise` + `dc.off`:realtime/start 只走一次 | 没有任何重连语义 |
| `RUN_MIN` 到点整场收尾 + `pkill` 收桥丢计数 | 实验脚手架 |
| `manifest.outcome` 等自证字段 | 已知假绿(坑 ①) |
| `globalThis.__xxx` 跨作用域钩子 | 不可测试 |
| `~/.fly1911/bed.switch` / `bed.minms` 文件当运行期开关 | 实验旋钮 |
| `CUE=1` 短提示音、`SPEAK=1` 念预告 | 她否了前者;后者只授权原型试 |
| `gh` shim 闸(禁 merge) | 那是 HL 实验合同;生产权限归 2029/系统规则 |
| v3 WebRTC(werift)整条路 | 上游堵死;**但接口要给它留位置**(见 §5 Q3) |
| `approvalPolicy: never` + 自动 `acceptForSession` 审批 | 权限策略归 2029(§8.4 默认全给,但怎么给不是管线的事) |

### 3.2 ✅ 带(验过的形状,重写而非复制)

| 形状 | 证据 |
|---|---|
| 两个方向都是 20ms 常开流,没声音送静音 | §2.2 硬前提 |
| **不漂移的节拍器**(按绝对时刻排程、落后补发、封顶防雪崩) | 帧率 48→≥47.9 后 ASR 从 2/7 错到 5/5 对 |
| 下行按**缓冲深度**补写,不是一拍一帧(目标 5 帧 = 100ms) | player 精确 50 帧/秒拉,定时器 48/秒 ⇒ 每秒 2 次饿着 |
| 上行**抖动缓冲**:攒够 3 帧再放,放空才回静音 | 否则在她一句话中间剪进空白 |
| 只订阅**非 bot** 用户(结构性回声防护) | voice-bridge EarsReceiver 同款 |
| 等待音**在写出去那一刻叠进当前帧**,不进播放队列(队列一有话立刻让路) | 她验过的 46 秒场 |
| 等待音触发 = `item/started`(commandExecution / reasoning)与 `agentMessage.commentary`,它开口即停 | 1911 挖出的 indicator 事件流;她 2026-08-21 纠过语义 |
| 播放账目**周期性**记(每 30s:player 状态 / `missedFrames` / 已播放 ms),不只收尾记 | HANDOFF-08-24 教训 |
| `missedFrames` 才是断音的尺子,「缓冲见底」是近似 | 坑 ⑦ |
| 会话锚(`realtime started/closed`)与进程锚分开记 | 差 2.8 秒,六场一致偏 |
| 静音负对照 + 波形量首声(常开流下 speaking 事件恒为「在说话」) | C §18.2;AN1 |
| 状态行走文字频道:listening / 转写 / 断线一行 | 她定的形态 |

## 4. 真实意图 —— 她要的是什么,不是我们要做什么

从三份 PRD 与 1911 现场记录抽出来,**按她的处境写**:

1. **她不看屏幕的时候(开车/做家务)**,戴着耳机跟它说话 —— 所以链路在她**长时间安静**时不能自己断(§3.1d 就是这条承诺的技术形态)。
2. **她进房时它已经在**(不是她进去了它才刷出来)。
3. **它慢可以,但她要知道它在干活**(等待音走耳朵;状态行走眼睛,两者不互斥、都要)。
4. **出去再进来它还记得**。
5. **断了要说一句**(断线一行),而不是「突然不理我了」。
6. 她说话它**能听清**(≥47.5 帧/秒那条线是为这个);它说话她**不卡顿**(`missedFrames = 0` 是尺子)。
7. **它不能骗她「我在」**:沉默和死同形 —— 存活信号要独立于「链路看起来还在」。

⇒ 这七条就是本单验收的**方向**;数值按 §8.2 故意不填,留给她用起来之后调。

## 5. 关键问题与选项(设计要拍的板)

### Q1 「常开」到底常开到哪一层 —— Discord 腿常开 vs realtime 会话也常开

```
层 0  brain 轻量文字触发器常驻(launchd/守护)              ← founder 8-27 最终合同
层 1  voice + Discord bot                                ← 只在 voice-mode.requested 存在时运行
层 2  codex app-server 进程                              ← 每次语音模式 fresh 启动
层 3  realtime 会话(音频持续上传到 OpenAI,按分钟计费)    ← 只在本次语音模式内常开
```

| 选项 | 好处 | 代价 |
|---|---|---|
| **A. 层 3 也 24h 常开** | 她一进房零秒可说话;实现最少 | 静音也在烧平台预付余额(1911 坑 ⑮:余额烧到 $0 时 codex 把 `insufficient_quota` 吞成「Connection closed normally」);房里没人时白烧 |
| **B. 层 0–2 常开,层 3 按「房里有真人」开/关,空房 N 分钟后收会话但保留 thread**(探索期推荐;C0 P2 后已作废) | 不烧空房;她进房时 bot 已在,会话 1–3 秒建好(1911 实测:她 01:20:02 进,01:20:03 started,01:20:05 首句) | C0 P2 已证 realtime thread 无 rollout,不能靠 resume 保住记忆;最终选择见 plan D2/D3 |
| C. 层 3 只在她说话时开 | 最省 | 首句延迟不可接受;与「常开流」原则相反 |

**探索期曾推荐 B,N 默认给一个宽松值(如 15 分钟)且可配置为 0(=永不收,即退化为 A)。** C0 P2 证明跨进程 resume 不可用;founder 8-27 又明确推翻 voice 常驻。最终交付合同是:最后授权人离房过既有 grace 或文字 stop 后,先清 `voice-mode.requested`,再停 Codex、发「我下线了」、exit0;下一次 trigger fresh start。这一表只保留被取代的决策来路。

### Q2 「出去再进来不能失忆」靠什么

| 选项 | 依赖的未验事实 |
|---|---|
| **B1. 同一 thread 上再次 `thread/realtime/start`**(探索期首选) | ⛔ 没有终止旧会话的 API,最终计划已删除这条探针 |
| B2. 收会话时结束 app-server 进程,再进房时重起进程 + `thread/resume`(schema 里有)再 `realtime/start` | ⛔ C0 P2 已否:`no rollout found`;不进入最终实现 |
| B3. 新 thread + 用逐字通道(`realtimeStartInstructions` ≤ 8,192)回灌上一次的摘要 | 一定能跑,但「记得」的成色最低(摘要不是记忆) |

⇒ **这段是 C0 前的实验提案。** 最终 evidence 否掉 B1/B2,也没有采用摘要回灌 B3;当前合同是每次新语音模式与异常重拉都 fresh thread 并明确「记得:否」(见 plan D2/D3)。

### Q3 传输层要不要为 v3 留位置

v2 是她拍的,而且 alpha 通道已经弃 v2(FLY-2021:「alpha 上 v2 报 AVAS requires v1 or v3」)—— **v2 也不是永远的**。
⇒ 管线里 realtime 传输做成一个可替换的边界(`RealtimeTransport`:`start / appendAudio / onOutputAudio / onTranscript / close`),v2 实现在本单;v3 只留接口和一个 FLY-2021 指针,**不实现**。codex 二进制版本由 Raya 自己钉(`RAYA_CODEX_BIN`),升版前跑协议探针。

### Q4 三条腿的重连语义各自是什么(这是本单的核心难点)

| 腿 | 失效怎么被看见 | 恢复动作 | 恢复不了时 |
|---|---|---|---|
| Discord voice | `VoiceConnectionStatus` 离开 Ready;`player.state.missedFrames` 涨;`error` 事件 | 最终合同:持久化原因 + 状态行 + exit 1,由外层守护 fresh start;⛔ 不做进程内 `rejoin()` | 连续失败进入 crash-loop hold,等人工 |
| codex app-server 进程 | 子进程 `exit`;JSON-RPC 心跳(周期 `account/rateLimits/read`)超时 | 探索期设想:重起进程 → `thread/resume` 或新 thread → 再起 realtime;最终合同为持久化后 exit 1,由外层守护 fresh start | C0/P2 后已被 plan D3 取代 |
| realtime 会话 | `thread/realtime/closed`(reason ≠ requested)/ `thread/realtime/error`;`appendAudio` 的 RPC 回执停止 | 最终合同:持久化原因 + 状态行 + exit 1,由外层守护 fresh thread/start;⛔ 不在进程内重起 realtime | 连续失败进入 crash-loop hold,等人工 |

⚠️ 三条腿的**检测与原因独立**,但最终恢复合同统一:任一运行腿 fatal 都先落盘/发断线行,再让整个 voice 进程 exit1,由 launchd fresh 拉起;⛔ 不在进程内拆一条腿再重连。drain 期间仍有界处理另一条流,不把它伪装成继续可服务。

### Q5 静音语义的全集(把「静音」这个词拆开)

| 场景 | 语义 |
|---|---|
| 她不说话 | 上行每 20ms 送一帧 24k 静音;**永不停** |
| 它不说话 | 下行每 20ms 送一帧 48k 静音 Opus;player 永不 idle |
| 她在 Discord **自己闭麦** | Discord 不再送她的包 ⇒ 我们照送静音 ⇒ 会话活着。**闭麦在她那一侧,不送在我们这一侧 —— 两者不冲突**(这就是 B §3.1d 那个「待解冲突」的解:pause 语义我们不需要) |
| 她想让它**别听**(不闭麦但想屏蔽) | 管线提供 `micGate`(关 = 丢她的音频、仍送静音);**怎么触发归产品(2031)**,本单只留钩子 |
| 它在忙 | 等待音 B 叠进下行帧(下限 1s 才响;它开口即停) |
| 它在等她答 | **不响**(她 2026-08-21 原话) |
| 存活信号 | 不在本单定内容;管线暴露「距上次出声多久」给上层 |
| 房里没人 | presence grace 内仍按会话内静音合同运行;grace 到期后清 marker、发「我下线了」、停 Codex、exit0 |

### Q6 「打断」在 v2 上做不做

她裁「能做就做,困难就算了」。v2 回合制:它说话时不听,她的话排队。
可做的最多是**本地半打断**:检测她开口 ≥350ms(EarsReceiver 的 backchannel 门)⇒ 立刻清空**本地**下行队列、静音它正在播的话(她耳朵里停了),但 codex 侧仍会说完并把她的话排队 —— **这会造成「她没听到的那段它以为说过了」**,风险 > 收益。
⇒ **本单不做打断**;把「本地清队列」做成管线的一个能力(`flushDownlink()`)但默认不接触发器,把决定留给 2031 拿真机体感再定。⚠️ 这是我的判断,不是她的话;写进 HTML 让她能否。

### Q7 埋点交给 2029 的接口

`thread/tokenUsage/updated`(schema 有:`tokenUsage.total/last.totalTokens`、`modelContextWindow`)⇒ 每次更新追加一行 JSONL 到 `RAYA_METRICS_DIR`;⬜ **未验 realtime 会话是否触发该通知**(1911 只记过 `account/rateLimits/updated`)。兜底:周期 `account/tokenUsage/read {threadId}`。

## 6. 决策清单(本文拍的、待 plan 落实的)

| # | 决定 | 成色 |
|---|---|---|
| D1 | 实现落点 = Raya 独立仓的语音管线模块,独立进程;不依赖 flywheel 源码 | 🔶 依据 §8.5/§8.6.3;仓名/工具链已问 Tadashi(非阻塞),未回则按 TS ESM + pnpm + vitest + biome 假设 |
| D2 | 探索期候选:常开分层(Q1 选 B),空房收会话延迟可配,0 = 永不收 | ⛔ founder 8-27 后取代为 brain trigger 常驻、整个 voice 模式按需;见 plan D2/§14 |
| D3 | 探索期候选:失忆问题走 B1→B2→B3 三级 | ⛔ C0 后全部不采用;最终见 plan D3 |
| D4 | 传输边界抽象,v2 实现,v3 留接口 | 🔶 |
| D5 | 三条腿独立 supervisor,任何一条断都不停另一条的常开流 | 🔶 依据 §3.1d |
| D6 | 不做打断;留 `flushDownlink()` 能力 | 🔶 她裁「困难就算了」;我判为困难且有害 |
| D7 | 状态行 = 文字频道新消息跟着对话流走;等待音 B 叠帧混音 | ✅ 她验过的形态 |
| D8 | 不填任何验收数字;验收用「尺子」(missedFrames、上行帧率、波形、静音负对照)而不是阈值 | ✅ §8.2 |
| D9 | 三指标 ③ 埋点以 JSONL 文件接口交 2029 | 🔶 |

## 7. 会过期的结论

| 结论 | as-of | 怎么重核 |
|---|---|---|
| v3 被上游堵死 | 2026-08-24 02:39Z | 重跑 `product/doc/FLY-1911-codex-voice-prototype/evidence/tadashi-v3-probe.mjs` |
| PATH 上 codex = 0.149.1;PoC 用 0.148.0 | 2026-08-25 | `codex --version`;`grep releases/ prototype/bridge-hl.mjs` |
| `realtime_conversation` 仍 under development / false | 2026-08-25(0.149.1) | `codex features list` |
| schema 未导出 `thread/realtime/start|appendAudio|appendSpeech` 请求定义(只有通知) | 2026-08-25(0.149.1 `generate-json-schema`) | 重跑 generate-json-schema 后 grep |
| Raya 仓尚不存在(gh repo list 零命中 raya) | 2026-08-25 | `gh repo list xrliAnnie \| grep -i raya` |
| FLY-2029 worktree 与 main 同 HEAD,未开工 | 2026-08-25 | `git -C ~/Dev/flywheel-FLY-2029 log -1` |
