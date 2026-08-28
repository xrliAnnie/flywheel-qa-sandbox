# FLY-2030 实施计划 v2 — Raya = Lead 形态:summary 回流(M1)+ 吸收/追问(M2)
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: scope-final.md(v2)· summary-contract.md · lead-summary-rules-draft.md · raya-identity-draft.md · founder-only-authority-exemption-proposal.md(终稿)

> **v1(rev1–rev3,自建会话回路方向)被 founder 2026-08-28 打回,全文在 git 历史;本文件 = v2,按已拍形态「Lead 运行时 + 独立仓」重写。** 已拍口径与最短清单的权威在 scope-final.md §0–§3,本文不复述,只写怎么落。
> 成色:✅ 她/Lead 定的 · 【实核】本机读源码/实测 · ⬜ 工程判断。⚠️ 标 【旋钮】 处等 founder 拍(频率/粒度),变体已在 summary-contract 写死形状,拍完删一个,⛔ 实现不自选。

## 0. 目标 · 非目标 · 授权

- 目标 = Lead 定的两里程碑验收:**M1** 六项目各真产出 ≥1 条 summary PR、总管能列未读、merge 后不再出现;**M2** 对一个真实分岔说出她当场可否掉的话(+ issue 原锚:#raya 真实对话、理由可溯、三指标在跑)。
- 非目标:scope-final §4 全部(每条已标「决定,不是遗漏」)。
- 授权:merge 仍 founder-gated(等 Tadashi 转 approve_to_ship,`verify-approval` 后才 merge;绝不自 merge);**规则例外条款随 M1 PR 落,不提前**(Tadashi 裁定);⛔ 本 plan 通过 design review 前不写码。

## 1. 架构:全是既有件,新建三小块

```mermaid
flowchart LR
  subgraph L ["11 个部门 Lead(既有)"]
    C["共享命令 flywheel-comm summary<br/>(新建①)"]
  end
  C -->|"gh 开 PR"| S[("xrliAnnie/raya<br/>summaries/ 前缀<br/>(合同已定稿)")]
  S -->|"open=未读 merge=已阅<br/>(窄口径例外,随 M1 PR 落)"| R["Raya = 生产 Codex Lead<br/>TUI 窗口形态(FLY-398 硬规)<br/>骑既有 Lead 运行时"]
  T["巡视触发:flag_values 配置 6h 默认<br/>+ scheduler 到点投 inbox(新建②)"] --> R
  R -->|"roundtable @Lead 追问(既有)"| L
  R -->|"#raya 对话(既有 gateway)"| A["Annie"]
  P["buildThreadParams + model/effort/1M<br/>(新建③,一处改两形态生效)"] -.-> R
```

【实核】TUI 生产形态与 headless 后端**共用同一个 `buildThreadParams`**(`codex-lead-tui-runtime.ts:522` → `codex-lead-runtime.ts:989`),且 TUI 侧「每次 resume 重钉 thread params」(FLY-224)——所以模型钉死改这一个函数,两形态同时生效,resume 也不会丢。

## 2. M1 · summary 回流

| # | 动作 | 落点 | 依据/验收 |
|---|---|---|---|
| M1-a | `summaries/README.md` 落合同逐字稿 | raya 仓(fly-2030 分支) | summary-contract.md §一;前缀 `summaries/` 就此定死 |
| M1-b | `lead-rules-base/summary-inflow.md` 落规则段逐字稿 | flywheel | lead-summary-rules-draft.md §一(含指回例外那段) |
| M1-c | `founder-only-authority.md` 落 Narrow exemption 终稿,条 1 前缀**逐字填 `summaries/`** | flywheel,与 M1-a **成对机械门**(§2.1) | exemption-proposal 终稿 |
| M1-c' | **规则装载接线(R1v2-4)**:`summary-inflow.md` 不会被自动发现——必须同时接 **两条显式 load path**:`scripts/claude-lead.sh` 的 dept 枚举 + `scripts/lead-rules-bundle.sh` `compute_lead_rule_bundle`,并更新 `lead-rules-base/README.md` 表与 `lead-rules-bundle.test.ts`(钉:dept 双路径含它;CoS/companion/external/无部门 infra bot 不含) | flywheel | 试点证据 = 被选 Lead 的**有效 bundle/prompt 含该文件**;只 merge 文件不算已激活 |
| M1-d | 共享命令 `flywheel-comm summary` 实现,**作者协议(R1v2-5)**:`summary --file <Lead 亲笔的.md> --project … --period …`——命令只做定名/校验/git+gh 投递,模板可打印 stdout,**Judgment 必须由真实 Lead 写进传入文件**(不再有「空骨架→立即开 PR」的不可执行流);`--dry-run` = **不写 fs/git/gh**,只校验并打印 canonical plan;幂等 key = `{project, author, period}`,同 key 更新同一 open PR,**PR 已 merge 后重跑 = fail-loud 或显式 next-seq 更正**,并发创建 fail-loud | flywheel `packages/flywheel-comm` | **TDD**:校验(前缀/frontmatter/Judgment 非空/可执行拒绝含兜底口径)、幂等三态(open 更新/merged 重跑/并发)、dry-run 零副作用、gh 失败 fail-loud;gh/fs 注入 |
| M1-d' | **merge 时只读 verifier(R1v2-5,豁免的机器可核就落在这)**:复用同一 validator + `gh`,对 PR **当前 head 的完整 diff** 核:每个路径 ∈ `summaries/`、Git mode(拒 100755 的 .md)、命名/frontmatter/Judgment、无 executable/config/build-runtime-affecting 文件(非枚举兜底)、文件列表分页;输出 verified head SHA;**Raya merge 必须 `gh pr merge --match-head-commit <verified-sha>`**(防校验后 head 被推进的 TOCTOU) | flywheel 或 raya 侧小工具(implement 定,不建服务) | **TDD**:verified 后 head 推进 → merge 拒;额外路径/越权 mode/非枚举可执行 → 不合格;分页 |
| M1-e | Raya 身份【M1】段(未读队列纪律 + **merge 前跑 verifier、只用 `--match-head-commit` merge**) | raya 仓 IDENTITY 增段 + operator 0444 副本更新(Lead 执行) | raya-identity-draft.md(已同步) |
| 验收 | 六项目各一条真 summary PR(**真 Lead 发,⛔ 不许我代笔冒充**——试点 Lead 由 Tadashi 指定)→ Raya 列未读 → verifier 过 → `--match-head-commit` merge → 列表消失 | 真实仓 | Lead 定的三条;证据 = PR 链接 + verifier 输出 + merge 记录 |

### 2.1 两仓成对落地与安全顺序(R1v2-1:人工 checklist 不是 same-batch 保证)

- **交付拆成两对 PR**(同一 FLY-2030,不拆 scope):**M1 对** = raya PR(M1-a/e)+ flywheel PR(M1-b/c/c'/d/d');**M2 对**在 M1 验收完、exact-head code review 过之后另开。⛔ 不把 M2 塞进 M1 的 PR。
- **机械门(必过,merge 前跑)**:两张 M1 PR 互链并钉 exact head SHA;门从这两个 head 读三处 canonical prefix——raya `summaries/README.md`、flywheel `founder-only-authority.md` 条 1、summary validator 常量——**机器断言三处均且只均为字节串 `summaries/`**,head 与输出留 PR 证据。
- **merge 顺序**:先 merge raya 的合同/身份(此时豁免尚未存在,机制不可被误用)→ head 未变的前提下再 merge flywheel 的 command/rules/exemption PR;**第二步失败 → 不激活/不重启生产 Lead**,豁免绝不先于它保护的机制生效。

【旋钮】频率/粒度未拍前:M1-d 的 period 语义按变体 A(定时)与 B(收工时)都能用的形状实现(`--period` 显式传入,调度器不在 M1);拍完只改文档一句话与调度配置,不改命令。

## 3. M2 · 吸收 + 追问

| # | 动作 | 落点 | 依据/验收 |
|---|---|---|---|
| M2-a | 模型参数端到端(R1v2-2/-3):**字段链复用既有 `LeadConfig.model`/`effort` + 新增 context-window 字段**(不是三个全新字段——R1v2 实核:`ProjectConfig.ts` 已有 model/effort 且**现拒绝 Codex+effort**、fleet 侧把 Codex model/effort 当只读展示,两处语义都要更新);manifest/launcher env → `parseCodexLeadRuntimeConfig` 的传入链明列;**协议映射按 0.150.1 schema:`params.model` 顶层,effort/window 走 `params.config.{model_reasoning_effort, model_context_window}`**,三者全缺省时**整个省略 `config`** | flywheel:`codex-lead-runtime.ts:989` + `ProjectConfig.ts` 校验 + fleet 展示语义 + launcher 链 | **TDD 次序(R1v2-2 纠正)**:①先加并跑 **GREEN characterization**——对 fake ChildTransport.writes 断言 `thread/start`/`thread/resume` 完整 JSONL frame 的 **exact string 含尾部换行**(覆盖:read-only 无 persona/带 persona/workspace-write cwd/full-access cwd/resume 的 threadId 展开序);②parser 断言三字段缺省时不 materialize 新 own-property、无空 `config`;③配置存在时的 **RED** tests → 实现至 GREEN;④TUI+headless 的 start/resume 四象限;⑤非法 model/effort/window fail-loud。**真机回执**:`model===gpt-5.6-sol` 且 `reasoningEffort===xhigh`;**1M 用 `thread/tokenUsage/updated.modelContextWindow` 实证**,⛔ 不许拿「③ 暂缺」把 1M 验收放空。⚠️ 不碰 config.toml |
| M2-b | 巡视触发(R1v2-6:不是加一行 DB 就可用):cadence 走 **flag registry 全套合同**——registry spec + store-managed identity + **严格正整数/上下界 codec**(invalid write fail-loud,default 6h)+ named call-time accessor + 管理写路径;**定时复用既有 `GatePoller` rider**(gate-poller.ts:675 形态,⛔ 不建新 timer),每 pass 经 accessor 读当前值;**投递复用 `lead_events` + `RuntimeRegistry.enqueueLeadEvent` 的 durable 队列**,cadence slot 生成 deterministic event id,重启重放未结算 delivery | flywheel | **TDD**:hot DB change 下一 pass 生效(无重启)、短↔长 cadence 边界、重复 pass single-flight、journal/enqueue 间崩溃、队列 retry、invalid/overflow、Raya inbox ACK/结算。验收:改一行 DB 值下一轮生效 |
| M2-c | 指标③(R1v2-7:接缝已知,不留「先探」):**在 Raya 的 TUI runtime/proc notification demux 监听 `thread/tokenUsage/updated`**(flywheel TUI demux 已路由该通知,raya `parseContextUsage` 合同已按此 shape 实现),按既有 v1 row 合同 append 到 operator 的 `context-usage.jsonl`,只记 Raya 当前 thread;parse/append 失败留显式 unavailable 证据 | flywheel 或 raya 小接线 | 真机不发该通知时才走已批的「③ 暂缺」分支,⛔ 不拿 voice 行冒充(Tadashi 盯此条) |
| M2-d | Raya 上岗:TUI 窗口形态部署(FLY-398 硬规,Mufasa `run-codex-lead-*-tui-fullaccess.sh` 同款 launcher)+ Lead 注册条目(backend codex-app-server / full-access profile / `CODEX_HOME=~/.flywheel/raya/codex-home` / chatChannel=#raya / `RAYA_BOT_TOKEN` 进 flywheel env)+ roundtable registry `raya.json`(Tadashi 已认领) | flywheel 配置 + 部署 | 挂载位置 implement 定(先例:Mufasa@growth / infra-bots@flywheel);部署重启只走班车或 founder 紧急授权 |
| M2-e | 身份【M2】段落地(快照/沉默信号/开口纪律/追问/语音短语不抢答) | raya 仓 + operator 副本 | raya-identity-draft.md;读状态 = 她自己 shell(A2),无快照代码 |
| 验收 | 她在 #raya 真实对话;一次真实分岔的可否掉追问(理由引 summary/仓证据,可溯);三指标:①② 在跑,③ 接上或如实报缺;thread 回执 model=gpt-5.6-sol 未降级 | 真实使用 | founder 2026-08-27 首要验收 + Lead 定的 M2 验收 |

## 4. 顺序与门

M1 先于 M2(没有 summary 就没有可吸收的东西);每块 RED→GREEN→REFACTOR(GREEN characterization 先于改码,见 M2-a 次序);flywheel 侧全仓门 `pnpm lint + pnpm -r build + pnpm test:packages:run`,raya 侧 `pnpm lint/typecheck/build/test`;**PR 成对(§2.1)**:M1 对(raya + flywheel,互链钉 head,机械门必过,先 raya 后 flywheel)→ M1 六项目真实验收 + exact-head code review → 才开 M2 对;merge founder-gated;里程碑账本 `engineering/doc/milestones/FLY-2030.md` 作最后一张 flywheel PR 的最后一笔。design review gate:rev4 manifest(blob 66a53dbc)起评;每次改 plan 重铸 rev 并按最新 rev 写 JSON。

## 5. 风险(短表)

| 风险 | 处置 |
|---|---|
| allowBots 并入等重启班车 ⇒ 追问/收 summary PR 通知的过渡期 | 不催重启(founder 红线);过渡期口径在 Tadashi 挂起清单里,实现不预设 |
| 旋钮未拍 | 变体已写死形状;实现只做与旋钮无关的部分(M1-d period 显式传入) |
| ③ 接不上 | 如实报缺,不冒充 |
| TUI thread 轮换(turnless self-heal 等既有语义) | 沿用运行时既有行为,不改;身份与 params 每次 resume 重钉(FLY-224 已有) |
| 例外条款前缀漂移 | review checklist 逐字对拍(两处同批次落) |

## 6. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| TUI 与 headless 共用 buildThreadParams(tui:522→runtime:989) | 2026-08-28 flywheel main | `rg -n buildThreadParams packages/teamlead/src/lead-backends/codex/` |
| 其余六条 | — | 见 scope-final.md §6(同日实核,含 flag_values / 零 tokenUsage / belle-workspace / 权限已够) |

## 7. Codex design review 处理记录(v2)

(v1 的 R1/R2 记录在 git 历史的旧 plan §16。)

**R1(v2)(2026-08-28,blob 66a53dbc,rev4 manifest b25e6c9a)= CHANGES REQUESTED,7 项,全部采纳:**

| # | 处置 |
|---|---|
| 1 两仓 same-batch 只有人工 checklist | ✅ §2.1:两对 PR、exact-head 互链、三处前缀機械断言门、先 raya 后 flywheel 的安全顺序、第二步失败不激活 |
| 2 byte-identical 断言不严且误标 RED | ✅ M2-a TDD 次序改:GREEN characterization(fake transport 的完整 JSONL frame exact string)先行→parser 不 materialize 断言→配置态才是 RED |
| 3 协议映射与既有 LeadConfig 语义 | ✅ M2-a:复用 model/effort + 新 window 字段;ProjectConfig「拒 Codex+effort」与 fleet 只读展示两处语义更新;映射 `params.model` + `params.config.{model_reasoning_effort,model_context_window}`;缺省整省 `config`;回执核 model+effort,1M 用 tokenUsage.modelContextWindow 实证 |
| 4 rules 文件不会被自动装载 | ✅ M1-c':两条显式 load path(claude-lead.sh + lead-rules-bundle.sh)+ README 表 + bundle test;试点证据 = 有效 bundle 含该文件 |
| 5 命令作者流程/dry-run/merge 门 | ✅ M1-d/d':`--file` 作者协议、dry-run 零 fs/git/gh、幂等 key 三态;merge 时只读 verifier + `gh pr merge --match-head-commit`(TOCTOU);两份草稿文档同步改 |
| 6 cadence 只证了表存在 | ✅ M2-b:flag registry 全套合同 + GatePoller rider(不建 timer)+ lead_events durable 投递 + deterministic event id + 重放;TDD 七项 |
| 7 ③ 接缝其实已知 | ✅ M2-c:直接指定 TUI demux 的 `thread/tokenUsage/updated` 监听 + 既有 parseContextUsage 合同;「暂缺」只作真机不发时的后备 |
