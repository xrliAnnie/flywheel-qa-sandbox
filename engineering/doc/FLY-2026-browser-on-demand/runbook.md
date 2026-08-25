# FLY-2026 浏览器按需启动 — 操作手册
Issue: FLY-2026 (https://linear.app/geoforge3d/issue/FLY-2026/宿主资源-浏览器按需启动playwright-常驻实例从-59-降到个位数1944-a3-遗留-w5-段)
日期: 2026-08-24
基于: plan.md

## 0. 权限边界与证据目录

本手册供有宿主权限的 operator / QA 执行。implement Runner 只交付代码、测试和手册，**不**修改 founder 的生产 settings、不结束活 session、不 kill 进程、不重启 Bridge，也不运行 `restart-services.sh` 或 `scripts/request-restart.sh`。任何存量孤儿的处置都要先取得 founder 对该次操作、该组 exact identities 的明确授权。

在开始前创建一个只存证据的目录；后续命令都把 stdout/stderr 和时间写入这个目录：

```bash
export FLY2026_EVIDENCE="$PWD/fly-2026-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$FLY2026_EVIDENCE"
```

建议固定文件名：

- `00-preflight.txt`：版本、配置与 allowlist 审计；
- `01-before.json`、`02-after-qa-start.json`、`03-after-qa-close.json`：cutover 比较；
- `10-steady-a.json`、`11-steady-b.json`：间隔 60 秒的空闲稳态样本；
- `20-qa-browser.txt`、`21-proofshot.txt`、`22-cic.txt`：三条真实路径结果；
- `30-windows.json`：CoreGraphics 窗口普查；
- `40-disposition.md`：存量、未知来源和任何 founder 批准的处置记录。

证据里必须保留完整 `ProcessIdentity`（`pid`、`lstart`、`startedAtEpochMs`、`comm`），不能只抄一个会复用的 PID。需要处置时，再对该 exact identity 单独保存 `ps -p <pid> -ww -o pid=,ppid=,lstart=,comm=,command=`，留下 profile 与当前 parent 证据。

## 1. Preflight：只读，不切换

### 1.1 构建并确认现有 writer 状态

在已审 PR head 的干净 worktree 中构建 TeamLead；census 的 freshness gate 会拒绝脏源码或过期 `dist`：

```bash
git rev-parse HEAD | tee "$FLY2026_EVIDENCE/head.txt"
pnpm --filter flywheel-teamlead build
bash scripts/setup-mcp-on-demand.sh check "$HOME/.claude/settings.json" \
  2>&1 | tee "$FLY2026_EVIDENCE/00-writer-check.txt"
```

`check` 成功表示 machine default 已是 Playwright plugin off + headless on；失败表示还没 apply 或发生 drift，不要把失败改写成通过。

### 1.2 配置审计

确认 runner slim kill-switch 没被关闭：

```bash
if [ "${FLYWHEEL_RUNNER_SLIM_MCP:-}" = "0" ]; then
  echo "REFUSE: FLYWHEEL_RUNNER_SLIM_MCP=0 disables the profile contract" >&2
  exit 1
fi
printf 'FLYWHEEL_RUNNER_SLIM_MCP=%s\n' "${FLYWHEEL_RUNNER_SLIM_MCP:-<unset; normal default>}"
```

审计生产 roster 中所有显式 Lead opt-in。当前预期为空；出现结果时，逐个 exact project + Lead identity 纳入 QA，不能把一个 Lead 的结果外推给另一个：

```bash
node -e '
const fs = require("node:fs");
const projects = JSON.parse(fs.readFileSync(process.env.HOME + "/.flywheel/projects.json", "utf8"));
const rows = projects.flatMap((project) => (project.leads || [])
  .filter((lead) => lead.playwrightMcp === true)
  .map((lead) => ({ projectName: project.projectName, agentId: lead.agentId, backend: lead.backend || "claude-code" })));
process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
' | tee "$FLY2026_EVIDENCE/00-lead-playwright-allowlist.json"
```

同时记录本轮用于阳性对照的 positive opt-in 路径：优先用 `sessionRole=qa` 的 Claude Runner；`playwright` / `full-mcp` label 也会 opt in。普通 Runner、普通 Lead 和 founder Terminal 没有 opt-in。确需 founder 一次性验证时，只在一个 fresh launch 上用：

```bash
claude --settings '{"enabledPlugins":{"playwright@claude-plugins-official":true}}'
```

这不是持久设置。当前 production Lead allowlist 为空时，Lead browser 行明确记为 `not applicable`，不要冒充已通过。

### 1.3 基线 census

```bash
set +e
node scripts/fly-2026-browser-idle-census.mjs --once --print \
  >"$FLY2026_EVIDENCE/01-before.json" \
  2>"$FLY2026_EVIDENCE/01-before.stderr"
FLY2026_CENSUS_RC=$?
set -e
printf 'baseline census exit=%s\n' "$FLY2026_CENSUS_RC" | tee -a "$FLY2026_EVIDENCE/00-preflight.txt"
```

在 cutover 前，exit 非零可能只是如实显示存量 `inScopeProcessCount >= 10`，不等于 CLI 坏了；但 `status="unknown"` 表示传感器/identity join 不完整，不能继续判定。保存 `external` 中 Cursor/IDE 等完整祖先正面证明的树，它们只披露、不进入 Flywheel `<10` 指标。

## 2. Apply：唯一 writer 与 receipt

只有被授权的 operator 执行现有 writer：

```bash
bash scripts/setup-mcp-on-demand.sh apply "$HOME/.claude/settings.json" \
  2>&1 | tee "$FLY2026_EVIDENCE/05-apply.txt"
```

writer 只有在真实 mutation 时才原子地产生 backup 和 receipt；不要手工改 receipt。若存在 receipt，保存其中的 `backupPath`、`preimageSha256`、`postimageSha256` 和 UTC `appliedAt`。若输出精确为 `no-op: policy already applied` 且不存在 receipt，则必须重新跑 `check`，把检查完成时刻作为本轮 **policy verification epoch**；它不是历史 apply 时刻，只能证明此刻之后的新进程是否违反已生效策略。其它“无 receipt”形状一律 fail-close。

只把 receipt 的 UTC `appliedAt` 或 no-op 后的本轮 verification epoch 用作比较轴，绝不直接拿无 timezone 的本地 `lstart` 与 UTC 比：

```bash
FLY2026_POLICY_RECEIPT="$HOME/.claude/settings.json.flywheel-mcp-policy-receipt.json"
if [[ -f "$FLY2026_POLICY_RECEIPT" ]]; then
  cp "$FLY2026_POLICY_RECEIPT" "$FLY2026_EVIDENCE/05-policy-receipt.json"
  export FLY2026_APPLY_EPOCH_MS="$(node -e '
const fs = require("node:fs");
const p = process.env.HOME + "/.claude/settings.json.flywheel-mcp-policy-receipt.json";
const receipt = JSON.parse(fs.readFileSync(p, "utf8"));
const epoch = Date.parse(receipt.appliedAt);
if (!Number.isFinite(epoch)) throw new Error("invalid receipt appliedAt");
process.stdout.write(String(epoch));
')"
  FLY2026_EPOCH_SOURCE=receipt
elif grep -Fq '] no-op: policy already applied in ' "$FLY2026_EVIDENCE/05-apply.txt"; then
  bash scripts/setup-mcp-on-demand.sh check "$HOME/.claude/settings.json" \
    2>&1 | tee "$FLY2026_EVIDENCE/05-noop-policy-check.txt"
  export FLY2026_APPLY_EPOCH_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
  FLY2026_EPOCH_SOURCE=noop-policy-verification
else
  printf 'FAIL: apply did not produce a receipt or the exact safe no-op result\n' >&2
  exit 1
fi
printf 'epochSource=%s applyEpochMs=%s\n' \
  "$FLY2026_EPOCH_SOURCE" "$FLY2026_APPLY_EPOCH_MS" \
  | tee "$FLY2026_EVIDENCE/05-apply-epoch.txt"
```

对 census 每个 identity 按以下规则标记：

- `startedAtEpochMs < applyEpochMs - 5000`：pre-apply backlog；
- `startedAtEpochMs > applyEpochMs + 5000`：post-apply；
- 位于 `±5000ms` 边界：重采并人工核对，不能静默归入 backlog。

### 2.1 时间比较与 policy 的阳性/阴性对照

apply 后至少等 10 秒，再启动一个 fresh QA positive-opt-in session。首个 browser tool 前应有 MCP server、但无该 profile 的 Chrome；首个真实 browser tool 后 census 必须把该 MCP root 标为 post-apply `activeManaged`。关闭该 QA session并等待 teardown 后，再启动一个 fresh ordinary Claude session；它必须没有 post-apply Playwright MCP root。

这两个对照缺一不可：前者证明 `startedAtEpochMs` 比较和 census 能看到真实目标，后者证明 ordinary policy 确实 default-off。

## 3. 存量收敛与 orphan 权限

### 3.1 Active backlog

- Lead 依赖 FLY-1959 的 00:00 / 12:00 正常班车完成后续 turnover，本手册不触发重启；
- 长跑 Runner 等其自然 terminal；
- founder Terminal 只在 Annie 协调并保存工作后重开；
- 普通 pre-apply active tree 在 owner session 结束后应由 FLY-1867 teardown 回收。

active backlog 未清零时暂停稳态验收，不因它回滚已正确生效的 machine policy。

### 3.2 Orphan backlog

orphan 没有可等待的 owner，必须按形状处理：

1. `ppid=1` 的 unattributed Chrome main：既有 reaper 只会 `wouldKillUnattributed`。只有 founder 对 exact identities 给出单次明确批准后，operator 才能在一次 Bridge boot 环境中使用既有 `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1` seam；不得持久启用。本 Runner 不设置该环境、不重启服务。
2. 挂在长寿命 `agent-browser` daemon 下、使用 system TMPDIR exact profile 的 Chrome main：上述 `ppid=1` seam **不覆盖**。`orphanedManaged.processes` 只列 Chrome main 与其 descendant tree，持有它的 daemon 本身不在这棵 Chrome 输出里；用 `ps -p <main-pid>,<daemon-pid> -ww -o pid=,ppid=,lstart=,comm=,command=` 把 exact profile 与 parent chain 追加到 `40-disposition.md`，并向 founder 请求该组进程的一次性人工处置范围。
3. 不提供、不执行泛化的 `pkill` / `killall` / 新 reaper。任何获批操作都要先重新 census，确认 `(pid,lstart,comm,profile)` 未漂移，再按批准范围执行并立即复测。

pre-apply active 与 orphan backlog 都清零前，不进入稳态验收。

### 3.3 Crashpad ruled-out 边界与未验证项

`ppid=1` 的 Chrome crashpad helper 既不是能承载页面/窗口的 Chrome main，也已丢失可审计的原 browser parent，不能塞进 managed tree denominator 或凭猜测归给 founder/Playwright。census 必须把同时满足以下条件的 identity 显式列入 `ruledOut.unattributedPpid1CrashpadHandlers`，不得静默丢弃：

- OS `comm` 或 argv executable basename 精确等于 `chrome_crashpad_handler`；
- 当前 `ppid === 1`。

macOS 上 reparent 后的真实 handler argv 是 `--monitor-self` / `--monitor-self-annotation=ptype=crashpad-handler`，不是 child-handler 形状的 `--type=crashpad-handler`。因此不得把后者当必要条件；exact executable identity + PPID 1 才是可观测且稳定的边界。R4 reviewer 在 rebased exact head 上看到 8 个此类 live row，8/8 为 PPID 1、0/8 含 exact `--type=crashpad-handler`，该反例已进入 classifier fixture。

QA 的宿主观察边界是每个仍存活 browser 大约伴随 **1–2 个**此类 helper，因此 ruled-out 数量只能随 live browser 有界；它不是“任意 crashpad 都可忽略”的豁免。若零 live browser 时 handler 仍持续存在、或数量明显超过这个有界关系，稳态验收失败并升级为独立泄漏调查。

本 implement node 的受管 sandbox 对直接 `ps` 直测返回权限拒绝（`EPERM`），所以“约 1–2 / live browser”的宿主相关性及真实桌面零可见窗在这里仍为 **unverified**。独立 QA/operator 必须在 founder 桌面会话保存 live browser main 数、该 ruled-out 数组与 §6 CoreGraphics 结果；没有这三份同窗证据，不能把本地单测冒充真机验收。

## 4. 空闲稳态验收

确认当前没有 browser work 后采两份，严格间隔至少 60 秒：

```bash
node scripts/fly-2026-browser-idle-census.mjs --once --print >"$FLY2026_EVIDENCE/10-steady-a.json"
sleep 60
node scripts/fly-2026-browser-idle-census.mjs --once --print >"$FLY2026_EVIDENCE/11-steady-b.json"
```

两份都必须满足：

- `status === "ok"`；
- `singleDigit === true`；
- `inScopeProcessCount < 10`；
- `orphanedManaged.processes` 已包含在该数字内，不允许“孤儿满地但仍绿”；
- `external` 单列披露，不冒充 Flywheel managed，也不据此回滚。
- `ruledOut.unattributedPpid1CrashpadHandlers` 已按 §3.3 单列；确认它与 live browser 保持约 1–2 的有界关系，且没有在零 live browser 时继续增长。

任何 `unknown`、任一份 `>=10` 或未处置 backlog 都是未通过。

## 5. 三条真实 browser 路径

### 5.1 QA browser / Playwright MCP

用 fresh QA 或 `playwright` / `full-mcp` labeled Runner：

1. session 刚起时 census 证明 MCP server 存在、Chrome 尚未启动；
2. 调第一次 browser tool 后，census 证明 Chrome 按需出现；
3. 完成真实 navigation 与 screenshot；
4. 关闭 session/teardown；
5. census 证明对应 MCP/Chrome tree 消失并回落到稳态。

通过 `browser_evaluate` 记录该会话的 `navigator.userAgent`；`HeadlessChrome/...` 只作二次佐证，桌面判据以 §6 的 CoreGraphics 为准。

### 5.2 ProofShot

执行一份真实 `visual-capture` / report screenshot，保存 PNG 与日志。确认首个 capture 才启动其 agent-browser Chrome，成功 `proofshot stop` 后对应 tree 消失并回落。自动测试另覆盖“start 成功、screenshot 失败”的 finally cleanup；若真实 stop 失败，warning 不能覆盖原 screenshot 错误。

### 5.3 Claude-in-Chrome（CiC）

使用已连接的 extension 完成真实 tab 查询/页面读取；确认此路径不创建新的 Playwright managed profile，结束后空闲 census 不增长。不要为了测试 CiC 关闭或杀掉 founder 自己的普通 Chrome。

## 6. Founder 桌面窗口回归

从**同一次** fresh census 取得目标受管 Chrome main PID：Chrome-family `comm`、无 `--type=`，且 exact `user-data-dir` 属于该 QA/ProofShot profile。不要用 `grep headless` 猜 PID。

将以下内容保存为 `$FLY2026_EVIDENCE/window-census.js`，然后执行 `osascript -l JavaScript`：

```js
ObjC.import('CoreGraphics');
const arr = $.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
  $.kCGNullWindowID,
);
const count = {};
for (let i = 0; i < $.CFArrayGetCount(arr); i++) {
  const d = ObjC.castRefToObject($.CFArrayGetValueAtIndex(arr, i));
  if (ObjC.unwrap(d.objectForKey('kCGWindowLayer')) !== 0) continue;
  const pid = ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID'));
  count[pid] = (count[pid] || 0) + 1;
}
JSON.stringify(count);
```

```bash
osascript -l JavaScript "$FLY2026_EVIDENCE/window-census.js" \
  | tee "$FLY2026_EVIDENCE/30-windows.json"
```

同一把尺子必须同时满足：目标受管 Chrome main PID 的 layer-0 on-screen window 数为 `0`；founder 普通 Chrome main 的阳性对照为 `>0`。阳性对照不是 `>0` 时，说明窗口普查能力本身不可用，本项只能记 `unknown`，不能通过。

## 7. 失败、暂停与 rollback

| 现象 | 动作 | 是否 rollback settings |
|---|---|---|
| pre-apply active/orphan backlog 仍在 | 暂停稳态验收；按 §3 等待或走 founder-gated disposition | 否 |
| Cursor/IDE 等完整祖先证明的 external | 披露 owner 与 tree，不纳入 managed 指标 | 否 |
| census `status=unknown` / sensor 或 join 失败 | 换有权限宿主重采；仍失败则停并升级 | 否 |
| post-apply `ppid=1` orphan，但来源已丢失 | hard-fail 并暂停；保留 exact identities，按未知来源升级 | **否，不能仅凭 orphan 回滚** |
| fresh ordinary Claude control 同时复现 post-apply MCP，或有其它 Claude provenance | 判定 policy/teardown 失败；保存证据后用 receipt writer rollback | 是 |
| post-apply system-TMP agent-browser orphan | 判定 ProofShot cleanup hard failure；修 cleanup 并重新验证 | 否，settings rollback 修不了 agent-browser |
| ProofShot screenshot 与 cleanup 都失败 | 原 screenshot error 为主因，cleanup error 作为 warning 保留 | 否 |
| QA browser positive opt-in 不起或 ordinary control 错误起 | 暂停 cutover并保存 launcher/profile evidence | 只有 ordinary policy 失败或 Claude provenance 才是 |
| 受管 Chrome 出现 layer-0 窗口且 founder 阳性对照有效 | 判 headless policy 回归，保存窗口证据 | 是 |

需要 rollback 时只用 receipt-aware writer：

```bash
bash scripts/setup-mcp-on-demand.sh rollback "$HOME/.claude/settings.json" \
  2>&1 | tee "$FLY2026_EVIDENCE/rollback.txt"
```

rollback 会验证 receipt、backup hashes、CAS 与 writer-owned paths；冲突时它会 fail closed，不得手工覆盖 settings。

## 8. 完成记录

只有以下证据全部齐全，宿主 cutover 才可记为验收完成：

- receipt / backup 与 apply epoch；
- QA positive-control 和 fresh ordinary negative-control；
- pre-apply active/orphan backlog 清零，或每项都有 founder 批准且已验证的 disposition；
- 两份相隔 60 秒、均 `status=ok && singleDigit=true` 的稳态 census；
- QA browser、ProofShot、CiC 三条真实路径；
- CoreGraphics 目标 `0` + founder Chrome 阳性对照 `>0`。

本 implement node / PR 的完成仅表示“代码与手册可供 QA/operator 使用”，不代表生产宿主已 apply、已清存量或已完成 GUI 验收。
