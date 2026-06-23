# Research: FLY-349 引擎打包成可移植 skill — 代码审计 — FLY-443

**Issue**: FLY-443
**Date**: 2026-06-22
**Source**: `doc/engineer/exploration/new/FLY-443-xiaohongshu-deep-learning-skill.md`

> 目的:把 `scripts/fly349-engine/` 抽成可跨项目 install 的 flywheel-skill 之前,先**实测审计**引擎现状——哪些已可移植、哪些硬耦合 Annie/Flywheel、有哪些可借鉴的先例(writing-engine 去味 skill + flywheel-skills 分发链)。结论喂给 plan 的 config schema + 解耦清单。

---

## 1. 引擎现状(实测,非印象)

`scripts/fly349-engine/`(6 模块 + 6 测试,927 行 run.py):

| 文件 | 行 | 职责 |
|------|----|------|
| `run.py` | 927 | live I/O wiring + 入口(MCP 拉 / yt-dlp+curl 下 / Gemini 深读 / Linear GraphQL 建单 / 自包含 HTML review 页) |
| `orchestrator.py` | 99 | 批循环(producer→consumer→aggregator),注入 IO,可 mock dry-run 测 |
| `checkpoint.py` | — | 持久 state(每 stage 落盘,崩溃可续) |
| `dedupe.py` | — | 从已有 Linear issue 抽 noteId → 不重复建单 |
| `load_gate.py` | 76 | 机器 load gate(宁慢勿崩) |
| `test_*.py` ×6 | — | 纯 stdlib 测试(`python3 test_X.py`,monkeypatch I/O,无网络/MCP) |

### 1.1 关键发现:**零 pip 依赖、纯 stdlib**

实测 import:`json os re subprocess sys time urllib html argparse shutil tempfile dataclasses typing` —— **全部 stdlib**。外部能力靠 CLI 子进程(`yt-dlp` / `curl` / `sips` / `gemini` / `uptime` / `node`)。

→ **可移植性的最大利好**:打包成 skill 不需要 `pip install` / venv / requirements。装好外部 CLI 即可跑。**这是必须守住的不变量**——config loader 也要用 stdlib(见 §3 配置格式决策)。

### 1.2 已经不依赖 Flywheel Bridge(可移植内核)

引擎核心**不调用任何 Bridge `/api/*`**:
- 拉内容:本地 MCP(`127.0.0.1:18060`,raw HTTP JSON-RPC,fresh session per call)。
- 建单:Linear GraphQL(`api.linear.app`,`LINEAR_API_KEY` env)——直连,非经 Bridge。
- review:**自包含 HTML 文件**(`build_report()` → `REPORT_DIR/batch-N.html`,Apple light 主题、per-card 建/候选/不建 toggle +「复制我的决定」按钮)——本地文件,不依赖 Bridge 的 `/xhs-review/` 路由(那是 no-code `xiaohongshu-learning` 走的路)。

→ 内核**本来就可移植**。唯一的 Flywheel 耦合是 `notify_lead()`(见 §2.6)。

## 2. 硬编码耦合清单(全部要进 config / 解耦)

逐行审计 `run.py` 顶部常量(L30-43)+ 散落点:

| # | 位置 | 现值(Annie/Flywheel 硬编码) | 性质 |
|---|------|------|------|
| 1 | L30-31 | `COLLECTION="claude"` / `COLLECTION_ID="6884765b..."` | Annie 的收藏夹 → config |
| 2 | L38-40 | `FLY_TEAM_KEY="FLY"` / `FLYWHEEL_PROJECT="Flywheel"` / `FLYWHEEL_LABEL="Flywheel"` | Annie 的 Linear → config |
| 3 | L34-36 | `STATE_DIR=~/.flywheel/state/fly349-engine` / `WORK_DIR` / `REPORT_DIR=~/fly349-batches` | Flywheel 路径 → config |
| 4 | L37 | `COOKIE_JSON=~/.config/xiaohongshu-mcp/cookies.json` | 共享但路径应 config |
| 5 | L32 | `MCP="http://127.0.0.1:18060/mcp"` | 共享默认,可 config |
| 6 | L41-43 | `COMM_CLI` / `EXEC_ID` / `LEAD="flywheel-eng-lead"` | **Flywheel-comm 专属** → 解耦(§2.6) |
| 7 | L486 | `get_collection_content` `limit=126` | Annie 的 107+ → config(MCP 不能翻页,硬上限 200) |
| 8 | L881-882 | `--batch-size` 默认 10 / `--video-concurrency` 1 | config 默认 |
| 9 | `load_gate.py` L23-33 | `absolute_pause=30.0` + per-core 比率 | **Annie 机器 WindowServer-panic 史**("load>30 收手")→ config(别的机器阈值不同) |
| 10 | L660 | `FLY349_USE_AGY=1` env 开关 | analysis 引擎选择 → config |
| 11 | L776 | provenance `fly349:{id}:issue` 前缀 | 硬编码 "fly349" → config |
| 12 | L643-648 | analysis prompt **硬编码受众**:「为做 AI 多 Agent 编排/自动化开发产品(Flywheel)的团队提炼」+ USEFUL 判据「对 Flywheel 是否有可执行价值」 | **每个项目学的目的不同** → config(§2.7,最关键的一条) |

### 2.6 `notify_lead()` —— 唯一的 Flywheel 硬耦合

`notify_lead(msg)`(L125)= `node $COMM_CLI ask --lead flywheel-eng-lead --exec-id $EXEC_ID <msg>`。两处调用:
- 批跑完通知(L923)
- `LoginLost` 升级(L915,MCP 登录失效/CAPTCHA → 要 Annie 重扫 QR)

非 Flywheel 项目没有 flywheel-comm / Lead / exec-id。→ 必须抽成**可插拔 notify**(`notify.mode = flywheel-comm | none`,非 Flywheel 默认 `none` 只打印 + 非零退出码让操作者/调度看见)。

### 2.7 analysis prompt 的受众框架 = 最被低估的 config 点

`_prompt()`(L643)把「为 Flywheel 团队提炼 / 对 Flywheel 是否有价值」写死进 prompt。**这正是"学什么"的灵魂**——tidal-echo 学内容手艺、Polaris 学别的领域,受众/判据完全不同。若只抽收藏夹 id 不抽这个,装上的 skill 会用 Flywheel 的眼睛读别人的内容 = 没用。→ `analysis.audience_brief`(项目学习目的)+ `analysis.useful_criterion`(USEFUL 判据)必须 config。

## 3. 可移植性边界(必须在文档里讲清,不是 bug)

| 假设 | 现状 | 处理 |
|------|------|------|
| macOS host | `sips`(webp→png,**macOS-only**,L591);`~/.local/bin` PATH 前置(L686) | 受众均为 Annie 同机项目 → v1 接受 macOS;文档标注「Linux 需把 sips 换 cwebp/ImageMagick」 |
| 本地 xiaohongshu-mcp 已登录 | `127.0.0.1:18060` + `cookies.json` | 前置依赖文档讲清(QR 登录) |
| Gemini 可用 | paid key(`GEMINI/GOOGLE_API_KEY`)默认 / agy opt-in | 前置文档 + config |
| `yt-dlp` 已装 | 视频原片下载 | 前置文档 |
| `node` + flywheel-comm | 仅 `notify.mode=flywheel-comm` 才需 | 默认 none 时无此依赖 |

## 4. 先例:writing-engine(去味 skill,FLY-358)+ flywheel-skills 分发链

实测 `xrliAnnie/flywheel-skills` 仓现有住户:`generic/{video-watch, founder-html-delivery, writing-engine}` + `flywheel/{flywheel-land, xiaohongshu-learning}`。

### 4.1 writing-engine = 最贴近的脚本引擎打包先例

结构:`SKILL.md`(agent 操作说明:何时 fire / agent 全自动替用户跑 / 用户不碰脚本)+ `scripts/`(`write-engine.sh` driver + `lib/`)+ `assets/`(schema/demo)。**per-project 配置靠 `--variant <yaml>` 传入**,密钥经 env(`GOOGLE_API_KEY`,curl --config stdin 不进 argv),安全门内置(baseline-lint 不可绕),默认 `--engine dry` 不外发、真跑须显式 `--engine gemini`。

→ FLY-443 照搬这个形状:SKILL.md(agent 层)+ scripts(引擎)+ assets(config 示例/schema/前置)。差别:writing-engine 用 YAML+ruby+jq 解析;**fly349 引擎纯 Python 且要守零 pip 依赖 → config 用 stdlib `json`(不能引 PyYAML;TOML 需 py3.11+ tomllib,作为可选)**。

### 4.2 分发链(FLY-216,已生产运行)

- 仓:`xrliAnnie/flywheel-skills` private;改动走 PR + CI 门(`.github/workflows/skill-guard.yml`)。
- CI 门:① frontmatter lint(`name` == 目录名、kebab、description ≤350 字符)② description 触发词 guard(禁 "always use"/"any task" 等过宽词)③ scripts shellcheck ④ blocklist 命名冲突 ⑤ contract fixture。
  - **⚠️ ③ shellcheck 对 Python 脚本不适用** → plan 要给本 skill 加一道 Python 门(`py_compile` + 跑 stdlib 测试)。
- 分发:launchd 每天 `~/.flywheel/bin/skills-sync.sh`(`npx -y skills@1.5.10 add xrliAnnie/flywheel-skills --all -g -y` + GitHub tree 期望集 + fail-closed prune)→ `~/.agents/skills/`(canonical 扁平)→ symlink 到 `~/.claude/skills/` + `~/.codex/skills/`。新增 skill **下一轮 sync 自动到达**(实测语义:`update` 不装新 skill,`add --all` 才装)。运行中 session **热加载**。
- 命名:**装后扁平化,跨 tier 不得重名**。已有 `flywheel/xiaohongshu-learning` → 新 skill 必须**另名**(见 §5)。

## 5. 与现有 `xiaohongshu-learning`(no-code)的关系 —— 是两套架构,不是重复

| | `flywheel/xiaohongshu-learning`(FLY-286/222) | `generic/xiaohongshu-deep-learning`(FLY-443,本 issue) |
|---|------|------|
| 形态 | **no-code** SKILL.md(agent 跑 bash) | **自包含 Python 引擎**(scripts/) |
| review | Bridge `/xhs-review/` 路由 + FeedbackStore | **本地 HTML 文件**(无 Bridge) |
| 状态/锁 | `flywheel-comm xhs-state`(CommDB) | 本地 JSON checkpoint |
| 建单 | Linear MCP(agent 为 host) | Linear GraphQL 直连 |
| 依赖 | **重度依赖 Flywheel Bridge + flywheel-comm** | 仅 stdlib + CLI;Bridge-free |
| 深读 | `Read`(vision)+ 视频送 Gemini | Gemini File API 多模态(视频原片+图+文) |
| 适用 | Flywheel 自己的编排跑 | **任何项目可移植** |

→ 装后扁平化 + 名字不同 → **两者可共存**,各服务不同场景。**是否长期收敛成一套** = 留给 Annie 在 plan review 拍(本 issue 不收敛,只把 FLY-349 引擎按现状打包成可移植版)。

## 6. 喂给 plan 的结论

1. 引擎纯 stdlib → config loader 也用 stdlib **JSON**(守零 pip 依赖)。
2. §2 的 12 条硬编码全进 config;密钥(GEMINI/GOOGLE/LINEAR)**只留 env**,绝不进 config 文件/argv。
3. `notify_lead` 抽成 `notify.mode`(默认 `none`)= 唯一真正的解耦动作。
4. analysis 受众/判据(§2.7)是「学什么」的灵魂,必须 config,别漏。
5. 结构仿 writing-engine;CI 给 Python 门(shellcheck 不适用);新名进 blocklist。
6. 与 no-code `xiaohongshu-learning` 共存,收敛与否 Annie 拍。
7. 可移植性边界(macOS/sips、MCP 登录、Gemini、yt-dlp)进前置文档,不当 bug。
