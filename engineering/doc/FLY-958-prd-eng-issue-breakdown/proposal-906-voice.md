# FLY-958 FLY-906 Voice/Huddle PRD → eng issue 拆解提案 — 实施计划

Issue: FLY-958 (https://linear.app/geoforge3d/issue/FLY-958/planning-三份已批-prd-eng-issue-拆解提案-906-voicehuddle-914-交互批注-915-infra)
日期: 2026-07-07
基于: exploration.md;FLY-906 prd.md(APPROVED v0.17)+ research.md;poc-converse.md(543 QA 证据);Linear 实查(542 树现状)

> Scope 按 Tadashi 2026-07-07 gate 回复收窄:**只拆 FLY-906**,markdown 直发 Lead;914/915 已拆好、总览 HTML Lead 已出。

## 总览

- v1 = **Huddle-only**(PRD §12.0);整树有一个 **go/no-go 闸 = STT spike**(bot 在强制 DAVE 下收音,PRD 头号可行性风险)。
- 提案 = **7 条:2 新建 + 5 保号更新**;FLY-542 EPIC 容器不动。
- 顺序骨架:①bugfix ∥ ②STT spike →(GO)③544 bridge → ④545 Huddle ∥ ⑤548 落地 → **Huddle v1 试跑** → ⑥547 声线 → ⑦546 耳机模式(v1.5,待 Annie 拍)。

## 提案清单

### 1.【新建】voice-core 已知 bug 修复(543 QA 遗留)— 顺序 1(与 #2 并行)
- **scope**:修 poc-converse.md 真机抓的 4 处 —— ①mic 默认设备错(MicCapture.ts 写死 avfoundation ":0",非系统默认输入;改为跟随系统默认/显式可配)②talk 命令 session ~50s 过期只打警告、从不用 resume handle 重连 ③genaiConnector.ts 的 ask_lead 工具声明缺 parameters/description schema → 真模型要么瞎编要么卡壳(对照实验已证:补标准 JSON schema 即好)④config.ts 默认模型名 gemini-live-2.5-flash-preview 已 404,换真实可用型号。
- **依赖**:无。543 已 Done 关闭 → 新建(不重开)。
- **难度**:**易**(4 个根因全部已定位、修法明确、其一已现场验证;工程量小,but 要补真机回归 —— mock 测不出这类 bug 是 543 的直接教训)。
- **为什么先做**:545/546 的任何真实对话体验都踩这 4 个坑;最便宜的一条。

### 2.【新建】STT spike:bot 在 Discord VC 收音 go/no-go — 顺序 1(与 #1 并行)⭐ 全树闸
- **scope**:时间盒验证「耳朵 bot 在强制 DAVE 端到端加密下能否可靠收音」:三条缓解路径(patch davey / py-cord 耳朵 bot / 本地采音绕开)选通一条真机打通,产出 go/no-go + 选型结论回填 544。
- **依赖**:无。
- **难度**:**难**(PRD 明示全 PRD 最大技术不确定点:bot 收音非官方支持 + @discordjs/voice 0.19.x 在 DAVE 下当前坏(#11419);难在生态雷区而非代码量,结论可能是 no-go)。
- **为什么单独新建而不塞进 544**:干净的 go/no-go 决策点(PRD 原话「验通再往下建」);spike 失败不留半拉子实现 issue。**no-go → #3-#7 全冻结,Huddle 可行性重估报 Annie。**
- 注:543 QA 已验通的是**本机 mic 采集**(--device 修正);未验的是 **Discord 频道内 bot 收音** —— 两回事,别混。

### 3.【更新 FLY-544】Discord voice bridge(#huddle VC 收/播管线)— 顺序 2
- **scope**:常驻 #huddle VC 的实时音频 runtime:bot 进/出频道、TTS 播音、收音按 #2 选型(单「耳朵」bot 收音、transcript 共享给其余 Lead)、TIV 状态行(🎙听/🧠想/💬说)+ earcon、MOVE_MEMBERS 零-tap 挪人、barge-in(<100ms 停 TTS、backchannel 不打断)。
- **依赖**:#2 GO + #1。
- **难度**:**难**(实时音频是独立 runtime(低延迟持续连接,与文字 loop 不同生命周期);多 bot 同频;§15 延迟硬指标的地基)。
- **更新动作**:方向不变,正文补 PRD §12/§12.1/§15 细节 + spike 选型结论。

### 4.【更新 FLY-545】用例① Huddle 端到端(/meet 发起 → 聊清)— 顺序 3
- **scope**:/meet slash 命令(命令名可配置)@点名 → **自动建立项 issue**(日期+参与者)→ 被点名 Lead ~1s 自动进 VC → @通知 Annie + Join 按钮(已在 VC 则零-tap)→ 会话编排:§14 动作三档确认(隐式/readback/显式+TIV 收据+现有 founder gate)、§15 延迟目标(首音≤800ms/长答≤1s 先 ack/静默≤3s/语义端点)、§16 流① 全程。
- **依赖**:#3。
- **难度**:**中**(机制 PRD 已写死到逐字(worked example 级),未知少;工作量在编排与延迟打磨)。
- **更新动作**:方向不变,正文按 §12.0/§12.1/§16① 重写细节。

### 5.【更新 FLY-548】结论落地 pipeline(recap → summary/action items → 存档)— 顺序 3(与 #4 并行)
- **scope**:聊完 → @ 的第一个 Lead(主持/记录,R9 锁死):写前**口头 recap** 等确认 → summary + action items(引用原话)写进立项 issue → 建 worktree → 存档关 issue,链接贴 TIV;普通 voice mode 不新建 issue(落对应 thread)。
- **依赖**:#4 的立项 issue + transcript 接口(接口对齐后可并行开发、后集成)。
- **难度**:**中**(积木全现成:Linear API / worktree / comm;关键在 recap 合同措辞与「引用原话」可追溯)。
- **更新动作**:正文按 R8/§12.0.4 最终模型重写(旧文只有泛泛一句)。

—— **到此 = Huddle v1 可试跑**(Annie 真用起来 = §9 北极星;试跑反馈决定 v1.5 开不开)——

### 6.【更新 FLY-547】per-agent 声线 — 顺序 4 ⚠️ phasing 要 Annie 拍
- **scope**:每 agent 独立声线(§17 硬要求:换 agent 换声线,理想不报身份也能听辨);Edge TTS voice 参数 per-Lead 配置起步。
- **依赖**:#3 播音管线。
- **难度**:**中**(接线容易;「辨识度」要真听调优)。
- **更新动作**:**priority 从 Low 提起来** —— 旧 issue 标 Phase 2/Low,但 PRD §17 把它列为耳机模式硬前提;若 #7 排进 v1.5,它必须先行/同批。

### 7.【更新 FLY-546】用例② 离屏推进(耳机模式·异步多-agent)— 顺序 5(v1.5,待拍)
- **scope**:「芝麻开门/关门」对称口令 + 确认步、全局消息转语音、§17 FIFO queue(推不拉/一来一回/换 agent 换声线+报头「身份→issue→一句进度」/mid-turn 静默入队/skip 或代发才进下一条)、§14 c 档语音批准 + TIV 文字收据。
- **依赖**:#3 + #6。
- **难度**:**难**(整份 PRD 工程量最大:多 agent 消息 queue + 回合状态机 + 全局模式开关,横跨 Bridge/Lead/voice-core)。
- **更新动作**:**整个改写**(标题+正文)—— 旧 issue 是已被 R7 砍掉的「早晚会」;按 §10 映射改成「离屏推进(耳机模式)」。

## 决策点(要 Annie 拍)

1. **耳机模式(#6+#7)进 v1 还是 v1.5?** 推荐 **v1.5**:Huddle 先试跑(她 R7「先简单」精神),真用出感觉再开 #7;#6 声线跟 #7 走。PRD §10 phasing flag 本来就把这题留给 Tadashi/Annie。
2. (仅当 #2 no-go)fallback 方向(本地采音 vs 可行性重估)—— 不预设,发生了带证据再报。

## 不建 / 保持

- FLY-542 EPIC 容器不动;§18 Deferred(早晚会/阻塞类优先级/GitHub 归档/b 档自动发/StopWord 替代)不建 issue,留 PRD 记录。

## HL 要核的三节 → 落位

- **两模式(§5)** → 结构本身:模式1(Huddle)= #4,模式2(异步)= #7。
- **action 三档(§14)** → #4/#7 的验收标准。
- **延迟目标(§15)** → #3(地基)+ #4(验收硬指标)。
