# FLY-2904 Token 浪费全景 — 调研
Issue: FLY-2904 (https://linear.app/geoforge3d/issue/FLY-2904/调研token-浪费全景-claude-与-codex-两边我们现在所有的设计和跑法里有哪些机制在浪费-token逐类量化)
日期: 2026-09-25
基于: exploration.md

所有数字都来自 `evidence/scripts/census.py`（读原始 transcript / rollout，只读）和 `analyze.py` / `simulate_compaction.py`（从逐请求行重算），汇总在 `evidence/derived/summary.json`。
窗口 **2026-09-11 22:00Z – 2026-09-25 22:00Z（14 天）**，与 FLY-2893 同一个冻结窗口。单位「亿」= 1e8 token。

## 0. 量尺校验

| 校验 | 结果 |
|---|---|
| 复算 FLY-2749 冻结的 9/17 工程 Lead | 1710 请求、983,610,832 token，**逐位一致** |
| 复算 FLY-2893 的 Codex 终态后残留 | 本单 12.16 亿；FLY-2893 12.07 亿（它按执行体、本单按文件，差 0.8%） |
| 评审任务 token 分摊闭合 | 按「请求归给它之前最近创建的任务」分摊，合计 82.66 亿 = 评审会话总量，未归属 0 |
| Claude 去重 | 一次 API 响应在 transcript 里会写成多行（每个内容块一行），取最后一行的 usage，计一次；跨文件重复 561 条只计首个 |

## 1. 总账：14 天两边一共用了多少

| | 原始 token | 请求数 | 其中缓存重读 | 按 API 相对价加权* |
|---|---:|---:|---:|---:|
| Claude | **451.9 亿** | 144,965 | cache_read 442.5 亿（97.9%） | 60.2 亿 |
| Codex | **233.2 亿** | 171,153 | cached_input 228.5 亿（98.2% 的 input） | 30.8 亿 |

\* 加权只用于比较类别之间的相对大小：Claude 取 input 1、cache 写 1.25、cache 读 0.1、output 5；Codex 取未缓存 input 1、缓存 input 0.1、output 8。订阅额度怎么计 cache 读官方没有公布。
**两边 98% 的 token 都是「把已有上下文再读一遍」**。所以下面几乎每一条浪费，本质都是「多读了几遍」或「每遍读得太多」。

Codex 额度折算：沿用 FLY-2893 的账号周指纹，中位约 **10 亿 token ≈ 一个号一周的额度**（区间 3–17%/亿）。

### 谁在用（原始 token，两边合计）

| 谁 | 合计 | 占比 | Claude | Codex |
|---|---:|---:|---:|---:|
| Runner · 实现 | 255.4 亿 | 37.3% | 43.4 | 212.0 |
| Lead · 工程（Tadashi） | 149.4 亿 | 21.8% | 149.4 | — |
| 评审 · 代码评审（Bridge 派的 Claude 评审） | 70.8 亿 | 10.3% | 70.8 | — |
| Runner · QA | 76.7 亿 | 11.2% | 75.3 | 1.5 |
| Lead · infra-bot（claw） | 29.3 亿 | 4.3% | 29.3 | — |
| Lead · 产品（Honey Lemon） | 20.7 亿 | 3.0% | 20.7 | — |
| Runner · 设计 | 19.1 亿 | 2.8% | 8.7 | 10.4 |
| 评审 · 设计评审 | 11.9 亿 | 1.7% | 11.9 | — |
| QA 测试环境（test slot / 沙箱） | 7.6 亿 | 1.1% | 7.0 | 0.5 |
| Runner · general / pm / 其它 | 16.5 亿 | 2.4% | 16.5 | — |
| 其它 Lead（CoS、GeoForge、tidal-echo、Raya、Mufasa…） | 14.8 亿 | 2.2% | 12.9 | 1.9 |
| runner 自己调用的 Codex companion（设计 / 代码自查） | 6.9 亿 | 1.0% | — | 6.9 |
| founder 手动会话 / 其它 | 6.1 亿 | 0.9% | 6.1 | 0 |

Lead 合计 212.2 亿，占 Claude 的 47%。子代理（Agent 工具）合计 11.4 亿，其中 8.6 亿在代码评审里。
**语音**：Codex 语音 home 里 14 天内没有 token_count 记录；实时语音走的通道不写 rollout，本单量不到，写明为缺口。

## 2. 浪费机制（每条：量 / 证据 / 可省部分）

### W1 Lead 常驻超大上下文（1M 窗口）
- 工程 Lead 每个请求平均读 **55.5 万** token 上下文（p50 55.3 万、p90 87.5 万）；26,859 个请求里 25,393 个超过 20 万。
- 当前 `~/.flywheel/projects.json` 里 8 个 Lead 写的是 `opus[1m]`；工程 Lead 配的是 `opus`，但会话里多次手动 `/model` 切到「Opus 5 / 5.5 (1M context)」（Fable 打满时切换）。
- 现有旋钮 `autoCompactWindowTokens`（`ProjectConfig.ts`，只接受 40 万–100 万）17 个 Lead **都没配**，也都没有 `autoCompactBaseline`。
  **只填一个数值不会生效**：`lead-auto-compact.ts` 缺 baseline 时返回 `baseline_missing`。baseline 里的模型、Claude 版本、规则 / 工具指纹、bootstrap 版本必须和实际逐项相等（`lead-model-launch.ts:140-154`），还要求 `window ≥ max(2×floor, floor+20 万)`，启动时再探测 CLI 是否支持 `--autocompact`。
  所以这是一次「采集 baseline → 核验 → 试点重启」，不是改一个数。Claude 升级后 baseline 会失配，旋钮会静默失效，需要重采。
- 回放模拟（`simulate_compaction.py`，全部按原始 token 计）：保留观测到的上下文增长；超过窗口就计一次压缩（读全上下文 + 重建），并回到本会话最小上下文 + 2.5 万摘要。
  - 40 万窗口：Lead 212.2 → 120.9 亿，**少读 91.4 亿**，909 次压缩。
  - 25 万窗口（需要放开代码里的 40 万下限）：少读 113.7 亿，2,049 次压缩。
- 这是条件模拟，不是实测：假设所有 Lead 都能开；没算二阶效应（压缩后回头重读台账 / 文档会吃回一部分）。

### W2 同一条告警反复叫醒 Lead
- 14 天 Lead 被告警叫醒 3,296 次，归一化标题只有 **67 种**；其中 **2,928 次**是同一 Lead 在 6 小时内已经收过的同一标题，这些回合共 **27.1 亿**。
- 大头在 infra-bot：「跨 Lead 僵尸 session 积压」617 次、「Review passed with non-blocking advisories」（info 级）561 次、「delivery contract stalled」692 次、「land cleanup needs attention」305 次。
- 工程 Lead 另收到「Cross-family review job failed」91 次。
- 核过「Discord 派发 bot 与 Bridge 邮箱双通道重复投递」这个假设：两条通道的标题并不一一对应，**不成立**，不计入。

### W3 Codex 出事链（引用 FLY-2893，本单只复核残留）
- 引用 FLY-2893 分支 `4fc15a46e53a` 的 `classes.csv`：出事体生前共 123.6 亿，不全是浪费，部分成果留在分支上。
- **终态后残留**：本单复算 12.2 亿，FLY-2893 为 12.07 亿。这部分理论上应为 0，对应 FLY-2814 / FLY-2892 一线（终态后自续 / 复活），不归 FLY-2893 的前三类修法。
- 替身首轮 40.5 亿**不算可省**：FLY-2893 自己的 `build_report.py:150-155` 写明 goal 首回合含大量实际工作，接班重建成本无法可靠分离，只留作参考。
- FLY-2893 推荐的前三类是 K1 额度墙、K6 worktree 接管、K3 凭据。它们的收益主要在时长和号额度，本单不重复估算。

### W4 每次收信都多一轮「ack 往返」
- Lead 收到邮箱批次后要调 `flywheel_inbox_ack_batch`；ack 的返回值又触发一个新请求，这个请求要把整段上下文再读一遍。
- 只由 ack 返回触发的请求（排除中间夹着新外部输入的）6,811 个，**32.9 亿**：工程 Lead 14.8、infra-bot 12.7、产品 Lead 2.5、CoS 1.0。
  - 其中 5,457 个、**25.8 亿**的响应没再调用任何工具，直接收尾：这是最直接可合并的集合。
  - 另外 1,354 个、7.1 亿在 ack 后继续干活。合并后这类能不能省掉，要逐个看，不计入。
- 这是「收到 ack 返回后的消耗」，不是已证明可以删掉的请求。省多少取决于合并方案的遵守率。

### W5 轮询等待（check / turn / inbox / sleep 循环）
- 代理集合：命中等待模式（`sleep N`、`until/while …; do`、`flywheel-comm turn/check/inbox/status`、`gh pr checks`/`run watch`），且没命中工作黑名单（heredoc、构建 / 测试、任何 git、checks/watch 以外的 gh、脚本 / `node -e`、文件写入、会改状态的 flywheel-comm 动词），长度 ≤1,500 字符。黑名单有限，集合里仍可能含少量复合工作。
- 只由这类调用触发的请求 8,726 个，**14.6 亿**：Codex runner sleep 循环 5.7、Codex `check` 2.5、Claude `check` 1.3、Claude runner sleep 循环 1.0、Lead sleep 循环 1.0、Codex `turn` 0.8、`inbox` 0.7 + 0.4……
- 命中工作标记的等待调用（10,627 个请求、24.2 亿）**不计入**。评审的两个实测反例：同一条命令还读 CI / git 状态的，现归 mixed；测试注释里的 `while`，现归测试。
- 每轮询一次都要重读整段上下文（Codex 实现体 p50 13.6 万、Claude runner 22–32 万）。

### W6 巡检 / 定时汇总在 Lead 的大上下文里跑
- `patrol_tick` 390 回合 17.3 亿（每回合 4.4 百万），`summary_due` 253 回合 4.0 亿，合计 **21.3 亿**。

### W7 Lead 之间在 Discord 互相叫醒
- 被其它 bot / Lead 的频道消息叫醒 934 回合，**17.1 亿**（Tadashi→CoS 120、Honey Lemon→CoS 90、Tadashi→产品 78、Honey Lemon→工程 64 ……）。其中有真协作，比例未知。

### W8 纯通知 / 生命周期事件叫醒 Lead
- stage_changed / session_started / monitoring_reestablished / replacement_eligibility / info 级告警：1,371 回合，**17.5 亿**（每回合第一次请求就占 7.1 亿）。
- FLY-2749（9/21 合并）之后工程 Lead 9/22–9/25 仍有 220 回合、4.3 亿同类唤醒。
- 与 W2 有重叠（info 级告警两边都算）。

### W9 评审作废轮
- 评审结论被丢弃的任务：superseded_by_revision 77 个 6.98 亿、head_moved 49 个 4.59 亿、gate_answered_externally 21 个 3.73 亿、失败 / 其它 14 个 0.76 亿，合计 **16.1 亿**。
- 第 3 轮及以后 18.3 亿、第 1 轮代码评审每任务约 1,280 万：这是质量成本，不计入浪费。

### W10 大工具输出被反复重读
- 归因方法：取「输出后下一个请求的上下文实际增量」（减去上一轮模型输出），按字符比例分给同批工具输出，每个输出封顶为 1 token/字符。
  中间夹着其它输入（新外部消息、压缩、重启）的增量无法归因，记为未知、不计入：Claude 共 158,038 个输出（已知 156,391、未知 1,647），Codex 共 150,317 个（已知 133,039、未知 17,278）。
  后续重读次数只数窗口内的请求。评审举的反例（151 字符的返回被分到 4.8 万 token）在新规则下是未知。
- 单个输出超过 5,000 token 的部分在后续请求里被重读：**Claude 15.3 亿、Codex 15.0 亿**。
  大头：rg / sed / cat 大段读（Codex 8.7、Claude 5.3）、Read 整文件 2.9、`git diff/log`（2.3 + 2.0）、Linear `save_issue` 回显整张单 1.3、Discord `fetch_messages` 1.0、Codex 调 flywheel-comm 的回显 1.0。

### W11 Claude 会话固定前缀偏大
- 每个请求都重读的最小上下文（系统提示 + 工具 + 技能 / 代理清单 + 规则 + CLAUDE.md + 记忆）：Claude runner 中位 8.7–9.1 万、评审 6.6 万、工程 Lead 12.5 万；**Codex 只有 2.4–3.1 万**；infra-bot Lead 4.4 万。
- 高于 4.5 万（infra-bot 的水平）的部分 × 请求数：runner 23.9 亿、评审 7.1 亿、QA 环境 2.7 亿，合计 **33.7 亿**；Lead 另有 28.8 亿，但 Lead 的最小上下文含 bootstrap，不在「runner 精简配置」的范围内。这是上下文前缀代理，缓存读为主，但没有拆分缓存读 / 写构成。
- 口径限制：`最小上下文 × 请求数` 是代理量，里面还含首个任务等内容，不全是能删的系统前缀。
- 可控来源的体量：全局 rules 13 KB、两份 CLAUDE.md 15 KB、用户代理描述 22 KB、19 个插件的技能 / 代理描述，还有与 runner 无关的 MCP（小红书、chrome、playwright）。

### W12 Runner 被 Monitor / 后台任务事件反复叫醒
- runner 的 task-notification 回合按内容分两类（按回合关联 token，不按条数）：
  - **Monitor 流式事件 317 回合、5.0 亿**，例如同一个 PR 的「CI check results」推了多次；
  - 后台任务终态通知 384 回合、15.9 亿，本来就该叫醒，不算浪费。

### W13 Runner / 评审也跑到 25 万以上的上下文
- Claude runner + 评审在 25 万以上的缓存读 **40.5 亿**（实现体 p50 32.4 万、最大 96.7 万）。

## 3. 核过、但不是大问题的

- **跑整包测试（FLY-2802）**：测试输出进上下文的量很小（Claude 350 万、Codex 440 万），后续重读 2.7 亿 / 3.3 亿，合计不到 1%。整包测试的代价主要在时间和 CPU，不在 token。
- **缓存过期重建**：Claude 全部 cache 写入 8.2 亿（1.8%），其中空闲 1 小时以上后的整段重建约 1.5 亿。
- **founder 手动会话** 6.1 亿（0.9%）。
- **子代理** 11.4 亿，主要是代码评审自己派的子代理。

## 4. 口径与缺口

- 只覆盖本机。
- 各条之间**有重叠，不能相加**：W1（每次读得多）与 W2/W4–W8（读的次数多）相乘作用。先少叫醒，W1 的量就会变小；反之亦然。
- W7、W12 里有真实工作，给的是上限。
- 每条机制给的是**观测消耗**。「能省多少」是观测消耗乘上明示的假设比例得到的情景值（见 plan §3），不是保底，也不是实测。
- Codex 大输出截断核实：抽 60 个实现体会话，4 万字符以上的输出，下一请求的上下文增量中位只有 0.044 token/字符（小输出是 0.30），说明模型看到的是截断版本。所以 W10 用实测增量，不按字符估。
- 分类器词表固定。输出文件只含计数、类别、时间和哈希，**不含任何消息原文或命令原文**。
