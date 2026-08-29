# FLY-960 STT spike:bot 在强制 DAVE 下收音 go/no-go — 探索

Issue: FLY-960 (https://linear.app/geoforge3d/issue/FLY-960/voice闸-stt-spike-bot-在-discord-vc强制-dave-加密收音-gono-go-真机验证-全树闸)
日期: 2026-07-07
基于: 无(跨文件夹上游输入:`product/doc/FLY-906-voice-product-experience/prd.md` §12.1、`engineering/doc/FLY-958-prd-eng-issue-breakdown/proposal-906-voice.md` #2、`engineering/doc/FLY-883-realtime-voice-research/research.md` §7)

> **状态:brainstorm gate 已过(Tadashi 2026-07-07 批准,含 1 处补充硬约束,见 §5)。**
> 本 issue 是三段式 pipeline 的 DESIGN 阶段产物之一;spike 执行归 implement 阶段(同分支)。

## 1. 问题是什么(不是什么)

**验证一个前提假设,不是建功能。** FLY-906 Voice PRD(APPROVED v0.17)§12.1 把「bot 能在
Discord 语音频道里可靠收音(STT 的输入侧)」标为**全 PRD 最大技术不确定点、待验证的前提
假设**:整个 Huddle / 离屏语音愿景都压在它上面。

两个已知事实构成风险:

1. **bot 收音本来就非官方支持**:`@discordjs/voice` 明文警告 audio receive 不被 Discord
   官方文档化(能用、有多年生产实践,但无稳定性承诺)——FLY-883 DR 已证。
2. **DAVE 端到端加密 2026-03 起强制**:Discord 的 DAVE 协议(E2EE for voice)过渡期结束后,
   不支持 DAVE 的客户端/应用无法参与通话;而 `@discordjs/voice` 0.19.x 的**收音链路在 DAVE
   下当前是坏的**(upstream issue discord.js#11419,PRD 写作时点 2026-07-06 仍开)。
   发送侧(TTS 播音)安全。

**本 spike 回答一个二值问题**:三条缓解路径里,是否至少一条能在**真机、真·强制 DAVE 的
Discord VC** 里可靠收到人说话的音频并转成文字?

- **GO** → 选型结论回填 FLY-545(Huddle 完整 deliverable,收音子范围按选型建),③ 开工。
- **NO-GO** → ③ FLY-545 / ④ FLY-546 全冻结,Huddle 可行性重估带证据报 Annie。

**要防混淆的边界**(issue 原文明确):FLY-543 QA 验通的是**本机 mic 采集**(ffmpeg
avfoundation 抓本地麦克风);本 spike 验的是 **Discord 频道内 bot 收音**(网络对端、经
Discord 语音基础设施、DAVE 加密后的音频)——两回事。

## 2. 三条候选路径(issue 钦定,选通一条)

| 路径 | 做法 | 一句话风险画像 |
|------|------|---------------|
| **A. patch davey / discord.js 收音链路** | 留在 Node/TS 生态:用 `@discordjs/voice`(DAVE 库 `@snazzah/davey` 已预装),收音坏在 #11419 → 找 upstream 修复 / 社区 patch / 自己补收侧解密接线 | 生态雷区最深:依赖 upstream bug 的真实状态;若 davey 本身不支持收侧解密则要动原生库,时间盒易爆 |
| **B. py-cord 耳朵 bot** | 用 Python 生态 py-cord(有 sinks 收音 API)做单独的「耳朵」bot 进程,PCM/transcript 经进程间接口交回 Node 侧 | 「据报可用」待证实;引入 Python sidecar(架构上可接受——PRD §12.1 本来就设计单独一个耳朵 bot 吃这条脆弱腿) |
| **C. 本地采音绕开** | 完全绕开 bot 收音:Annie 桌面 Discord 客户端(天然支持 DAVE)解密播放,本机虚拟音频设备(BlackHole 等)把 Discord 输出环回采集 → STT。543 的 MicCapture(ffmpeg avfoundation)机制直接复用,只换设备 | 技术上几乎必通,但**产品降级最大**:绑 Annie 桌面客户端在场、收到的是混音(无 per-speaker 分离)、她用手机进 VC 时整条失效 |

**路径间关系**:A/B 是「真 bot 收音」,产品形态完整;C 是「假 bot 收音」——对系统而言音频
来自 Annie 的机器,不来自频道,属于**降级续命方案**而非等价替代。

## 3. Brainstorm 定下的设计决策(gate 已批)

### 3.1 GO/NO-GO 判据

**GO** = 选通路径在真·强制 DAVE 的 Discord VC 里同时满足:

1. **收到可懂音频**:真机拿到解密后 PCM,人耳可懂(核心判据——风险全在这一步);
2. **STT 出可辨认文字**:中英混说样句转写可辨认(STT 引擎本身不是被验对象,用现成的即可);
3. **稳定性**:含至少一次断线重连/rejoin,持续 ≥10 分钟不崩;
4. **per-speaker 分离**:SSRC→user 映射可用(**A/B 必须;C 豁免但必须标注为降级**);
5. **DAVE 真在场证据**:davey/E2EE 握手日志 + 客户端侧 E2EE 标识截图。
   **防假通过**:若会话实际降级到非 E2EE(transport-only),收到音≠验证过 DAVE——证据链必须
   证明音频是从 DAVE 加密会话里解出来的。

**NO-GO** = 三条路径在各自时间盒内均未同时达成 1+2。

### 3.2 真机验证顺序:B → A → C(research 刷新现状后 A/B 可调)

- **B 先**:PRD 写「据报可用」、验证成本最低——先验最可能 GO 的,省时间盒;
- **A 次**:价值高(留在 Node 生态、与未来 FLY-545 bridge 同栈)但依赖 upstream #11419
  的真实修复状态,research 阶段先 desk-check 再定投入深度;
- **C 最后**:保底、几乎必通(543 已验采集机制),只有 A/B 都死才选,且选 C 有专门约束(§3.4)。

### 3.3 测试 rig(两层音源)

- **场地**:测试用 Discord VC(不污染生产频道)+ bot 池(FLY-882)claim 的 bot 当耳朵。
- **音源层 1(自动化、可重复)**:第二个 bot 用已验证的发送侧(`@discordjs/voice` 播音,
  参考音频可用 543 的 Edge TTS 生成固定中英混说样句)向 VC 播参考音频 → 耳朵 bot 收 →
  STT → 与参考文本比对。
- **音源层 2(产品现实形态)**:至少一轮**真人类 Discord 客户端在场**的验证轮——DAVE 的
  MLS 群组构成随参与者变化,bot↔bot 会话不能代表「真客户端在场」的会话形态,产品场景
  就是 Annie 的真客户端说话。
- **Annie 确认场**:她真说 2 分钟做最终确认,**不阻塞 GO 判定**(gate 已拍:bot 侧证据 +
  客户端在场轮即构成判定依据;她醒来后补确认场)。不冒用她的 Discord 会话做自动化。

### 3.4 路径 C 的特别约束(Tadashi gate 补充,硬)

**C 被选定 = 必须 Annie 知情拍板才算选定**(不是知会,是拍板)。报告必须写清降级面:
绑桌面客户端在场 / 无说话人分离 / 她用手机进 VC 时失效。

### 3.5 工程边界

- spike 代码落 `engineering/spike/FLY-960-dave-stt/`,**不进 pnpm workspace、零生产代码
  改动**(不碰 `packages/voice-core`;FLY-959 在并行修它,别踩)。
- 实施时间盒总 ~3-4 个工作日,每路径硬盒,盒到即停、留证据、换下一条(细分在 plan.md)。
- 三段式下的交付:implement 阶段跑 spike → PR 含 spike 代码 + verdict 报告 + 文档;
  QA 阶段独立复核证据链(能复跑选通路径的收音)。

## 4. 为什么不是其他做法(已否决的方向)

- **直接在 FLY-545 里边建边验**:被 FLY-958 提案明确否决——干净的 go/no-go 决策点,
  spike 失败不留半拉子实现(PRD 原话「验通再往下建」)。
- **只 desk-check 不真机**:本 issue 的存在理由就是 543 的教训——mock/文档推断测不出
  这类生态雷区,必须真机(issue 标题自带「真机验证」)。
- **扩大候选面(songbird/Rust、discord.py fork 等)**:issue 钦定三条;research 阶段
  允许把其他生态的 DAVE 收音现状作为**情报**记录(万一三条全死,NO-GO 报告里给 Annie 的
  重估材料更完整),但 spike 不为它们扩时间盒。

## 5. Gate 记录

- **2026-07-07 brainstorm gate(Tadashi)**:设计整体批准。逐条:① GO 判据(含 DAVE 真在场
  证据防假通过)确认;② 顺序 B→A→C、research 后 A/B 可调,确认;③ **C = GO-with-降级-flag,
  必须 Annie 知情拍板才算选定**(补充硬约束);④ spike 代码进 engineering/spike/、零生产
  改动、硬时间盒,确认。要拍的点(Annie 场是否阻塞 GO 判定)按我的倾向拍:**bot 侧证据 +
  客户端在场轮为准,Annie 真说话 = 最终确认场、不阻塞判定**(她在睡;技术风险是 bot 收音,
  真人客户端在场即构成真实会话形态;她的 2 分钟醒来后补)。

## 6. 下一步

→ `research.md`:三条路径 2026-07 实时现状核查(#11419 修复状态 / davey 收侧解密能力 /
py-cord DAVE 支持真伪 / DAVE 强制对 bot 的确切语义),定 A/B 先后与每路径的进入/放弃条件。
