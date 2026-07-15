# Exploration: 把 FLY-349 引擎打包成可安装 skill — FLY-443

**Issue**: FLY-443 (把 FLY-349 小红书学习引擎打包成可安装的 flywheel-skill — 跨项目复用)
**Date**: 2026-06-22
**Status**: Complete

> 来源:Annie 2026-06-22 roundtable —「FLY-349 这套小红书拉内容 + 多模态深读学习,应该写成可安装 skill;其它项目 install 就能用、不用每次口头教(如 Ariel/tidal-echo 问怎么下视频原片)。以后很多项目都要定期从小红书拉内容总结学习。」brainstorm gate(Tadashi 确认):**本轮只交 plan**(仿 FLY-358 #295 plan-first doc PR),Codex design review → Tadashi 过 → Annie 过目 plan → 才实现。

## 1. 问题定义

FLY-349 引擎已生产可用(正跑 Annie 107 收藏夹),但它是 **Annie 专属硬编码** + 散落在 `scripts/fly349-engine/`,别的项目要用只能口头教。要把它变成**装一次、配一次、跑很多次**的可复用能力——受众:tidal-echo(Ariel)、Polaris、SAP、T.Echo、Echo 等都要定期从小红书学。

非目标(本轮明确不做):① 实际把 skill 推进 flywheel-skills 仓(那是 plan 批准后的 follow-up);② 改 FLY-349 当前 107 跑(worktree 隔离、零影响);③ 跟 no-code `xiaohongshu-learning` 收敛(Annie 拍);④ 跨 OS 移植(v1 接受 macOS 同机)。

## 2. 已审计的事实(详见 research doc)

- 引擎**纯 stdlib、零 pip 依赖**;内核**已不依赖 Flywheel Bridge**(MCP 直连 + Linear GraphQL 直连 + 自包含 HTML review 页)。
- 唯一真 Flywheel 耦合 = `notify_lead()`(flywheel-comm)。
- 12 条 Annie/Flywheel 硬编码常量(收藏夹、Linear team/project/label、路径、load 阈值、provenance 前缀、**analysis 受众框架**)要进 config。
- 已有 `flywheel/xiaohongshu-learning`(no-code、Bridge 耦合)→ 新 skill 须另名,两者共存。

## 3. 关键设计决策(选项 + 取舍 + 推荐)

### D1 — 配置格式:JSON / TOML / YAML?

| 选项 | 取舍 |
|------|------|
| **JSON(stdlib `json`)** ✅ 推荐 | 守住零 pip 依赖;任何 py3 可读;缺点=无注释(用 `config.example.json` + schema 文档补) |
| TOML(`tomllib`) | 人类友好有注释,但 **py3.11+ 才有 stdlib tomllib**;低版本要 pip 引 → 破坏零依赖 |
| YAML(PyYAML) | 最友好但**必须 pip install** → 破坏可移植性核心卖点 |

**推荐 JSON**。可移植性是这个 issue 的全部意义,不能为了配置好看就引依赖。

### D2 — 配置发现顺序

`--config <path>` 显式优先 → `$XHS_LEARN_CONFIG` env → `./xiaohongshu-learn.config.json`(项目根)→ `~/.config/xiaohongshu-deep-learning/config.json`。找不到 → fail-fast 报清楚(别用 Annie 默认裸跑)。

### D3 — 密钥位置:env-only(不进 config 文件)

`GEMINI_API_KEY`/`GOOGLE_API_KEY`(深读)、`LINEAR_API_KEY`(建单)**只读 env**,绝不进 config 文件或 argv(沿用引擎现状 + writing-engine 先例:curl --config stdin 不进 argv)。config 文件可进版本库/被读,密钥不行。

### D4 — Flywheel 解耦:notify 可插拔

`notify.mode`:`none`(默认,非 Flywheel 项目——只打印 + LoginLost 时非零退出码)/ `flywheel-comm`(Flywheel 自用,从 env 取 `FLYWHEEL_COMM_CLI`/`FLYWHEEL_EXEC_ID` + config 取 lead)。SKILL.md(agent 层)负责把 `none` 模式的升级信息转给人。

### D5 — 引擎代码改动幅度:就地参数化,不重写

引擎已生产验证(F0 零造假、凭据卫生、注入防御都过了 QA)。**只把 12 条硬编码替换成 config 读取 + 加一个 config loader**,**逻辑零改**。保住所有安全不变量。新增 `config.py`(stdlib JSON loader + 校验 + typed)。现有 6 个测试继续过 + 加 `test_config.py`。

### D6 — 命名:`xiaohongshu-deep-learning`(generic tier)

跟 `flywheel/xiaohongshu-learning`(那是 Bridge 耦合 no-code)区分,放 `generic/`(任何项目有意义)。最终名 Annie 过 plan 时定。需加进 blocklist 盘点。

## 4. Annie brainstorm 答复(2026-06-22,已拍 — 形态由她定)

Annie 看完对比 HTML + brainstorm 5 问后拍定:

| # | 问 | Annie 答 |
|---|----|----------|
| 名字 | 最终 skill 名 | **`xiaohongshu-deep-learning` OK** ✅ |
| Q1 | 运行模式 | **两种都要**:A 手动(跑一批→本地 HTML→review);B **定时增量**(checkpoint 记看到哪、下次只处理新 note,复用引擎已有 checkpoint+dedupe)→ **需补可移植调度/cadence 层**。主用法 = 读小红书 → 识别可做的 → **建 follow-up issue track** |
| Q2 | 跟 no-code 关系 | **Annie 授权我定 → 收敛**:deep-learning = **跨项目唯一的 xiaohongshu-learning 核**(补 scheduled + memory + Lead-config);no-code **近期共存**(Flywheel 当前定期跑还用),等 deep 到 parity + Flywheel 切过去 → no-code 退休 |
| Q3 | 各项目形态 | 读小红书 → 识别可做 → 建 follow-up issue(落各项目自己 Linear);cadence 定时 + 手动;Lead/agent 配 |
| Q4 | 记忆回写 | Annie **想要**,不确定难度 → 让我**评估可行性**:合理进 v1(学 founder 口味回写),难则 defer 但**结构留好** |
| Q5 | install/配置 | **Lead/agent 驱动自动配好**,用户基本不碰(像去味 skill) |
| 首受众 | 先给谁接 | **tidal-echo**(Ariel) |

→ 据此 plan 从 v0.1.0(纯打包)扩到 **v0.2.0**(收敛核 + 两模式 + 调度层 + 自动配 + memory)。

## 5. 流程

brainstorm(2 轮:打包理解 gate + 形态 gate,均已过)→ research(已审计)→ **plan v0.2.0**(本文档的 sibling)→ Codex design review → Tadashi 过 → Annie 过目 → (follow-up)实现到 flywheel-skills 仓。
