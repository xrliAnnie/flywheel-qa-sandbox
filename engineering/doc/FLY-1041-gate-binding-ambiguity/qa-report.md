# FLY-1041 Founder 批准绑定故障 — QA 报告(三段式 QA 阶段)

Issue: FLY-1041 (https://linear.app/geoforge3d/issue/FLY-1041/founder-approval-binding-glitch-thread-reply-wont-bind-to-gate-under)
日期: 2026-07-09
基于: plan.md, research.md, exploration.md

## 0. 结论

**PASS（针对 PR head 的 QA verdict = PASS）**。

- PR: #520 `feat(FLY-1041): founder-approval binding — single bindable ship gate + deterministic carrier + receipt + report denoising`
- QA 时的 PR head: `af55b745`（base=main，`MERGEABLE`）
- GitHub CI「Build & Test」: **pass**（11m52s）

本 QA 阶段**不重新实现**功能;独立核验设计契约、跑测试、审读核心逻辑、加了一条端到端 QA 测试(绑定候选集收敛不变量)。所有 FLY-1041 专项测试确定性全绿;满仓唯一的红是**宿主环境污染 / 资源竞争**导致的、与本 PR 无关的既有 flake(逐条证伪见 §3)。

## 1. 硬不变量核验(plan §0 的 4 条 + red-line 文件)

| 不变量 | 结果 | 证据 |
|---|---|---|
| ① `verify-approval.ts` / `respond.ts` / `write-gate-response.ts` / `workflow-fsm.ts` / `DirectEventSink.ts` **一字节不动** | ✅ | `git diff main...HEAD` 对这 5 个文件 = **0 行** |
| ② retire 只 expire 不删行、绝不误杀活跃 gate、绝不改写已答复 gate | ✅ | `retireShipGate` WHERE 三重闸:`checkpoint='approve_to_ship'` + `expires_at>now` + `NOT EXISTS(response)`;db.fly1041 测试「NEVER retires an answered gate」直接钉死 |
| ③ reply-to-card / ✅ / tier2 归一化不新增绕过 verify-approval 的批准路径 | ✅ | 所有新通道只改「意图认到哪个 gate」;批准写入仍走 `insertResponse{approved:true}` → verify-approval 全链;red-line 文件零改动即结构性保证 |
| ④ 全部新行为默认 ON + 独立 kill-switch,置 0 字节兼容 | ✅ | 7 个 `FLYWHEEL_*` 开关已注册进 config feature-flag registry;各 chunk 有 `=0` reverse-compat sentinel 测试(event-route retire、tier2 prefix、sweeper 均验过) |

**sweeper 判据核验**:`isSupersededShipGate` 用 **严格** `boundMs > qMs`(同秒/解析失败 → 不 retire),窄到 `approve_to_ship`,与 plan §2 的防误杀窗口一致。

## 2. 测试执行(独立复跑,QA 机器)

### 2.1 FLY-1041 专项测试 — 全绿(291 tests)

| 包 | 文件 | 结果 |
|---|---|---|
| flywheel-comm | db.fly1041 + commands | 31 pass |
| flywheel-comm | **qa-fly-1041-binding-candidate-set(本 QA 新增)** | 4 pass |
| teamlead | event-route-fly1041-retire | 6 pass |
| teamlead | gate-poller-fly1041-sweeper(真 CommDB 集成) | 12 pass |
| teamlead | gate-poller-fly1041-report-exclusion | 1 pass |
| teamlead | gate-poller-founder-fallback | 14 pass |
| teamlead | founder-reply-deliverer | 30 pass |
| teamlead | founder-ship-approval-handler / -classifier / -tier2 | 157+36+48 → 全绿 |
| teamlead | founder-reaction-approval-handler / founder-ack | 3+3 pass |
| teamlead | text-approval-source / auto-qa-held / voice-routes / founder-thread-notifier | 全绿 |
| edge-worker | Blueprint.fly208-report-back | 7 pass |

### 2.2 受影响包全量回归 — 全绿

| 包 | 结果 |
|---|---|
| flywheel-comm(full) | **758/758 pass**(52 files) |
| config(full) | **359/359 pass**(20 files,含新增 registry.ts 的 7 个开关) |
| edge-worker(Blueprint report-back) | 7/7 pass |

### 2.3 teamlead 全量回归

`5679 passed | 16 skipped`,`28 failed`(5→8 files,随负载抖动)。**全部 28 个失败逐条证伪为环境/竞争 flake,无一属于 FLY-1041**(§3)。

### 2.4 Lint

`biome check` FLY-1041 改动文件 clean(唯一 warning 在 `fleet-data.test.ts`,`in-diff=0`,与本 PR 无关)。新增 QA 测试已 `biome --write` 归一。

## 3. teamlead 全量回归的 28 个失败 — 逐条证伪(与 FLY-1041 无关)

**共性**:8 个失败文件 `git diff --name-only main...HEAD` **全部 in-diff=0**(本 PR 未触碰),且 GitHub CI(干净环境)绿。

| 失败文件 | 判定 | 证据 |
|---|---|---|
| `LeadAlertNotifier.test.ts`(1) | 宿主 token 泄露 | 断言期望 mock `Bot resolved-bot-token`,实收**真 Discord bot token**(从宿主 `~/.flywheel/.env` 解析);该文件 byte-identical to main 且 import 图无任何 FLY-1041 模块 → 在 main 上同样失败 |
| `codex-lead-runtime.test.ts`(多) | TMPDIR 重叠(记忆已记录) | 换 fresh TMPDIR 隔离跑 → **全绿** |
| `close-runner.test.ts`(1) | 并行竞争 | 单文件隔离跑 → **34/34 pass** |
| `createLeadRuntime-preflight.test.ts`(3) | 满仓资源竞争 | 隔离跑 → **pass** |
| `post-ship-finalization.test.ts`(1) | 满仓资源竞争 | 隔离跑 → **pass** |
| `runs-route-registration.test.ts`(1) | 满仓资源竞争 | 隔离跑 → **pass** |
| `fly247-bash-suites.test.ts`(1) | 负载下超时(364s) | hermetic bash 套件,与批准链无关 |
| `tmux-lookup.real-tmux.test.ts`(1) | 真 tmux 环境探针 | 依赖真 tmux 状态,环境性 |

**失败集在两次全量跑之间从 5 files 抖到 8 files** —— 这正是资源竞争 flake 的签名(本机 60+ 并发 session),而非确定性代码回归。

## 4. 代码级审读(核心逻辑对齐 plan)

- **retireShipGate**(db.ts)= `resolveGate(qid,0)` 语义 + 双保险 WHERE;答复过的 gate 永不被改写(invariant ②)。
- **event-route retire-on-rebind**:先 rebind(权威)后 retire;retire 失败仅 warn 不阻断 completion(测试「retire failure never fails the completion」验过);SAME-qid 重发 / qid-less protected binding 均不 retire。
- **sweeper**(gate-poller):兜底,严格 created_at 比较,真 CommDB 集成测试验过 retire + 不再 relay + `=0` 关闭。
- **founderApprovalHoldGuard**(auto-qa-held):单一 kill-switch 内置;plugin.ts:3868 装配的单个 `isHeld` 注入 text / ✅ reaction / voice 三源(Codex R1 #1 Critical 全覆盖),各源测试绿。
- **tier2 前缀归一化**:剥离前后双跑 deny 检查;`嗯ship`→approve、`嗯 先别ship`→downgrade、`=0`→downgrade,表驱动钉边界。
- **ask --report**:`kind` 列幂等迁移 + 只从 founder 候选集排除,relay/pending/liveness 语义不变(byte-compat NULL 验过)。

## 5. QA 新增测试(端到端绑定候选集不变量)

`packages/flywheel-comm/src/__tests__/qa-fly-1041-binding-candidate-set.test.ts`(真 better-sqlite3,零 mock),把 issue 的核心验收口径编码到 DB 边界,候选集过滤逻辑镜像生产 deliver pass(`q.kind === "report"` 排除):

1. re-fire → retire → 候选集从 2 收敛到**恰 1**(新 gate)—— 直击 FLY-910「多 gate ambiguity」根因;
2. 幸存 gate 的真批准受保护 —— 迟到 retire 拒改写答复过的 gate;
3. `--report` 降噪 —— 3 条 DONE 仍 pending-for-Lead(relay 不变)但从 founder 候选集排除;
4. byte-compat sanity anchor —— 不 retire 时 ambiguity 仍在(证明助手非空断言)。

## 6. 范围边界(诚实声明)

- 本 QA 为**三段式 QA 阶段的独立复核**(模块 + 真 CommDB 集成级),非真 Discord E2E。
- plan §4 的 **529 Room 真机 Discord E2E**(founder 真发「嗯ship」→ 绑上 → ✅ 回执 → verify-approval 对新 head approved)由**独立 QA session**执行(见 memory `feedback_qa_default_real_discord_e2e`);本报告不替代该验收。若 Tadashi/Annie 要求 ship 前必跑真机 E2E,建议在批准前排一次 529 Room 场景 A-D。
- Bridge 侧改动需**一次 Bridge 重启**方生效(teamlead 包);flywheel-comm CLI + Blueprint 文本 `git pull` 即生效(FLY-217 同型)。

## 7. Verdict

**PASS @ `af55b745`** — 设计契约全守、专项测试全绿、回归红全部证伪为环境 flake、核心逻辑审读通过、补充端到端不变量测试通过。可进 founder ship-gate(建议保留 529 Room 真机 E2E 作为 ship 前最后一道,按项目惯例)。
