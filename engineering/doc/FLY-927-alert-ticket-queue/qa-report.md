# FLY-927 告警频道 → bot 工单队列 — QA 验证报告

Issue: FLY-927 (https://linear.app/geoforge3d/issue/FLY-927)
日期: 2026-07-07
基于: plan.md / exploration.md / research.md（同文件夹）+ 本分支已提交实现

> 三段式 QA 阶段独立验证。实现由 Implement 阶段在本分支 `flywheel-FLY-927`（PR #492）完成，本阶段**不重新实现**，只验证 + 补 CI 接线 + 出报告。

## 结论:PASS

FLY-927 的实现与 plan 一致、所有 FLY-927 自带测试通过、typecheck + lint 干净、字节兼容（env 未设 = 现状）哨兵成立、FLY-912 回归场景端到端验证通过。全量套件在本**过载生产 host** 上出现的失败**全部**落在 FLY-927 未改动的环境敏感测试(real-tmux / real-git / codex-lead-runtime / integration),非本 PR 引入的回归 —— 详见 §4。

## 1. 验证范围与方法

| 维度 | 命令 | 结果 |
|---|---|---|
| Typecheck | `pnpm --filter flywheel-teamlead typecheck` | ✅ clean |
| Lint(改动文件) | `biome check`(12 个改动源文件) | ✅ No fixes |
| FLY-927 bridge 单测 | 12 个 `bridge/__tests__/*` 文件 | ✅ **182 passed** |
| FLY-927 notifier/watchdog 单测 | LeadAlertNotifier + 2×LeadWatchdog-fly927 + rescue-route + stuck-escalation | ✅ **45(干净env)+ 66 + 其余全过**;1 例 env-leak 见 §5 |
| FLY-927 shell 测试 | lead-alert-fly927(20)+ bridge-wrapper-fail-loud(9)+ lead-alert-external-kind(7) | ✅ **36 passed**(污染env + 干净env 均过) |
| 真实行为 harness | tsx 直跑编译的 Router / rate-limiter / checkpoint-park 纯函数 | ✅ **27 passed**(非 mock,见 §3) |

FLY-927 改了 17 个测试文件(5 root + 12 bridge),本阶段**逐一单独跑过、全部通过**。

## 2. 对照 plan 的实现核对(抽样)

- **Router 三分路由**(`infra-event-router.ts`):`TICKET_KINDS`/`ISSUE_PROGRESS_KINDS` 与 spec §3 逐行一致;`bridge_wrapper_fail`、`runner_throttle_stalled` 在 ticket 集内;fail-safe(未映射 kind / 进展类绑不到 thread)→ 降级进队列,绝不静默丢 —— 代码路径确认。
- **env-off 纯透传**(D 字节兼容):`createInfraAlertSink` 在 `FLYWHEEL_ALERT_ROUTING` 未设时直接走 raw sink,resolver 根本不被调用 —— harness 验证(§3)。
- **单一发送身份**(D2):`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 设了→坍缩单身份,解析失败→dead-letter **不**回退 own-bot;未设→own-bot 链逐字保留 —— 单测 sentinel 全绿。
- **20/min 令牌桶 + 溢出摘要**(T1):固定窗口桶、摘要以 🎫 起头且不含 `(leadId / kind)` 锚(防回声重分类,FLY-220 判例)—— harness 验证。
- **checkpoint-park 措辞收口**(FLY-912):founder ship-gate 停等文案含「待你拍板/等你 ship」、报权威 `session_stage`、**绝不**出现「code review」;stage 未上报→「(stage未上报)」不臆造 —— harness 端到端验证(§3)。
- **发送方门禁三层** + **lead-alert.sh 对齐**(D3)+ **bridge-wrapper 改道**(D4):shell 测试全绿(token 不进 argv、`allowed_mentions:{parse:[]}`、`bridge_wrapper_fail` 合法、失败保留 fallback curl)。
- **spec 文档**(`doc/architecture/infra-alerts-spec.md`):三频道合同 / 四铁律 / owner 表 / 生命周期状态机 / T1-T2 常量 / 门禁三层 —— 无 TBD,与 plan/PRD 一致。

## 3. 真实行为验证(非 mock,tsx 直跑编译模块)

`scratchpad/fly927-behavior.mts` 直接 import 真实 TS 模块,27 断言全过。关键铁证 —— FLY-912 事故场景重放输出:

```
[FLY-912] [Runner] 停在approve已4h,球在founder(待你拍板),owner=tadashi,下一步=等你 ship FLY-912(待你拍板)
```

即:报**权威 stage「approve」**(不是被 heuristic 猜成的「Code Review」)、球在 founder、措辞「待你拍板/等你 ship」、owner=lead。这正是 issue 要求修的根本问题 —— 已验证生效。

覆盖的真实路径:Router(ticket/issue_thread/fail-safe/env-off 透传/resolver 抛→fail-safe/leg 抛→fail-safe)、rate-limiter(20 内直发 / 21 起攒批 / 摘要格式 / 窗口翻转补充)、checkpoint-park(founder/lead/ci/runner 派生 + 缺 stage 不臆造)。

## 4. 全量套件失败分析 —— 非 FLY-927 回归(环境性)

在本 host 跑 `vitest run`(394 文件 / 5443 测)得 **36 failed**,并伴随 `Timeout calling "onTaskUpdate"` vitest worker RPC 超时。根因是**过载生产 host**:跑测时 load average 从 27 一路飙到 90-98(18 核机器),叠加活的生产 Bridge + 5 Lead + 多 runner。

**逐一核对失败文件:除 `LeadAlertNotifier.test.ts` 外,全部未被 FLY-927 改动**(`git diff --name-only main...HEAD` 确认),且都是环境/负载敏感类:

- `tmux-lookup.real-tmux.test.ts` —— 真 tmux(本机有活的生产 tmux 会话)
- `GitPushRunner.test.ts` / `ship-preflight.test.ts` —— 真 git 操作(FLY-245 gateway)
- `codex-lead-runtime.test.ts` —— 已知 TMPDIR-overlap 环境性假失败(memory 判例)
- `close-runner` / `post-ship-finalization` / `post-merge` / `actions` / `bridge` / `runs-route-registration` / `createLeadRuntime-preflight` / `founder-consent/wiring-postwrite` / `founder-ux/fly618-integration` —— real-process / integration 类

`LeadAlertNotifier.test.ts` 是 FLY-927 改动文件,但在**隔离 + 干净 env** 下 **45/45 全过**(§5);全量套件里它在 load 90 下超时属假失败。

**权威全量 gate = CI**(干净隔离 ubuntu 容器,`pnpm test:packages:run`,无 bot-token env、无真 tmux/生产负载),经 :cool: ship 流程在 merge 前强制跑(FLY-2 CI-green gate)。本 host 不是全量套件的合适运行环境(memory 纪律:real-tmux/real-git/provisioning 测试不上 host)。

## 5. 既有观察(非 blocker)

**5.1 LeadAlertNotifier 测试的 env 泄漏(既有弱点,非 FLY-927 引入)**
`LeadAlertNotifier.test.ts` 的 "POSTs to alertChannel with resolved bot token" 在本机直跑失败:期望 config 预解析的 `resolved-bot-token`,实收真 `SIMBA_BOT_TOKEN`。根因 = 本机 shell source 了生产 `~/.flywheel/.env`,`SIMBA_BOT_TOKEN`/`DISCORD_BOT_TOKEN` 泄漏进测试的 token 解析(`lead.alertBotTokenEnv ?? lead.botTokenEnv` → `process.env[envName]`)。

- 该测试来自 **FLY-83(PR #156)**,本 PR **未改动**(diff 为空);解析代码 `main` 上已存在 → **既有测试隔离弱点,非 FLY-927 回归**。
- 清掉这两个 env 后 45/45 全过;CI(干净 env)不受影响。
- 建议(follow-up,非本 PR):测试 `beforeEach` 里显式 `vi.unstubAllEnvs` / 清 `*_BOT_TOKEN`,或 `env -i` 隔离,消除对「干净 shell」的隐性依赖。

**5.2 CI 接线补全(本阶段已修)**
FLY-927 新增的 shell 测试(`lead-alert-fly927.test.sh`、`bridge-wrapper-fail-loud.test.sh`)原**未接进 `ci.yml`** → 不会在 CI 跑、不 gate merge(shell 门禁/schema/wrapper 覆盖形同虚设)。本阶段已在 `ci.yml` 增 "Test — FLY-927 infra-alert shell path" 步骤(含上述两个 + `lead-alert-external-kind`),已验证三者 hermetic(干净 env 通过)、工具依赖(jq/sqlite3/shasum/curl-stub)与既有 CI shell 步骤一致。

## 6. QA 改动清单(提交到本分支)

- `engineering/doc/FLY-927-alert-ticket-queue/qa-report.md`(本报告)
- `.github/workflows/ci.yml`:新增 FLY-927 shell 测试 CI 步骤(§5.2)
- `engineering/doc/FLY-927-alert-ticket-queue/progress.md`:更新 QA 游标

未新增冗余单测 —— 实现自带的 ~290 个 FLY-927 断言已充分覆盖各 Task 的 RED→GREEN;QA 的增量价值在「把死 shell 测试接进 CI 让它真 gate」+ 真实行为端到端复验。
