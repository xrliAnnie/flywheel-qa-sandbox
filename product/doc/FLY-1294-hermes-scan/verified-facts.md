# FLY-1294 已核实事实清单 — 交 Honey Lemon 写 founder 版用

Issue: FLY-1294
日期: 2026-07-15
基于: 8 轮 codex review 后的最终状态
用途: **Lead 亲手写 founder 版的原料。**

---

## 这份为什么长这样(读之前先看)

**8 轮 codex review,每一轮它都在我的「叙事」里抓到同一个病** —— 最后一轮判词:
> *"It isn't hiding from your method; it's living wherever your attention isn't that round."*
> (它不是在躲我的方法,**它住在我那轮注意力没到的地方**。)

所以这份**故意没有叙事**:
- **没有摘要、没有 TL;DR、没有「所以」、没有「因此」、没有结论、没有建议。**
- **只有:一条事实 + 我具体读了什么 + 它撑不起什么。**
- **叙事由你写** —— 病活在叙事层,而叙事该由能对它负责的人写。

**每条的格式**:`事实` / **我读了什么**(具体到文件或来源) / **这条撑不起什么**(明确的边界)

---

## A. 身份 / 许可 / 规模

**A1. 「爱马仕 Agent」= `github.com/NousResearch/hermes-agent`**
- 我读了什么:5 家独立中文媒体(爱范儿 ifanr.com/1662529、36氪、知乎、腾讯云、人人都是产品经理)都叫它「爱马仕 Agent」且写「取代龙虾(OpenClaw)」;功能指纹对上 XHS 清单;客户端 repo 的 README 明写「Runs on vanilla NousResearch/hermes-agent」;`gh api` 实时确认 repo 存在。
- 撑不起:无。**身份是硬的。**(Lead 独立复核过,一致。)

**A2. 许可证:我逐个 `gh api` 查的 5 个 repo 全是 MIT**
- 我读了什么:`gh api repos/<x>` 的 `license.spdx_id` 字段,5 个:core / nesquena-webui / outsourc-e-workspace / Felix-Forever-desktop / bielcarpi-live-voice。
- 撑不起:**撑不起「全生态 MIT」**(生态远不止 5 个,我只查了这 5 个)。

**A3. star:core 215,445(gh api 实时,2026-07-15)/ 7.7 万(4 月中文媒体报道)**
- 我读了什么:`gh api` 实时值 + 媒体报道。
- 撑不起:**精确值高得反常**(org 只有 7,156 followers)—— 我不为精确数字背书。**「它是个大项目」这条不打折。**
- 其余实测 star:webui 16,101 / workspace 6,085 / desktop 61 / **live-voice 11**。

**A4. Nous Research 正在洽谈 $1.5B 估值融资**
- 我读了什么:TechCrunch,2026-07-13。
- 撑不起:**「洽谈中」≠ 已完成**;这是**媒体报道,不是我核过的一手事实**。

---

## B. 能力 —— 我真读过实现的(可以说「已证」)

**B1. 它 core 能同时跑 N 条独立工作流(每个 task 一个独立 worker)**
- 我读了什么:`hermes_cli/kanban_db.py` 的派发实现 —— 从 ready 队列逐个 spawn;`SELECT assignee, COUNT(*) FROM tasks WHERE status='running' GROUP BY assignee`;全局 `max_spawn` 封顶;per-profile cap **是限流阀不是串行**(注释原文:「Prevents fan-out workloads from melting a single profile… **while leaving other profiles idle**」)。
- 撑不起:**撑不起具体能跑几个**(靠配置 + 机器资源,无硬编码上限);**我没实跑过一个十几任务的 demo**。

**B2. 它 core 的 worker 有完整生命周期管理**
- 我读了什么:`kanban_db.py` 里的 `heartbeat_claim`、worker PID 存活检测、陈旧回收、spawn-failure 断路器、`max_runtime_seconds` 超时。
- 撑不起:无(这几条我都读到了实现)。

**B3. 它 core 有父子依赖,且强制顺序**
- 我读了什么:CLI 的 `--parent`(`kanban.py:311`)+ `link` 子命令;`kanban_db.py` 的不变量原文:「**never transition ready → running while any parent is not yet 'done'**」。
- 撑不起:无。

**B4. 它的 worker 永远是它自己的程序**
- 我读了什么:`_default_spawn` 的实现,docstring 原文:「Fire-and-forget **`hermes -p <profile> chat -q ...`** subprocess」—— **硬编码 `hermes` 二进制**。
- 撑不起:无。

**B5. 它上游无法主动起「别家 CLI」当 worker**
- 我读了什么:B4 那段实现;+ issue [#64906](https://github.com/NousResearch/hermes-agent/issues/64906) 原文:外部 worker(Claude Code CLI / Codex / OpenCode)「**must hardcode launcher paths… directly in core code**」「**Anyone wanting to use external workers must fork and modify core code**」。issue 状态:**open、P3、2026-07-15 当天开的**。
- 撑不起:**撑不起「他们做不到」**(他们零件都有,缺的是配置接口);**撑不起「他们已经在往这走」**(一条 issue 被提 = **有人提了**,不等于**维护者在做**);**撑不起「没人这么干」**(issue 里描述了一个 homelab 已经 fork 着在跑)。

**B6. 外部终端可以 pull 它的看板(不是它 push)**
- 我读了什么:`claim_task(conn, task_id, *, ttl_seconds, claimer)` 的实现 —— 纯原子 DB 状态转换 ready→running + 任意 `claimer` 标签,不绑厂商;看板是 SQLite 文件。
- 撑不起:**撑不起「它能开 10 个 Claude Code」** —— 相反,`kanban_db.py:7583-7593` 明写它**拒绝** spawn 外部 CLI lane(会崩、变僵尸、CPU 烧死,注释引了事故编号 `#kanban-dispatcher-crash-loop 2026-05-05`)。**那些终端得你自己开着、自己实现协议。**

**B7. per-task 临时换模型:做不到;per-profile 换模型:可以**
- 我读了什么:`tasks` 表有 `model_override` 列(`kanban_db.py:1144`)、有迁移、spawn 时被读成 `-m`(`:8194-8195`)、CLI 会打印 —— **但全仓没有任何写入路径,`create_task()` 完整签名里没有这个参数**(= 半接线,设不了)。issue #55228 的**关闭评论原文**:「Closing on product direction. **Per-worker model choice in swarms should be represented by specialized profiles**, not an additional colon-delimited worker syntax.」= **被拒绝,不是被实现**。
- 撑不起:**撑不起「他们不能逐段换模型」** —— 走「预先建专用 profile + 父子链」可以做到。

**B8. profile 的模型是配置项**
- 我读了什么:`profiles.py` 的 **docstring**(⚠️ **是作者写的说明文字,不是我验的行为**):「Each profile is a fully independent HERMES_HOME directory with its own config.yaml, .env, memory, sessions, skills, gateway, cron, and logs」。
- 撑不起:**这条的支撑只是一段 docstring** —— 我**没读**它建目录/加载配置的实现代码。

---

## C. 能力 —— 我只看到符号 / 只看了文档(**不能说「已证」**)

**C1. worktree** —— 我只看到 `VALID_WORKSPACE_KINDS` 这个 enum 里有 `worktree` 这个名字。**没读实现,没跑过。不能说它有。**

**C2. MoA 多模型** —— 我只看到 `config.yaml` 里有 `moa:` 这个配置键 + 官方 docs 描述。**没读实现,没验过跑通。**

**C3. 双文件 markdown 记忆 / FTS5 会话搜索(~20ms)/ 8 个可插拔 memory provider** —— **只有官方 docs 这么写,我没读实现。**

**C4. 自托管(VPS/Docker/SSH/Modal/Daytona)/ skills 自动创建+自我改进 / cron 无人值守 / 一进程多平台 gateway** —— **只有官方 docs 这么写,我没读实现。**

**C5. 语音** —— core 半双工(STT: 本地 faster-whisper 免费无 key / Groq / OpenAI;TTS: Edge 免费 / ElevenLabs;CLI Ctrl+B、Telegram、Discord、**Discord 语音频道**;3.0s 静音触发 + 放 TTS 时暂停 listener)= **只读了官方 docs**。全双工 = 独立插件 `bielcarpi/hermes-live-voice`(MIT、**beta v0.5、11 star**):Gemini Live / OpenAI Realtime 双 provider、真 barge-in 且**「停嘴≠停活」解耦**、durable 后台任务(`~/.hermes/hermes-live/tasks-v1.json`,断线重连不丢)、窄 4-tool 边界、无依赖 browser SDK = **只读了 repo README/文档,没 clone、没跑过**。

**C6. 官方 Hermes Cloud(preview)** —— 「两次点击 / 60 秒 / no servers, no DevOps, no YAML」/ 闲时缩零 / 团队版细粒度权限+统一账单 / **$20–200 月** = **官网 + 官推的原文,我没注册试过**。另外我在主干 `config.py` 看到**托管相关的配置项和注释**(注释写「For hosted agents, NAS sets these at provision time」)+ chronos = 「NAS-mediated managed-cron for scale-to-zero deployments」+ 几条 hosted 登录相关 issue(#64612/#64610)。
- ⚠️ **准确说**:**我读的是配置项和注释,不是开通流程的实现** → **能说「主干里有托管这条线的痕迹」,不能说「我读了托管的实现」,更不能说「我验过它跑通」。**

**C7. 工作流重试** —— 主干 `config.py` 的 cron 配置块**只有 `provider` + `chronos`,没有任何重试键**(**这条我读了代码**);那套 retry/backoff 在**未合入的 open PR #16512**(2026-04-27 开,至今未合)。
- ⚠️ **撑不起「core 完全没有工作流重试/兜底」** —— 我只核了 **cron 那块的配置**;它的 **provider fallback / 断路器我没读实现 = 不知道**。

**C8. hermes-workspace 的 Swarm(role-based dispatch / 持久 tmux workers / byte-verified review gate / Kanban / Reports+Inbox)+ hermes-agent-desktop 的「PM 带 20 人团队」** —— **只读了那两个客户端的 README。属于那个客户端。**
- ⚠️ **撑不起「core 也有这整套」** —— core 里我只读了看板派发那几块(B1-B4);**workspace 那套完整 Swarm 在不在 core,我没读 = 不知道。别用文件名(如 `kanban_swarm.py`)推断。**

---

## D. 社区 —— 全部是二手,别当事实

**D1. 标题带 `kanban` 的 issue 有 1,933 条;带 `swarm` 的有 37 条**
- 我读了什么:GitHub 搜索的标题命中数。
- 撑不起:**这个数字只能说明「标题里出现这两个词的 issue 条数是这样」**。撑不起「看板是主流」(**数 issue 不是数用户**)· 撑不起「社区注意力在看板」(**提 issue 的人 ≠ 用的人**)· 撑不起「swarm 没人用」· **撑不起「社区同意 Annie」**。

**D2. 我找到的实测帖作者都是开发者;社区有劝退非技术的话(「如果你只是想跟 AI 聊天…对你来说也只是一个玩具」)**
- 我读了什么:中文社区十几篇实测帖(知乎/博客园/CSDN 等)。
- 撑不起:**没有分母** —— 撑不起「压倒性」「绝大多数」这种量化词。**样本 = 我搜到的那些帖,不是统计。其中两篇正文被登录墙挡住,我只有标题+摘要 = 二手的二手。**

**D3. 非技术用户:我一个都没找到**
- 撑不起:**「我没找到」≠「不存在」。**

**D4. 一篇社区文章说「Once you add a Kanban board… Hermes stops being something you message… instead of digging through chat history」「you're treating them as autonomous workers that you orchestrate and supervise」**
- 我读了什么:**一篇身份不明的社区文章**。
- 撑不起:**不是官方文档、不是他们的官方立场、不是社区共识**(我只有这一篇);**而且是条件句**(「一旦你加了看板」= 描述加看板之后,不是「Hermes 就该这么用」);**而且跟 D5 冲突**。

**D5. 实测帖里最常见的用法:每早推竞品简报 / 个人知识管理 / code review**
- 撑不起:同 D2(无分母)。
- ⚠️ **注意它跟 D4 的冲突**:这些用法**要聊天**。所以「他们把聊天当毛病」**撑不起来**。

**D6. 社区抱怨:worker 僵死 / 超时检测因缺 `updated_at` 列而失效 / PID 存活检测在容器里不可靠 / 记忆无自动过期(建议每两周手清)/ 记忆涨大后每轮等 5-10 秒 / 上手要几天 / 国产模型月均 ~200 元 / Honcho 默认关**
- 我读了什么:中文社区实测帖。
- 撑不起:**🔴 我一条都没去代码里核过。非官方。样本 = 我搜到的帖。两篇二手。**
- **→ 要拿去做内容,必须先核。否则就是拿别人没验证的抱怨当竞品事实。**

---

## E. 我们自己(同一把尺 —— 如果这是 Hermes 我不会给的勾,我们也不能拿)

**E1. 4 个 executor adapter 的代码存在**
- 我读了什么:`KimiTmuxAdapter.ts:84-85`(`type = "kimi-tmux"` / `binaryName = "kimi"`)、`CodexTmuxAdapter`(`type = "codex-tmux"`)、`AntigravityTmuxAdapter.ts`、`ClaudeCodeAdapter.ts` 文件存在。
- 撑不起:**🔴 撑不起「4 个都跑得通」** —— `claude-code`/`codex-tmux` 生产真跑过;**`kimi`/`antigravity` 的真链路我没跑过。「配置存在」≠「跑得通」。**

**E2. 我们的语音**
- 我读了什么:**只有包名和文件名**(`voice-core` / `voice-bridge` / `voice-headphone`,含 barge-in 相关 grep 命中)。
- 撑不起:**🔴 我没读实现、没跑过。按同一把尺,这条我不能给我们写「有」。现状要问 Tadashi。**

**E3. 我们其余能力(Lead 派 Runner 并行 / tmux Runner / 部门角色 / Codex review gate / Push / MEMORY.md 记忆 / per-agent model / 三段式)**
- 我读了什么:**这是我们自己的生产系统,天天在跑**。
- 撑不起:**⚠️ 这个理由本身比我要求 Hermes 的松。** 如果要跟 Hermes 逐格对比,**这些格子该用跟 B/C 一样的标准重新核**(哪些我真读过实现?哪些我只是知道它在跑?)—— **我这轮没做这件事。**

---

## F. 完全未验证(最重要的一条在这)

**F1. 🔴 「有没有人要 done-for-you」= 完全未验证**
- **这是 Annie 整个赌注的核心。我这轮没有任何证据能支持或否定它。**
- 非技术那块我一个用户都没找到(D3):**可能是真空地,也可能是没人要。**

**F2. 他们为什么自研 agent** = 不知道(**没有任何关于动机的证据**)。

**F3. 「Ekko Agent」**(Annie XHS 看到的名字)= **官方 docs / GitHub / 中文媒体全搜不到**。相近的真实功能:profile 作用域容器**已有**;project-scoped memory pool = **只是未 ship 的 feature request #16833**。

**F4. 「ArchGenAI」** = **那条 XHS 笔记的发帖账号,不是作者**。作者是 Nous Research。

**F5. XHS 提到的「全屏语音 UI / 语音队列 / workflow builder v2 / MoA 会话选择器」具体在哪个客户端** = **核不到**。

**F6. Hermes Cloud 真实体验 / 并行真实上限 / 它 provider fallback 与断路器 / core 有没有 workspace 那整套 Swarm / 我们语音现状 / 我们 kimi·antigravity 真链路** = **全部未验证**(见 C1/C6/C7/C8、E1/E2)。

---

## G. 写 founder 版时的已知雷区(8 轮 codex 逐条抓出来的,全是我踩过的)

1. **别用任何符号(✅/勾/徽章)** —— 符号是一键拍上去的,会无声冒充。**用句子写出「读了什么」;写不出来 = 它不该在。**
2. **别从「数 issue」推出任何关于用户/民意的话**(D1)。
3. **别把「一篇社区文章」说成「他们官方立场」**(D4)。
4. **别把「issue 被提」说成「维护者在做」**(B5)。
5. **别把 D6 那些抱怨当竞品事实用**(没核过)。
6. **别说「唯一」「剩下只有」「全部已坐实」这种穷尽式的话** —— 这份文件里 UNKNOWN 太多,撑不起穷尽claim。
7. **别把配置项/注释/enum 成员/文件名/docstring 说成「实现」**(C1/C6/C8/B8)。
8. **对我们自己用同一把尺**(E1/E2/E3)—— 松尺量自己是最难自查的偏见。
9. **别 over-correct 竞品能力往下压**(C7:我只核了 cron 那块,不能说「core 完全没有重试」)。
10. **摘要就是产品** —— 她只读摘要,所以最难堪的话要放在摘要,不是正文。
