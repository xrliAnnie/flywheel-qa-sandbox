# FLY-958 三份已批 PRD → eng issue 拆解提案 — 探索

Issue: FLY-958 (https://linear.app/geoforge3d/issue/FLY-958/planning-三份已批-prd-eng-issue-拆解提案-906-voicehuddle-914-交互批注-915-infra)
日期: 2026-07-07
基于: 无

> **⚠️ Scope 已改(Tadashi 2026-07-07 brainstorm gate 回复,压过原 issue 描述)**:914/915 已拆好不用管、总览 HTML Lead 已出;本 issue 只做 **FLY-906 Voice PRD 深读 → 拆解提案清单**(markdown 经 ask 直发 Lead;不做 HTML、不做三件套全流程、不做 codex review;每 issue 带难度档而非模型档)。本文档 §2.1/§2.2(915/914 审计)保留作记录;最终交付 = 同文件夹 proposal-906-voice.md。

## 1. 任务本质

Annie 直接指示:读三份已 merge 进 main 的 APPROVED PRD(FLY-906 Voice/Huddle、FLY-914 交互批注、FLY-915 infra 告警),拆出**可执行的 eng issue 提案清单**,做成 founder-facing HTML 发到本 issue thread 给 Annie + Honey Lemon 审。**先提案、批了再由 Lead 建 issue** —— 本 issue 纯规划、零 production code、不直接建/改任何 Linear issue。

## 2. 代码库 + Linear 审计发现(拆解前先摸真相)

三份 PRD 的「拆解现状」完全不同,提案的性质因此不同:

### 2.1 FLY-915(infra 告警)— 拆解已完成、issue 已建

- **FLY-925**(quick-fix:FLYWHEEL_BRIDGE_URL + STANDUP_PROJECT_NAME,High,Backlog)已单独先行。
- **FLY-927 / 928 / 929**(= PRD §10 的 ①频道架构 ②两 infra bot ③profile 切换+通知迁移)已建、Annie lgtm、描述与 PRD 一致。
- 注意:FLY-927 在建完后**又长了**——FLY-912 事故把「Watchdog v2 stuck-detection 通用规格」(按真实 stage 报/park 元组/1h 时效/owner 首响应)并入其中(FLY-936 标 Duplicate 收编)。
- → 915 的提案 = **确认现状 + 排序/模型建议**,不需要新建或改写。唯一可提的问题:927 体量已经偏大(W1+W2+W-B+Watchdog v2),要不要拆出 Watchdog v2?

### 2.2 FLY-914(交互批注)— issue 已建但措辞已过时

- **FLY-930 / 931 / 932 / 933** 已建(parent = FLY-914,全 Backlog),但建完后 **Annie 又简化了回流方案**(不做 serverless relay,改『复制全部批注』剪贴板方案)。
- PRD §2 + build-issues-draft.md banner 已更新;**已 file 的 4 个 issue 文字还是 relay 版**。Honey 指示:等 Annie 试顺 demo 再动 filed issue,避免反复。
- → 914 的提案 = **调整清单**:FLY-931 降级 backlog(v1 不做)、FLY-932 回流改『复制全部批注(段落原文+评论 配对)』、FLY-930 去掉 v1 的 connect-src、FLY-933 验收里的『全部发送』字样同步改。本次提案 HTML 恰好就是给 Annie+HL 的 review 面 —— 批了提案即等于给了「动 filed issue」的绿灯,一箭双雕。

### 2.3 FLY-906(Voice/Huddle)— eng issue 还没建,是本次拆解的主体

- PRD §10 明确:eng issue 由 Tadashi create,PRD 只给「PRD 各节 → 已有 Voice 树」参考映射。
- 已有 Voice 树现状(Linear 实查):
  - FLY-542 EPIC;FLY-543 voice-core **Done**(PR #480 merged);FLY-544/545/546/547/548 全 Backlog,**描述全是 PRD 之前的旧文字**(546 还写着已被砍的早晚会;547 还是 Low/Phase-2,而 PRD §17 把 per-agent 声线列为耳机模式的硬要求)。
- FLY-543 QA 真机抓的已知 bug(证据 = packages/voice-core/evidence/poc-converse.md),需落进合适 issue:
  1. **bug A** mic 默认设备错(MicCapture.ts avfoundation 写死 ":0",不是系统默认输入;现场用 --device ":2" 修正验证过);
  2. **bug B** talk 命令 session 过期(~50s 警告)不重连(resume handle 从未被调用);
  3. **bug C** genaiConnector.ts 的 ask_lead 工具声明缺 parameters/description schema → 真模型要么瞎编要么卡壳,从不真调工具(对照实验已证补 schema 即好);
  4. **附带** config.ts 默认模型名 gemini-live-2.5-flash-preview 已 404(Google 下线/改名)。
- **STT 收音 = 先验证的前提**(Annie R8 要求这样标):本机 mic 采集已真机验通(--device 修正后);**未验证的是 bot 在 Discord 语音频道里收音** —— @discordjs/voice 0.19.x 在 2026-03 起强制 DAVE 端到端加密下当前是坏的(缓解:patch davey / py-cord 耳朵 bot / 本地采音)。验证不通,整个 Huddle 可行性要重估 → **必须做成一个先行的 go/no-go spike**。

## 3. 拆解要做的关键决定(带进 plan / 提案 HTML)

1. **906:更新旧 issue vs 新建?** 倾向:**能更新就更新**(544/545/546/547/548 保号更新,树形和 Annie 的心智不变);只对「543 bug 修复」和「STT spike」考虑是否单独新建。
2. **906:STT spike 放哪?** 选项 A = 544 内部做 Phase 0 gate;选项 B = 单独新建 spike issue(干净 go/no-go 决策点,PRD 原话「验通再往下建」)。倾向 B(单独 spike + 543-bugfix 先行,其余 issue 等 spike GO 再激活)。
3. **906:耳机模式(§13入口②/§17)进不进 v1?** PRD 遗留的显式 open question(§10 phasing flag):离屏模式依赖 FLY-547 声线(现 Phase 2/Low)。这是真 product/phasing 决定 → **提案里给选项 + 推荐,让 Annie 拍**(推荐:v1 = Huddle 先试跑,耳机模式+声线 = v1.5 紧随,不并行铺开)。
4. **914:动 filed issue 的绿灯** — 把 4 条调整写进提案,Annie/HL 批提案 = 绿灯(替代「等 demo 试顺」的悬置状态,或按 HL 意见保持等待)。
5. **915:927 要不要拆出 Watchdog v2?** 927 现在 = 频道架构 + 路由 + 门禁 + 治误报 + Watchdog v2 通用规格,体量明显最大。提案里给「拆 vs 不拆」选项(倾向:提案标注风险、由 Tadashi 实施时定,不替他拆)。
6. **每个 issue 的建议模型**:按不确定度分 —— 架构/协议/高不确定(STT spike、927)建议 Fable;机制清晰的实现(bug 修复、932/933、928/929)建议 Opus;纯配置(925 已建)不用提。

## 4. 交付物形态(本 issue 的)

- **plan.md = 完整提案内容本体**(每份 PRD 一节、每个提案 issue 一张「卡」:标题/一句话 scope/依赖/顺序/模型/映射到已有 issue 的动作 = 更新|新建|保持|调整)。
- **founder-facing HTML**(Apple 浅色风、按 PRD 分节、每 issue 一卡、标注决策点)→ 发布 + 发到 FLY-958 issue thread。实施阶段产出(本 design 阶段先把内容和结构定死)。
- 不建/不改任何 Linear issue。

## 5. 假设(显式列出)

- A1: 「提案 issue 列表」以 plan.md 为权威内容源,HTML 是它的 founder-facing 渲染 —— 两者内容一致。
- A2: 提案 HTML 用现有 publish-report 管线(静态、无 JS 交互)即可 —— 914 的交互批注管线(930/932)还没建,不能依赖它;分节 + 卡片静态呈现足够 Annie+HL 审。
- A3: 「建议模型」指 Runner 执行该 issue 时的模型档(Fable/Opus),沿用 FLY-241 per-issue model 机制的语义。
- A4: 914 的 mockups / demo URL 状态以 PRD 文字为准,不重新真机验证(纯规划 issue)。
