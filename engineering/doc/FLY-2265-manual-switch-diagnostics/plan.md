# FLY-2265 切号器 apply 失败 — 实施计划
Issue: FLY-2265 (https://linear.app/geoforge3d/issue/FLY-2265/切号器-flywheel-claude-profile-use-name-在凭证两侧健康时仍-flywheel-manual-switch)
日期: 2026-09-02
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本 DAG implement node 必须 inline 执行，不派发 successor、review 或 QA node。

**Goal:** 修复 FLY-2240 引入的手动切号 apply child `ENOENT`，并让进入 executor 后的 terminal `apply_failed` 在 stderr 与安全追加审计中保留具体原因。候选为空、usage 错误和 runtime preflight 不属于 apply failure，本单不改其既有退出与审计语义。

**Architecture:** 外层 Bash trampoline 是 apply primitive 身份的权威，由它把自身绝对路径传给 Node runtime。Node adapter 把未知 child stderr 归一化进错误 message；公共 CLI 公开 terminal failed `SwitchResult.reason`，并通过一个独立的 0600/O_NOFOLLOW append helper 为 Bash 尚未启动的 apply failure 写 fallback audit。候选选择、Keychain 原子写、账本 CAS、通知 outbox 和自动切换策略不变。

**Tech Stack:** Bash, TypeScript, Node.js `fs`/`child_process`, Vitest, pnpm monorepo.

---

## 文件边界

- 修改 `packages/claude-runner/bin/flywheel-claude-profile`：trampoline 仅负责传递当前 primitive 的绝对路径。
- 修改 `packages/claude-runner/test/claude-profile.test.ts`：在 owning package 固定 trampoline 传递的 primitive 身份。
- 修改 `packages/config/src/feature-flags/truth.ts`：说明手动入口会以自身路径覆盖 ambient profile-bin override。
- 修改 `packages/teamlead/src/account-heal/claude-profile-cli.ts`：未知 child failure 的受限 stderr 诊断进入 Error.message。
- 新建 `packages/teamlead/src/account-heal/manual-switch-audit.ts`：只负责安全追加失败审计，不读取 credential。
- 修改 `packages/teamlead/src/account-heal/account-switch-cli.ts`：输出失败 details、调用注入的 audit sink，并在 production deps 接上线述 helper。
- 修改 `packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts`：完整路径 public-use 阳性控制、synthetic writer 阴性控制与通知/未半写断言。
- 修改 `packages/teamlead/src/__tests__/claude-profile-cli.test.ts`：未知 child stderr 的 adapter 传播。
- 修改 `packages/teamlead/src/__tests__/account-switch-cli.test.ts`：CLI 诊断和 audit sink 调用。
- 新建 `packages/teamlead/src/__tests__/manual-switch-audit.test.ts`：JSON shape 与文件安全合同。
- 最后新建 `engineering/doc/milestones/FLY-2265.md`，作为 PR literal last commit。

## Task 1: 修复 public trampoline 的 profile-bin 身份传递

**Files:**
- Modify: `packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts`
- Modify: `packages/claude-runner/bin/flywheel-claude-profile`
- Modify: `packages/claude-runner/test/claude-profile.test.ts`
- Modify: `packages/config/src/feature-flags/truth.ts`
- Modify: `packages/teamlead/src/account-heal/claude-profile-cli.ts`（只同步 override contract 注释；诊断逻辑在 Task 2）

- [ ] **Step 1: 写失败测试**

先在 claude-runner owning-package 用例中让 sentinel 同时记录 `$FLYWHEEL_CLAUDE_PROFILE_BIN` 与 argv，并断言收到 `${PROFILE_BIN}|use school`；当前实现只传 argv，必须 RED。

再复制 primitive 为 0644 fixture，用 `/bin/bash <fixture> use school` 启动并注入 sentinel launcher；断言 rc=31、stderr 含 `profile primitive is missing or not executable`，且 sentinel log 不存在。这个负例固定“当前进程可由 bash 解释执行，但 delegated child 必须能直接 exec”的 preflight 合同。

随后在 public-use 集成测试中保留 `FLYWHEEL_CLAUDE_SWITCH_BIN=SWITCH_BIN`，删除遮蔽真实环境的显式 profile-bin：

```ts
process.env.FLYWHEEL_CLAUDE_SWITCH_BIN = SWITCH_BIN;
delete process.env.FLYWHEEL_CLAUDE_PROFILE_BIN;
```

为 child 构造去环境化的 `PATH`：逐个保留原 `PATH` 中不含可执行 `flywheel-claude-profile` 的目录，并在 spawn 前断言过滤后的每个目录都没有该名字。不要依赖开发机当前恰好 `command -v` 失败；Node、bash 与现有 fixture 所需系统工具仍从过滤后的目录解析。

继续断言 stdout 含 `Switched machine Claude account: personal → school`、临时 keychain state 变为 school、store generation 递增且通知 log 含 `--kind account_switched`。

- [ ] **Step 2: 运行并确认 RED**

Run:

```bash
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-claude-runner exec vitest run test/claude-profile.test.ts -t "public use releases its lock"
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/claude-profile-cli.integration.test.ts -t "public use routes through"
```

Expected: FAIL；stderr/result 包含 `spawn flywheel-claude-profile ENOENT` 或 `FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_failed`，临时 store 未切换。

- [ ] **Step 3: 最小实现**

在 `trampoline_atomic_switch()` 计算 launcher 前，把当前 Bash primitive 固定成绝对路径并覆盖 ambient 值：

```bash
local mode="$1" target="${2:-}" bin="${FLYWHEEL_CLAUDE_SWITCH_BIN:-}" profile_dir profile_bin
profile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || fail "cannot resolve profile runtime directory"
profile_bin="$profile_dir/$(basename "${BASH_SOURCE[0]}")"
if [[ ! -x "$profile_bin" ]]; then
  echo "FLYWHEEL_ATOMIC_SWITCH_RUNTIME_UNAVAILABLE: profile primitive is missing or not executable" >&2
  exit 31
fi
export FLYWHEEL_CLAUDE_PROFILE_BIN="$profile_bin"
```

覆盖而不是只在缺失时设置，保证 child apply 与 founder 实际启动的 primitive 字节一致，避免混合部署。

同步更新 `claudeProfileBinPath()` 的注释与 `feature-flags/truth.ts`：daemon/直接 Node 启动仍可用 env override；从 public Bash `use|next` 进入时，trampoline 的自身绝对路径具有权威性并覆盖 ambient 值。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2 两条命令。Expected: focused public-use test PASS，通知 log、Keychain fixture 与 store 断言均通过。

- [ ] **Step 5: 提交**

```bash
git add packages/claude-runner/bin/flywheel-claude-profile packages/claude-runner/test/claude-profile.test.ts packages/config/src/feature-flags/truth.ts packages/teamlead/src/account-heal/claude-profile-cli.ts packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts
git commit -m "fix(FLY-2265): preserve profile binary across manual switch"
```

## Task 2: 让未知 apply child stderr 进入 executor reason

**Files:**
- Modify: `packages/teamlead/src/__tests__/claude-profile-cli.test.ts`
- Modify: `packages/teamlead/src/account-heal/claude-profile-cli.ts`

- [ ] **Step 1: 写失败测试**

新增 adapter 用例，让 injected `execFile` 抛出带 stderr 的未知 exit：

```ts
const execFile = vi.fn(async () => {
  throw Object.assign(new Error("profile primitive exited 77"), {
    code: 77,
    stderr: "synthetic keychain writer rejected apply\nsecond line",
  });
});
await expect(deps(execFile).applyProfile("school")).rejects.toThrow(
  "profile primitive exited 77: synthetic keychain writer rejected apply | second line",
);
```

再加一个超过 2048 字符的 stderr，前部是 synthetic progress noise、末行是 `synthetic decisive apply verdict`；断言传播后的 message 保留末行且总 diagnostic 长度受限，防止实现退回 head-biased truncation。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/claude-profile-cli.test.ts -t "unknown apply failure"
```

Expected: FAIL；当前错误只有 `profile primitive exited 77`。

- [ ] **Step 3: 最小实现**

新增只处理诊断文本的 helper，删除控制字符、折叠换行并限制为 2048 字符。stderr 的 actionable verdict 位于尾部，因此超限时保留尾部并加省略标记：

```ts
function applyFailureDiagnostic(error: unknown, stderr: string): Error {
  const base = error instanceof Error ? error.message : String(error);
  const normalized = stderr
    .replace(/[\r\n]+/g, " | ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const detail = normalized.length > 2048
    ? `…${normalized.slice(-(2048 - 1))}`
    : normalized;
  return new Error(detail ? `${base}: ${detail}` : base, { cause: error });
}
```

在已类型化 marker/exit code 全部分派之后，以 `throw applyFailureDiagnostic(err, errText)` 替代 `throw err`。类型化的 11 类错误保持原样。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2，随后运行整个 adapter 文件：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/claude-profile-cli.test.ts
```

Expected: PASS，所有 typed-error mapping 仍通过。

- [ ] **Step 5: 提交**

```bash
git add packages/teamlead/src/account-heal/claude-profile-cli.ts packages/teamlead/src/__tests__/claude-profile-cli.test.ts
git commit -m "fix(FLY-2265): retain unexpected apply diagnostics"
```

## Task 3: 建立安全的 manual failure audit helper

**Files:**
- Create: `packages/teamlead/src/account-heal/manual-switch-audit.ts`
- Create: `packages/teamlead/src/__tests__/manual-switch-audit.test.ts`

- [ ] **Step 1: 写失败测试**

测试使用一个父目录存在、文件本身尚不存在的临时 audit path 后调用（首建 mode 必须被覆盖）：

```ts
appendManualSwitchFailureAudit({
  path: auditPath,
  command: "use",
  profile: "school",
  reasonCode: "apply_failed",
  reason: "spawn flywheel-claude-profile ENOENT",
  actor: "test",
});
```

断言唯一 JSONL record 是 `phase: "entry"`、`exitCode: 1`、`probeSummary: "apply_failed"`、`details.reasonCode/details.reason` 精确匹配，文件 mode 为 0600。reason 使用不含 credential 的 synthetic 诊断；raw JSONL 明确断言不含 `sk-ant-oat01` 与 `accessToken`。再把 audit path 变为 symlink 和 0644 regular file，分别断言 helper throws 且 referent 未改变。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/manual-switch-audit.test.ts
```

Expected: FAIL，module 不存在。

- [ ] **Step 3: 最小实现**

新 module 使用 `mkdirSync(dirname(path), {recursive:true, mode:0o700})`，open flags 为 `O_APPEND|O_CREAT|O_WRONLY|(O_NOFOLLOW ?? 0)`，并必须调用 `openSync(path, flags, 0o600)`；不得省略 mode。open 前若存在则 lstat，open 后 fstat + 再 lstat；三者都要求 same-owner regular non-symlink 0600，且 named/opened dev+ino 相同。写入一行 JSON 后 `fsyncSync(fd)`，finally `closeSync(fd)`。record shape 为：

```ts
{
  ts: new Date().toISOString(),
  cmd: input.command,
  profile: input.profile,
  phase: "entry",
  probeSummary: input.reasonCode,
  actor: input.actor,
  actorTrust: "untrusted_hint",
  exitCode: 1,
  details: { reasonCode: input.reasonCode, reason: input.reason },
}
```

helper 参数只接受 command/profile/reason 元数据，不接受 credential 或 child stdout。这里的单条 `phase:"entry", exitCode:1` 是 child 在 Bash `begin_audit` 前未启动时的 fallback failure record，按 FLY-2265 明确验收保留；它不是既有 Bash entry(null)→exit(N) 配对记录。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2。Expected: PASS，mode/symlink/wide-mode 负例全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/teamlead/src/account-heal/manual-switch-audit.ts packages/teamlead/src/__tests__/manual-switch-audit.test.ts
git commit -m "feat(FLY-2265): audit manual switch failures safely"
```

## Task 4: CLI 同时输出 reason 并调用 audit sink

**Files:**
- Modify: `packages/teamlead/src/__tests__/account-switch-cli.test.ts`
- Modify: `packages/teamlead/src/account-heal/account-switch-cli.ts`

- [ ] **Step 1: 写失败测试**

在 harness 增加 `auditFailure=vi.fn()`，构造：

```ts
switchAccount: vi.fn(async () => ({
  outcome: "failed" as const,
  reasonCode: "apply_failed" as const,
  reason: "spawn flywheel-claude-profile ENOENT",
})),
```

断言 rc=1，stderr 含：

```text
FLYWHEEL_MANUAL_SWITCH_FAILED reason=apply_failed details=spawn flywheel-claude-profile ENOENT
```

并断言 audit sink 收到 `{command:"use", profile:"school", reasonCode:"apply_failed", reason:"spawn ... ENOENT"}`。再让 sink throw，断言 CLI 仍 rc=1、原始 detail 仍输出，并额外输出 `FLYWHEEL_MANUAL_SWITCH_AUDIT_FAILED`。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-switch-cli.test.ts -t "apply failure"
```

Expected: FAIL；当前 stderr 没有 details，也没有 audit 调用。

- [ ] **Step 3: 最小实现**

给 `AccountSwitchCliDeps` 增加可注入：

```ts
auditFailure?: (input: {
  command: "use" | "next";
  profile: string | null;
  reasonCode: string;
  reason: string;
}) => void | Promise<void>;
```

在 terminal failed `SwitchResult` 分支先把 reason 归一化为单行、最多 2048 字符且超限保留尾部；将同一个归一化 reason 以 try/catch 传给 sink，再输出。稳定字段 `reason=<reasonCode>` 不改名；新增 `details=<reason>`。`no_account`、usage、runtime preflight 与 active-marker reconcile 控制分支保持既有行为，不伪装成 apply failure audit。

- [ ] **Step 4: 运行并确认 GREEN**

重复 Step 2，然后运行整个 CLI 单测文件。Expected: PASS，既有 no-target/reconcile/noop 行为不变。

- [ ] **Step 5: 提交**

```bash
git add packages/teamlead/src/account-heal/account-switch-cli.ts packages/teamlead/src/__tests__/account-switch-cli.test.ts
git commit -m "fix(FLY-2265): surface and audit manual apply failures"
```

## Task 5: 接上 production audit，并做正/负端到端控制

**Files:**
- Modify: `packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts`
- Modify: `packages/teamlead/src/account-heal/account-switch-cli.ts`

- [ ] **Step 1: 写失败的阴性集成测试**

创建只拒绝 `security -i` 的 wrapper；read path 继续转发到 fixture fake security：

```bash
case "${1:-}" in
  -i) cat >/dev/null; echo "synthetic keychain writer rejected apply" >&2; exit 77 ;;
  *) exec "$REAL_FAKE_SECURITY" "$@" ;;
esac
```

使用健康 school probe 运行 public `use school`，断言：rc=1；stderr 同时含 `reason=apply_failed` 与 `synthetic keychain writer rejected apply`；临时 Keychain bytes、`.active`、store activeAccount/generation 均不变；audit JSONL 中存在一条：

```ts
expect.objectContaining({
  cmd: "use",
  profile: "school",
  phase: "entry",
  exitCode: 1,
  details: {
    reasonCode: "apply_failed",
    reason: expect.stringContaining("synthetic keychain writer rejected apply"),
  },
})
```

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/claude-profile-cli.integration.test.ts -t "failed public apply"
```

Expected: FAIL；Node failure audit 尚未接入 production deps。

- [ ] **Step 3: 最小 production wiring**

`makeProductionDeps()` 的 `auditFailure` 调用 Task 3 helper，path 取 `FLYWHEEL_PROFILE_AUDIT_LOG` 或 `join(homedir(), ".flywheel/claude-profile-audit.log")`，actor 取 `FLYWHEEL_AUDIT_ACTOR` 或 `ppid:${process.ppid}`。audit helper throw 由 Task 4 的 CLI catch 处理。阴性集成测试读取 raw audit JSONL 并断言不含 fixture 的 `sk-ant-oat01` 与 `accessToken`，沿用既有 Bash audit red line。

- [ ] **Step 4: 运行并确认 GREEN + 阳性通知控制**

先重复 Step 2；再运行 Task 1 的 public-use 阳性控制和完整四个聚焦文件：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/claude-profile-cli.integration.test.ts -t "public use routes through"
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/manual-switch-audit.test.ts \
  src/__tests__/account-switch-cli.test.ts \
  src/__tests__/claude-profile-cli.test.ts \
  src/__tests__/claude-profile-cli.integration.test.ts
```

Expected: 阴性 fixture 留账且不半写；阳性 fixture 切到健康 school 并记录 account_switched notification；focused suites 全绿。

- [ ] **Step 5: 共享自动路径回归**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/switch-executor.test.ts \
  src/__tests__/quota-monitor.test.ts \
  src/__tests__/quota-monitor-runtime.test.ts
```

Expected: PASS；自动 quota monitor 继续复用同一 executor/adapter，typed outcomes、账本 CAS 和通知均未回归。

- [ ] **Step 6: 提交**

```bash
git add packages/teamlead/src/account-heal/account-switch-cli.ts packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts
git commit -m "test(FLY-2265): prove switch success and audited failure"
```

## Task 6: 全仓验证、code review、PR 与 literal-last milestone

**Files:**
- Create last: `engineering/doc/milestones/FLY-2265.md`

- [ ] **Step 1: 新增 shell suites（若本 PR 新建）逐条执行**

本计划不预期新增 `scripts/__tests__/*.test.sh`。若实现过程中确有新增，逐个直接运行并记录 rc=0；不得用“CI 会跑”代替。

- [ ] **Step 2: 精确全仓 gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Expected: 三条均 rc=0。记录完整命令、时间与结果；不得拿 focused tests 外推。

- [ ] **Step 3: diff 与需求审计**

```bash
git status --short
git diff --check
git diff origin/main...HEAD -- packages/claude-runner/bin/flywheel-claude-profile packages/teamlead/src/account-heal packages/teamlead/src/__tests__
```

逐项确认：根因路径、stderr detail、failure audit shape、阳性通知、阴性未半写、自动路径回归；确认没有生产 `use`、secret、CLAUDE.md 或部署改动。

- [ ] **Step 4: code review**

按 runner 注入合同通过 `codex:rescue` 运行独立 code review，随后：

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
REVIEW_GATE_JSON=$(node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id "$FLYWHEEL_EXEC_ID" --no-block "Code review requested for FLY-2265")
QUESTION_ID=$(node -e 'const value=JSON.parse(process.argv[1]); if(typeof value.questionId!=="string") process.exit(1); process.stdout.write(value.questionId)' "$REVIEW_GATE_JSON")
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$QUESTION_ID"
```

轮询 `check`；CHANGES_REQUESTED 时修复 blocking finding、跑相关 RED/GREEN 与全仓 gates、提交并开全新 review gate。APPROVED advisories 用 report 转给 Lead。

- [ ] **Step 5: push code head，确认 CI，再开 PR**

```bash
git push -u origin flywheel-FLY-2265
# 先用 apply_patch 创建 /private/tmp/fly2265-pr-body.md，内容列出本计划要求的证据。
PR_URL=$(gh pr create --base main --head flywheel-FLY-2265 --title "fix(FLY-2265): restore diagnosable Claude profile switching" --body-file /private/tmp/fly2265-pr-body.md)
PR_NUMBER=${PR_URL##*/}
test -n "$PR_NUMBER"
```

PR body 列出 root cause、RED/GREEN、全仓 gates、无生产账号切换、正/负控制与 code-review verdict。

- [ ] **Step 6: literal-last milestone commit**

创建 `engineering/doc/milestones/FLY-2265.md`，记录 issue、PR、提交、验证、review 与未执行生产切号的边界；确认它是 PR 上 literal last commit：

```bash
git add engineering/doc/milestones/FLY-2265.md
git commit -m "docs(milestone): record FLY-2265 delivery"
git push
```

milestone 后不再提交 progress。若 code/plan 需再改，milestone 不再是 last，必须更新 milestone 并重新提交为新 last commit。

- [ ] **Step 7: implement completion route**

不可逆投递前再次 `inbox`，然后：

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$PR_NUMBER"
```

不派发 QA、不申请 ship、不 merge、不部署；完成后 park 由 DAG controller 接管。

## 自审

- Spec coverage: 诊断、executor terminal apply 失败审计、根因、健康阳性+播报、人工 apply 阴性、自动共享路径、无生产切号均有可执行证明；no-target/usage/runtime-preflight 明确不扩 scope。
- Review hardening: audit 首建显式 0600、stderr 保留尾部、PATH 去环境化、profile primitive 可执行性、owning-package contract 与 secret red line 均有测试步骤；fallback `entry/1` 是明确需求而非 Bash 两阶段事件。
- Placeholder scan: gate question id 与 PR number 都由命令回执解析成 shell 变量；没有手填占位符或待设计实现。
- Type consistency: failure reason 沿 `Error.message → SwitchResult.reason → AccountSwitchCliDeps.auditFailure/details` 单向传递；stable reasonCode 不变。
- Scope: 不更改候选策略、Keychain 算法、通知语义、deployment 或 founder 账号状态。
