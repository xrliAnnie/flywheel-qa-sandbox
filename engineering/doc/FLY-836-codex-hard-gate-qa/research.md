# FLY-836 Codex 硬门真机验证 — 调研

Issue: FLY-836 (https://linear.app/geoforge3d/issue/FLY-836/qa-fly-827-codex-code-review-硬门真机验证529-room无-codex-pr-被拦-过-codex-pr)
日期: 2026-07-03
基于: exploration.md

## 1. PR #433 精确机制（读 diff + plan.md/research.md 核实，非道听途说）

- 分支 `flywheel-FLY-827`，head `4ed4762657174602258e04a4b5692dc28cf7b32b`，CI 绿，`mergeable: CONFLICTING`（落后 main，不影响本次隔离部署 —— 部署用 `--from-branch flywheel-FLY-827` 独立跑，不依赖能否直接 merge 到 main）。
- 文档在 PR 分支的 `engineering/doc/FLY-827-codex-hard-gate/`（尚未 merge 进本仓 main，用 `git show origin/flywheel-FLY-827:...` 读取）。

### 1.1 核心谓词（集中，Bridge 侧）

`packages/teamlead/src/bridge/codex-gate.ts`（新文件）：

```ts
codexHardGateEnabled(env) = env.FLYWHEEL_CODEX_HARD_GATE !== "0"   // 默认 ON
isCodexGateSatisfied(store, session, sha, env):
  !hardGateEnabled(env)           → true   // kill-switch
  session.codex_skip              → true   // codex-skip 豁免（head 无关）
  store.isCodexCodeReviewApproved(execId, sha)  // 查表
```

`isCodexCodeReviewApproved` 查 `codex_review_record WHERE execution_id=? AND lower(target_pr_head_sha)=? AND status IN ('approved','skipped')`。

### 1.2 消费点（3 类，必须都一致 —— 这正是 QA 要覆盖的面）

1. **auto-QA spawn 前置门**：`AutoQaCoordinator.onMainAwaitingReview`，在 QA policy 判断**之前**先查 codex gate。未过 → 不 claim/不 spawn QA，发 thread 消息 + 重发 `/codex-code-review` 指令（`queueCodexCodeReviewInstruction`）+ 限频告警（`alertCodexGateBlocked`，eventType `codex_gate_blocked`，eventId `codex-gate:<exec>:<sha>` 每 head 一次去重）。
2. **founder 挂起谓词 `isReviewHeld`**（`auto-qa-held.ts`）：4 处消费——`event-route.ts:1903`（always-deliver 压制）、`gate-poller.ts:394`、`HeartbeatService.ts:298`、`DirectEventSink.ts`（第 4 个 founder-surface path，emitCompleted 的 pushNotification 决策）。missing-sha + hard gate on + 非 codex_skip → 也 held（不会因为没 head 就漏放）。
3. **merge 门 `verify-approval`**（`packages/flywheel-comm/src/commands/verify-approval.ts`，runner CLI 进程）：head 匹配founder approval 之后，额外查 `codex_review_record`，未过 → `reason: "codex_review_not_approved"`。

### 1.3 上报链路

- `await-codex-gate.ts`（runner 本地阻塞门）：新增校验 `reviewedHeadSha === git rev-parse HEAD`（本地两者一致，防旧 code-review.json 误批新 head）。校验通过 → best-effort 调 `emitCodexReviewResult`（新命令 `codex-review-result.ts`，镜像 `qa-result.ts` 的 retry + fail-close marker）→ POST `codex_review_result` 事件给 Bridge → `event-route.ts` 路由到 `onCodexReviewResult` → `recordCodexReviewApproved`（insert-or-approve，不依赖先有 pending row）→ 若 parent 已 `awaiting_review` 且此刻满足 → `onMainAwaitingReview(parent, {codexReleased:true})` 重驱动首个 spawn。
- 本地文件路径：`.flywheel/runs/<execId>/codex/code-review.json`，schema 含 `reviewedHeadSha`（40-hex）。
- pr_created 时（`handleCodexAutoTrigger`）：若 session 已有 head → 登记 `pending`；`codex_skip` 且有 head → 登记 `skipped`。**这些登记只是审计用**，gate 真相永远是 `isCodexGateSatisfied` 现查（不依赖有没有 pending row —— 这正是 design review R1 HIGH-1 修的坑）。

### 1.4 kill-switch 的两套读取路径（关键，QA 必须分别验）

| 侧 | 读取方式 | 生效范围 |
|---|---|---|
| Bridge（`codex-gate.ts` / `auto-qa-held.ts`） | `env: Record<string,string\|undefined> = process.env`（该 Bridge 进程自己的内存） | 只影响这一个 Bridge 进程，随 `/api/fleet/flag/apply` 的 in-process mutate 立即生效 |
| runner CLI（`verify-approval.ts` 的 `resolveCodexHardGateOn`） | 每次 invocation **重新 readFileSync** `~/.flywheel/.env`（或 `codexDotenvPath` 覆盖），**key 缺失 = 默认 ON**（不 fallback 到 inherited env，防 re-arm 单向失效） | 每次调用都读一次文件，天然实时 |

`resolveCodexHardGateOn` 优先级：`args.env` 显式注入 > `.env` 可读(含 key 缺失=ON) > `.env` 不可读时 fallback inherited `process.env`。**`verify-approval` 暴露了 `codexDotenvPath` 参数专门给测试注入用**（源码注释明写"test injection only"）——这是本次 QA 验证纯逻辑、不碰共享文件的关键手段。

### 1.5 feature-flag registry

`packages/config/src/feature-flags/registry.ts` 新增 `codex_hard_gate_killswitch`：`category: kill_switch`、`envVar: FLYWHEEL_CODEX_HARD_GATE`、`polarity: default_on`、`toggleable: direct`。`readSites` 只列 Bridge 侧 call_time 点（codex-gate.ts / auto-qa-held.ts），CLI 侧 `.env` 读取被有意排除在 readSite 之外（否则 `isDirectToggleable` 的"每个 readSite 必须 call_time"检查会拒绝这个 flag）。

## 2. 关键风险：kill-switch 持久化路径不是 slot 隔离的（已上报 Lead，Lead 确认要写进报告）

`packages/teamlead/src/bridge/plugin.ts`：

```ts
const flagRouteDeps: FlagRouteDeps = {
  envPath: join(homedir(), ".flywheel", ".env"),   // <-- 硬编码到 os.homedir()
  ...
};
```

`test-deploy.sh` 起 slot Bridge 的 `env ... npx tsx run-bridge.ts` 调用**没有覆盖 `HOME`**（读了源码逐行确认：脚本处处用 `${HOME}/.flywheel/...` 拼路径，从未 export 一个隔离的 `HOME` 给子进程）。也就是说：不管是打向生产 Bridge（:9876）还是打向某个 slot Bridge（如 :19872），`/api/fleet/flag/apply` 落盘的目标文件都是同一个 **`/Users/xiaorongli/.flywheel/.env`**。

**当前无害的原因**：`FLYWHEEL_CODEX_HARD_GATE` 是 FLY-827 才引入的全新 key；FLY-827 未合并进 main，现网跑的 dist 完全不认识这个 key，写不写都不影响今天的生产行为。

**真正的风险**：如果测试期间在这个共享文件里留下 `FLYWHEEL_CODEX_HARD_GATE=0` 且忘记清理，等 FLY-827 未来合并、生产 Bridge 重新构建部署后，会从第一天就静默跑在"硬门被关闭"的状态——而且没有任何人会注意到，因为这本来就是"emergency 放行"的合法取值，不会报错。

**QA 应对**：
1. 优先用 `verify-approval` 的 `--codex-dotenv-path <临时文件>` 参数验证 `resolveCodexHardGateOn` 的纯逻辑（ON/OFF/re-arm/文件不存在 fallback），完全不碰共享文件。
2. 只有需要证明"Bridge 侧 `/api/fleet/flag/apply` 端到端直接生效"这一条时，才碰共享文件：动手前 `cp ~/.flywheel/.env ~/.flywheel/.env.fly836-qa-backup`，测完立刻用同一 apply 流程切回 ON（= 删除该行）并 diff 确认文件恢复原状。
3. **在最终报告里作为 finding 列出**（Lead 已要求）：建议 follow-up 让 flag 的 `envPath` 也能按 slot/项目隔离（比如尊重 `FLYWHEEL_STATE_DIR`），而不是硬编码 `homedir()`。

## 3. 529 QA Room 部署要点（读 `scripts/test-deploy.sh` 全文 + memory 坑清单确认）

- 当前占用：slot 1（roundtable 模式，PID 26090 存活）。slot 2/3/4 空闲。Lead 建议用 2 或 3。
- `--from-branch flywheel-FLY-827`：先 `git push` 该分支到 `xrliAnnie/flywheel-qa-sandbox`（sandbox 是独立仓库，不是 fork，标准 QA 流程）。
- 已确认 pre-flight 条件：`gh auth status` OK，`gh api repos/xrliAnnie/flywheel-qa-sandbox --jq .permissions.push` = `true`，`LINEAR_API_KEY` 已 export。
- `--alerts`：挂载隔离的 `#test-flywheel-alerts`（`test-slots.json` 已配好 channelId + repairBotTokenEnv），Bridge/Lead 两条写路径都隔离（`FLYWHEEL_ALERT_QUEUE_DIR` / `DEADLETTER_DIR` / `FLYWHEEL_CLAIMS_DB` env-override）——用来观察 `codex_gate_blocked` 告警。
- `TEST_REPLY_BY_ISSUE=1 TEST_API_TOKEN=<tok>`：开 chat thread（`codex-hold` 会 `postThread`），否则 `getChatThreadByIssue` 找不到线程，codex-hold 的 thread 提示看不到。同时注入需要带 `Authorization: Bearer` 自己 POST `/api/runs/start`（`inject-linear-issue.sh` 不支持 auth，见 `reference_qa_529_runner_injection_gotchas` 记忆坑 #2）。
- Dept-scope 会拒绝所有 issue（wildcard slot 配 `match.labels:["*"]`），需要 `BRIDGE_DEPT_SCOPE_REJECT=off` export 在 test-deploy.sh 之前，或选用带 `*-Test` label 的标准 sandbox inject 目标（FLY-145 Product-Test）。
- Ground truth：slot `teamlead.db`（`sessions`、`codex_review_record`、`auto_qa_record` 表）+ `bridge.log` + Discord alert 频道（Claude-in-Chrome 观察）+ 各 CLI 命令的 JSON stdout。

## 4. 4 个必证行为 + 2 个附加项，映射到具体验证手法

| # | 行为 | 验证手法 |
|---|---|---|
| a | 无 Codex 的 PR 被拦 | 真 Runner push+开 PR 拿真 head，`stage set pr_created` 触发登记；不写 `code-review.json`（不跑 `/codex-code-review`）；`complete --route needs_review --pr <N>` 让 session 进 `awaiting_review`；检查：`onMainAwaitingReview` 未 spawn QA(`auto_qa_record` 无 claim)、`bridge.log` 有 codex-hold 分支日志、alert 频道收到 `codex_gate_blocked`、CommDB 有重发的 `/codex-code-review` 指令、`flywheel-comm verify-approval` 返回 `codex_review_not_approved` |
| b | 有 Codex approved 不误拦 | 手写本地 `code-review.json`（`reviewedHeadSha` = 真实 `git rev-parse HEAD`），跑 `flywheel-comm await-codex-gate code`（验证它真的上报 `codex_review_result` 给 Bridge）；检查：`codex_review_record` 表出现 `approved` 行、`auto_qa_record` 正常 claim/spawn、`verify-approval` 通过 codex 分支 |
| c | kill-switch 放行 | 分两层：① `verify-approval --codex-dotenv-path <临时文件含 FLYWHEEL_CODEX_HARD_GATE=0>` 验证纯逻辑立即放行（不碰共享文件）；② 备份+改共享 `.env`、用 `/api/fleet/flag/apply` 打 slot Bridge 端口验证 Bridge 侧 in-process 立即生效（不重启进程），随后原样恢复共享文件 |
| d | head 变 → 旧 approved 作废 | approve head A 后，往同一 PR push 一个新 commit（新 head B），不重跑 codex；检查：`onMainAwaitingReview` / `verify-approval` 对 B 都 fail-closed（`codex_review_not_approved`），且旧 `code-review.json`（head A）配 worktree HEAD=B 跑 `await-codex-gate` 应该 fatal exit1、不误上报 |
| e（附加） | restart reconcile | 在场景 a 的挂起状态下重启 slot Bridge，确认 `reconcileCodexHolds()` 补发 thread/alert/重发指令（幂等，不重复刷屏） |

## 5. 出范围确认（同 exploration.md §3）

不测 Codex review 内容质量、不测 design-review 门（现状不变）、不碰生产 Bridge。
