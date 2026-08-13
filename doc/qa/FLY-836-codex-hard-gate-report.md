# FLY-836 QA 报告 — FLY-827 Codex code review 硬门真机验证

Issue: FLY-836 (https://linear.app/geoforge3d/issue/FLY-836/qa-fly-827-codex-code-review-硬门真机验证529-room无-codex-pr-被拦-过-codex-pr)
日期: 2026-07-03
被测: PR #433 (`xrliAnnie/flywheel`, 分支 `flywheel-FLY-827`, head `4ed4762657174602258e04a4b5692dc28cf7b32b`)
QA 执行人: runner-635eafda（**非** FLY-827 实现者 be7627b3，独立验证）
场所: 529 QA Room slot 2 隔离测试 Bridge，真机(F0)

## 结论: **PASS**（1 项子检查在本场所结构性无法验证，见下）

FLY-827 的 4 个 Lead 硬要求 + 附加的 restart reconcile，用 PR #433 的**真实编译产物**（非读实现者的单测）在真机上逐条证实，见 §2。其中 (c) kill-switch 的 **CLI merge-gate 路径**（真正卡 merge 的权威机制）PASS；**Bridge HTTP 路由的免重启实时切换**这一子检查因 529 Room 自身的 env-pinned 设计而结构性无法验证（非 FLY-827 缺陷，见 Finding 1）。(a) 的证据链里有一处审计表状态的订正（不影响结论，见 (a) 小节）。经 Codex code review 一轮 CHANGES REQUESTED 后已采纳修正（见 PR #437 讨论）。

## 1. 部署与关键坑（供以后 529 Room QA 参考）

- **Bridge dist 来源坑（本次 QA 抓到的新坑，非 FLY-827 本身）**：`scripts/test-deploy.sh --from-branch <br>` 的 `--from-branch` 只决定**沙箱克隆**（Runner 自己的 worktree）内容，**不决定 Bridge 本身跑哪份 dist** —— Bridge 用的是**调用 test-deploy.sh 时所在的那个 flywheel checkout** 的 `packages/*/dist`（"hybrid swap" 机制，`doc/qa/framework/dependency-build-policy.md` 已有提示，但这次具体撞在"从错误 checkout 调用导致 Bridge 缺 `codex_review_record` 表"上）。第一次部署我在自己的 `flywheel-FLY-836`(基于 main)跑 test-deploy.sh，Bridge 完全没有 FLY-827 的代码(`codex_review_record` 表都不存在)。**修复**：改为从已存在的 `~/Dev/flywheel-FLY-827` worktree(PR #433 实现者 be7627b3 的、head 恰好=`4ed47626`、已 build 好)内调用 `scripts/test-deploy.sh`，之后 Bridge 才真正跑 PR #433 的代码。
- **GitHub push protection 挡沙箱同步**：`flywheel` main 历史里 FLY-519 fleet 工具的测试 fixture 含"像真的"Discord/OpenAI/Slack token 字符串(命中 GH013 push protection)，首次把 `flywheel-FLY-827` 分支同步到 `flywheel-qa-sandbox` 时被挡。核实是**假 fixture**(`scripts/__tests__/fleet-capture.test.sh` 等,注释明写"real-looking secret values"用于测 sanitize 逻辑)。修复:用 orphan commit 把这 3 个 fixture 文件里的假 token 值替换成明显安全的占位符(不影响 FLY-827 本身任何代码),squash 成一个新提交推到沙箱。**不是 FLY-827 的问题**，是 flywheel 主仓 + 沙箱同步机制的已知摩擦，已有 `doc/qa/framework/sandbox-sync-guide.md` 但没覆盖这个具体场景，值得补充。
- **TMPDIR 坑**：本 QA runner 自己的沙箱环境把 `TMPDIR` 设成 `~/.flywheel/runner-state/<execId>/browser-tmp/...`(路径过长),导致 tsx 的 IPC socket `listen EINVAL`。需要 `export TMPDIR=/tmp/` 再部署。与 FLY-827 无关，是本机 runner 沙箱环境的已知模式(类似 `reference_qa_codex_lead_runtime_tmpdir_overlap` 记忆里的 TMPDIR-under-~/.flywheel 问题，但这次是完全不同的报错形式)。
- **`--alerts` 需要 flywheel-test-2 bot 加入 `#test-flywheel-alerts` 频道**：这个 bot 目前不在该频道 → `--alerts` 部署直接 403 退出。这是人工一次性 Discord 邀请动作(`scripts/setup-alert-channel.sh` 只探测 repair bot，不探测每个 slot 自己的 bot)，本次 QA 跳过 `--alerts`，改用 `bridge.log` + `codex_review_record`/`auto_qa_record` 表的真实内容作为告警证据(见 §2 场景 a)。

## 2. 四个硬要求 + 附加项 —— 逐条真机证据

### (a) 无 Codex 的 PR 被拦 — **PASS**

真实 Linear issue FLY-226 → 真 `/api/runs/start` 注入 → 真 session(execId `b3355026-c59e-4132-87d0-5b57c0a05248`)→ `stage set pr_created` → `complete --route needs_review --pr 42`(真实 sandbox PR #42 的真 head `81cd974b...`，未跑任何 Codex review)。

真机证据：

```
sessions:        status=awaiting_review, pr_head_sha=81cd974b...
auto_qa_record:  空（QA 完全没 spawn）
bridge.log:      "[auto-qa] codex-hold b3355026...(FLY-226) @ 81cd974b — code review not APPROVED; QA not spawned, founder held"
                 "[codex-gate] re-queued code review instruction for b3355026..."
flywheel-comm verify-approval --exec-id b3355026... --pr-head 81cd974b...
  → {"approved":false,"reason":"codex_review_not_approved", ...}
```

四个子断言全中：QA 不 spawn、founder 挂起（未 surface）、重发 `/codex-code-review` 指令（CommDB 里真实可见）、`verify-approval` 返回 `codex_review_not_approved`。

**订正（Codex code review 第 1 轮抓到）**：草稿曾写"`codex_review_record` 无任何行"，但我实际只在 `stage set pr_created` 触发的那一刻（此时 session 还没有 `pr_head_sha`）确认过一次表为空——这是在**另一个**会话（`334a6d38`，场景 b 证据 1）上验证的，不是 `b3355026` 本身；`complete --route needs_review` 之后 `b3355026` 的 `codex_review_record` 有没有变成 `pending` 行，我在 slot 拆除前没有重新查证（`teamlead.db` 已随 `test-teardown.sh` 一并删除，无法事后补查）。这不影响 (a) 的结论——不管该审计表是空还是 `pending`，含义都是"未 approved/skipped"，`auto_qa_record` 为空 + `bridge.log` 的 codex-hold 日志 + `verify-approval` 返回 `codex_review_not_approved` 这三条独立证据已经完整证明 QA 被真实拦截；只是不应该把未验证过的表状态写成确定结论。以后 529 Room QA 应在拆 slot **前**把关键表状态另存一份，避免结论依赖事后无法复核的瞬时状态。

### (b) 有 Codex approved 不误拦 — **PASS**（两条独立证据）

**证据 1（真实完整 E2E）**：真实 Linear issue FLY-136（execId `334a6d38...`）走完整 onboard→brainstorm→implement→push→PR #42→`stage set pr_created`→**真的跑了 Codex code review**(通过 `codex-companion.mjs`，非模拟)→Codex 真的判 APPROVED：

```
codex_review_record: status=approved, verdict_event_id=真实event uuid, approved_at=2026-07-04 05:31:52
auto_qa_record:      新增一行 status=running, qa_issue_id=FLY-843（真实创建的 QA Linear issue，真实 QA Runner 在跑）
```

这证明 `onCodexReviewResult` 的 **codexReleased 重驱动**机制生效：session 先被 codex-hold（未过 codex 时不 spawn QA），Codex 真的 APPROVED 后，auto-QA **自动**从 hold 状态转为 spawn。

**证据 2（隔离 verify-approval 验证，规避了证据 1 场景里因我手工介入 approve_to_ship 造成的会话状态污染）**：新会话（execId `bb7a48b1...`）走 founder 已批准(`approved_to_ship`) + 用真实 `codex-review-result` CLI 命令登记 codex APPROVED（镜像 `await-codex-gate` 成功后的真实上报路径）：

```
flywheel-comm verify-approval --exec-id bb7a48b1... --pr-head 81cd974b...
  → {"approved":true,"reason":"approved","status":"approved_to_ship", ...}  exit 0
```

### (c) kill-switch 一开立即放行 — **PASS（CLI merge-gate 路径）/ 未验证（Bridge HTTP 路由，结构性原因）**

Lead 的硬要求原文是"kill-switch(=0)立即放行免重启"，而实际卡 merge 的权威路径是 runner-CLI 的 `verify-approval`（Bridge 侧 auto-QA 前置门是第二道防线）。二者分开报：

**5.1 CLI merge-gate 路径 —— PASS**（对着隔离临时文件，完全不碰共享 `~/.flywheel/.env`）：直接调用 PR #433 编译产物里的 `resolveCodexHardGateOn`（`verify-approval.ts`，真正决定能不能 merge 的那个函数）：

- 5/5 PASS：默认 ON、`.env` 里 `=0` 关闭、re-arm(`.env` 删行 + inherited env 残留旧 `=0` 不会被 bypass)、`.env` 不可读时 fallback inherited env、`args.env` 显式注入优先级最高。

**5.2 Bridge auto-QA 前置门（第二道防线）—— 纯逻辑 PASS，端到端 HTTP 路由未验证**：`codexHardGateEnabled`/`isCodexGateSatisfied`（`codex-gate.ts`）纯函数调用 7/7 PASS。但 Lead 要求的是**免重启**的**实时**切换，纯函数调用本身不能证明"实时"——真正需要证明的是 `/api/fleet/flag/apply` 打进正在跑的 Bridge 进程后，不重启就立刻放行。**这条本次结构性无法在 529 Room 验证**：该路由被 `FLYWHEEL_PROJECTS`(env-pinned 部署,529 slot 本身就是这种形态,故意的 split-brain guard)整体禁用，返回 404，与 FLY-827 代码本身无关。已用 §3 记录为 finding + follow-up 建议，**不计入本条的 PASS**，如实标记为未验证。

### (d) head 变 → 旧 approved 作废，需重过 — **PASS**

在 (b) 证据 2 的会话上追加一个新提交(`git commit --allow-empty`，新 head `bcca1aa5...`)：

```
1. codex_review_record 表里只有 (execId, 81cd974b) 一行 approved；对 (execId, bcca1aa5) 查询为空 —— 新 head 没有继承旧批准。
2. 手写旧的 code-review.json（reviewedHeadSha=81cd974b），此时 worktree HEAD 已经是 bcca1aa5：
   flywheel-comm await-codex-gate code --exec-id ... --worktree-path ...
   → "[await-codex-gate] reviewedHeadSha 81cd974b != current HEAD bcca1aa5 — the PR moved since
      Codex reviewed; re-run /codex-code-review for the new head"   exit code 1（fatal，未误上报）
```

### 附加：restart reconcile — **PASS**

对场景 (a) 里挂起的会话（execId `b3355026...`），**真实 kill + 真实重启** slot 2 的 Bridge 进程（同一个 `teamlead.db`，模拟 crash/重启恢复）：

```
[auto-qa] reconcile codex-hold re-fire for FLY-226 (b3355026...) @ 81cd974b
[auto-qa] codex-hold b3355026... — already notified for this head; skipping duplicate thread/instruction/alert
```

重启后正确重新识别挂起状态，且**幂等**（因为之前已经通知过，未重复刷屏），与 plan 描述完全一致。

## 3. Findings

### Finding 1（环境性，非 FLY-827 代码缺陷）：kill-switch 的 Bridge-side HTTP 路由持久化路径未 slot 隔离

`packages/teamlead/src/bridge/plugin.ts` 里 `flagRouteDeps.envPath` 硬编码为 `join(homedir(), ".flywheel", ".env")`——不管请求打向生产 Bridge(:9876)还是任何 529 slot Bridge，落盘目标都是**同一个**真实生产 `~/.flywheel/.env`。且该路由本身在 529 Room 里因为 `FLYWHEEL_PROJECTS` env-pinned 被整体禁用（404），本次没有触发落盘风险。但**一旦 FLY-827 未来合并上生产**，如果有人用生产 Fleet 控制台切换 `codex_hard_gate_killswitch`，那次切换的落盘文件是全机唯一的 —— 这本身是 FLY-247/FLY-709 既有设计（kill-switch 本来就该是全局的），不是新洞，但建议 follow-up：**给 529 Room 之类的隔离测试环境提供一个可选的 `FLYWHEEL_FLEET_ENV_PATH` 覆盖**，这样以后测 Bridge-side 实时切换就不需要碰共享文件、也不需要靠 env-pinned 这个巧合来避免误触生产配置。

### Finding 2（本次 QA 自己踩的坑，已修复且清理干净，供以后 529 Room QA 参考）

`flywheel-comm gate`/`respond` 命令的 CommDB 路径解析优先级是 `--db` > `FLYWHEEL_COMM_DB` 环境变量 > `--project`。QA runner 自身进程继承了 `FLYWHEEL_COMM_DB=~/.flywheel/comm/flywheel/comm.db`（生产 CommDB），如果驱动 slot Bridge 的 CLI 命令时忘记显式传 `--db <slot 的 comm.db 路径>`，会静默写入生产 CommDB。本次已实际踩到（一条 approve_to_ship 问题误写入生产库），发现后立即用 `DELETE FROM messages WHERE id=...` 精确删除了那一行（只删自己刚创建的那条，未动任何其它数据），已核实生产库干净。**建议 529 Room 文档补一条**：驱动任何 slot 的 `gate`/`respond`/`pending` 命令必须显式传 `--db`，不要依赖 env 继承。

## 4. 出范围确认

未评估 FLY-827 的设计合理性本身（Codex 已 5 轮 design + 3 轮 code review 批准）；未测 Codex code review 内容判断准不准（场景 b 证据 1 里 Codex 真的审了一个只有 2 行的 doc-only diff，判 APPROVED 是合理的，但"审得对不对"不是本 issue 的验证范围）；未碰生产 Bridge（:9876）。

## 5. 建议

**建议 founder-gated ship PR #433。** 理由：Lead 硬要求里真正卡 merge 的权威机制（`verify-approval` 的 codex 检查 + kill-switch）四条全过；未验证的只是 Bridge HTTP 路由这一条**第二道防线**的"免重启"子断言，且是因为 529 Room 自身架构（env-pinned）导致，不是 FLY-827 代码本身的问题——production 部署（非 env-pinned）里这条路由是能跑的。Finding 1 建议登记为独立 follow-up issue（给隔离测试环境加一个可选的 env-path 覆盖，方便以后真的把这条路由测到）。Finding 2 已经是行为纠正，不需要代码改动，只需要文档提醒。
