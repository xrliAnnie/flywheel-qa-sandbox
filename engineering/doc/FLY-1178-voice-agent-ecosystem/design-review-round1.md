# Design Review — FLY-1178 plan.md (Round 1)
Date: 2026-07-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确，且 M0→M5 的主序列、Chrome 独占、1 主跑 + 至多 1 次定向补跑、双栏 digest、docs-only/Lead-only delivery 边界都合理。当前 checkout 也已把 Q5b 的下游更正为 **FLY-1179**（FLY-1168 只是 consumer）；这是 `exploration.md:95-98`、`research.md:125-126`、`plan.md:97-105` 的一致现状，优先于请求里粘贴的旧版 FLY-1168 文案。

但本轮不能批准，原因有两项阻塞：第一，现有 M2 不能建立“findings 中的具体论断 → 具体 URL → 内容支持”的可审计链路，因此不足以兑现“不许编造引用”的硬红线；第二，计划写出的若干 `flywheel-comm` 命令按当前 CLI 合同不可运行，且本机 `gh` 当前认证失效，M5 没有预检/恢复门。另有三项 prompt/depth 设计需要收紧，否则 Q1 容易重复 FLY-883、Q3 会混淆“持久状态”和“常驻计算”、Q5a/Q2 可在字数门下漏答。

## What's Good (Keep)

- 文件和引用链完整：`dr-prompt.md`、`research.md` §6/§7、FLY-883 的 `dr-prompt.md`/`research.md`/`dr-report.md` 都存在且非空；FLY-883 的执行记录确实是 9 分钟、25 citations、488 searches，并记录了 clipboard sentinel + Word export（`FLY-883/research.md:183-191`）。
- 对 deep-research skill 的关键约束理解基本准确：headed Chrome、交互式 pairing、恰一个 connected browser、Plus/Pro、原生 Copy contents + Word 导出、空输出 fail-loud，均与 `~/.claude/skills/deep-research/SKILL.md:74-101,113-125,173-224,231-250` 一致。
- `dr-prompt.md:40-54,168-179` 把已知地带 fence、逐 finding 双栏、四线 options 而非 verdict、未验证清单写成了显式输出合同。
- Q5b 种子转述准确：Raft 原文确实给出 Agent Inbox、Held Draft 的 freshness check 和四种后续动作，以及 perception empathy / action explicitness；作者、职位与 2026-05-21 日期也匹配。种子链接：<https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/>。
- `plan.md:63-89` 把 URL 健康检查、内容抽查、薄弱项补跑和“仍薄则承认”放在写 digest 之前，顺序正确；`plan.md:91-105` 的双栏与四线映射验收也清楚。
- 当前工作区未发现生产代码改动：`git status --porcelain` 只有 FLY-1178 文件夹内四个新增设计文档，`progress.md` 已跟踪且无 diff；`git diff --check` 通过。保持这一 scope。

## Issues & Recommendations

### 1. [HIGH] M2 没有 claim-to-source 映射，且只抽查每问一条，无法证明 findings 的引用红线

`plan.md:65-78` 对全部 URL 只验证“能不能打开”，内容支持性则只要求每问 ≥1 条。一个真实但无关的 URL 会通过可点性检查；同一问题里其余进入正文的 findings 仍可带未经内容核验的引用，但 M4 又声称“无未标注的编造/死链引用”（`plan.md:104-105`），该验收目前不可证明。

更关键的是，skill 输出本身只把 `.docx` relationships 中的 URL 去重后追加为平面 Sources 列表（`assemble_report.py:33-43,61-85`; `dr_lib.py:96-109`）。skill 明说 inline `citeturn` 到精确 URL 的 mapping 尚未实现（`SKILL.md:259-262`）。因此 `plan.md:68-70` 所说“打开其引用源”按当前 `dr-report.md` 产物并不总能确定是哪一个源；FLY-883 的报告也展示了相同形态。

建议把 M2/M4 合同改为：

1. 对 **每一条准备进入 findings.md 的事实性/承重 finding** 建立 `finding ID → exact direct URL(s) → source section/title → VERIFIED/UNVERIFIED → 备注`；Appendix A 以 finding 为主键，而不是只以 URL 为主键。
2. 只有内容核验为 `VERIFIED` 的论断才能无标注进入正文；无法定位精确来源、打不开或内容不支持的一律降级/移入 §7。无需逐句核验整个 DR 原文，但所有被提升到决策 digest 的证据都必须核验。
3. 保留全量 URL 健康表作为独立附表，并保存本轮 `.docx`（或在验证时从 `.docx` 手工恢复 hyperlink 关系），不要把“平面 URL 列表”误当成 citeturn mapping。
4. M1 验收从“≥1 resolved URL”收紧为：报告非空、skill fail-closed 检查通过、来源列表非空、运行记录完整；M4 验收明确检查所有正文 finding 都能在 Appendix A 找到 exact verified source。

### 2. [HIGH] 计划中的通信/进度命令按当前 CLI 合同不可执行；GitHub 也未处于可用状态

- `plan.md:33-38` 的 `flywheel-comm ask Tadashi ...` 和 `plan.md:115-117` 的 `flywheel-comm ask --report ...` 都缺少必填 `--lead`；源码会直接报 `--lead is required`（`packages/flywheel-comm/src/index.ts:318-350`）。
- `plan.md:138-139` 的 `flywheel-comm progress --phase implement --cursor <M>/6` 缺少必填 `--exec-id` 与 `--file`，CLI 会以 code 2 退出（`packages/flywheel-comm/src/commands/progress.ts:301-308`）。
- 当前 review shell 中 `command -v flywheel-comm` 无结果，checkout 也没有 `packages/flywheel-comm/dist/index.js`；实际 Runner prompt 使用的是注入后的 `node <commCliPath> ...`。计划不应假设 bare binary 在 PATH。
- `gh` 已安装，但 fresh `gh auth status` 显示默认账号 token invalid；当前 M5 无法 push/open PR，且没有任何 auth preflight 或 fail-closed 路由。

建议在 M0 增加一次全链路工具预检，并把计划里的命令改成 Runner 提示词提供的可执行形态：`node <commCliPath> ask --lead <leadId> --exec-id <execId> ...`、`check <qid>`、`progress --exec-id <execId> --file engineering/doc/FLY-1178-voice-agent-ecosystem/progress.md ...`。同时跑 `gh auth status` 和 repo/remote 检查；失败则先协调恢复，无法恢复时走 blocked，不要等完成昂贵 DR 后才发现 M5 不可执行。M5 仍应遵循 Runner 注入的完整 gate 命令（含 `--lead`、`--exec-id`、PR number、questionId），不要只写“照合同执行”。

### 3. [MEDIUM] Q1 与“不重复 FLY-883”的 fence 自相拉扯

`dr-prompt.md:40-46` 明确禁止重做 generic speech-to-speech vs STT→LLM→TTS vs hybrid tradeoff，但 `dr-prompt.md:60-65` 又要求 “Cover ... the speech-to-speech vs chained architecture split and the stated criteria for choosing each”。这会直接诱导 DR 重写 FLY-883 §6，消耗本轮最稀缺的搜索预算。

保留 OpenAI 官方分类作为术语背景，但把 Q1 改成严格的 delta：最多用一个短段落引用该分类，不重新比较通用延迟/成本/音质；只研究该选择如何改变 realtime handoff、外部深脑 delegation、长工具任务期间的语音体验和上下文流。类似地，Q4 的 latency 只限 voice-agent framework/platform 自己公开的体验预算，不回到三家 backend 横评。

### 4. [MEDIUM] Q3 把“持久 agent 状态”与“常驻进程/在线 session”混为一谈，会得出错误行业结论

`research.md:49-51` 和 `dr-prompt.md:98-107` 把 Letta/MemGPT、companion persona、ambient agent、per-meeting resident 放进同一“resident session-agent”桶，但这些至少包含两个不同轴：

- logical residency：agent identity/history/memory 持久化，可由数据库恢复；
- compute/session residency：进程、模型连接或 live context 在空闲期仍持续在线。

Letta 官方文档把 agent 定义为“stateful services”，状态与 history 落数据库、调用方只发送新消息；这能证明 logical persistence，却不能自动证明模型会话/计算持续常驻：<https://docs.letta.com/guides/get-started/for-agents>。若不拆轴，DR 很可能把“可恢复的持久状态”错误计为“常驻进程”，从而无法回答 FLY-1160 的真实取舍。

建议 Q3 先定义两轴并要求每个案例分别标记：durable identity/state、warm process/model connection、idle compute/cost、crash/restart recovery、lifetime boundary（per task / per conversation / per meeting / indefinite）。最终比较至少分成 ephemeral compute + persistent state、per-meeting resident、indefinite resident 三类。

### 5. [MEDIUM] M3 的字数/引用阈值无法保证 prompt 的关键子问题被回答

`research.md:133-141` / `plan.md:82-86` 只按“某问 ~150 词或 ≥2 引用”判定。Q5 整体够长时，5a 可以完全缺失；Q2 可以只讲 external vector DB 而漏掉 handoff injection 与 platform sessions；Q1 可以只有 OpenAI 没有 Google，仍然通过。

在不增加 DR 轮数的前提下，把 M3 改为 coverage matrix：Q1 至少 OpenAI + Google + live-session delegation/async UX；Q2 三类机制 + 2-3 dominant combinations；Q3 上述 residency 两轴；Q4 3-5 个邻近案例及 gap；Q5a 与 Q5b **分别**判定，Q5b 仍保留 seed + ≥2 mechanism 的现有门。字数/引用数保留为辅助信号。若多个格子同时缺失，只把最大证据缺口组合进唯一一次 targeted rerun，并把其余缺口列入未验证清单。

### 6. [LOW] 导出失败不应默认重跑整轮研究；日期要求也需避免逼模型编日期

`plan.md:58-59` 对 iframe/clipboard/export 任一失败都“重试整流程 1 次”。对已经完成的 DR，优先在同一 conversation 按 skill 的 menu re-open、坐标重读、clipboard sentinel、Export to Markdown fallback、新 `.docx` 绑定流程重试；只有研究会话本身未完成/丢失时才重新跑研究。并明确“技术性恢复重试”不占那 1 次内容补跑预算。

另外，`dr-prompt.md:158-163` 要求每个承重论断都带日期；很多官方 reference page 没有发布/更新时间，这会刺激模型猜日期。改为“published/last-updated date where the source provides one; otherwise mark undated and record access date”，同时要求 vendor-claimed production users/latency 明确标注为 vendor claim。

## Verdict

**CHANGES REQUESTED**

批准前至少完成：① 所有进入 findings 的论断都有 exact URL + 内容核验的 claim-level evidence ledger；② 修正 `flywheel-comm`/progress/gh 的可执行预检与命令；③ 消除 Q1 fence 冲突并拆清 Q3 residency 两轴；④ 用 coverage matrix 补强 M3。其余流程与 scope 可保持不变。
