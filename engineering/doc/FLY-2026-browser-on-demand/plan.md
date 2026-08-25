# FLY-2026 浏览器按需启动 — 实施计划
Issue: FLY-2026 (https://linear.app/geoforge3d/issue/FLY-2026/宿主资源-浏览器按需启动playwright-常驻实例从-59-降到个位数1944-a3-遗留-w5-段)
日期: 2026-08-24
基于: research.md

## 0. 目标与完成定义

把 FLY-1944 留下的 W5 从“代码能力已具备、宿主未切换”推进为可执行且可审计的交付：

1. 普通会话通过既有 machine policy 不再常驻 Playwright MCP；显式 QA/browser 路径继续按需启用；
2. ProofShot 在成功和失败路径都直接 stop，用完即收；
3. 新的只读 census 能 fail-closed 地证明空闲 **Claude/Flywheel 在役 + 既有回收权威覆盖的孤儿** Playwright/ProofShot process union 为个位数，并只把正面证明由 Cursor/IDE 持有的树排除；
4. cutover runbook 能让有宿主权限的 operator 完成 apply、controlled reopen 与三条真实路径回归；
5. 本 implement node 完成代码、测试、review 与 PR，不运行生产重启/合并/部署。

完成定义不是“本 sandbox 扫不到进程”，而是：仓库代码/测试通过、review APPROVED、PR 已开；宿主验收由 QA/operator 产出带时间戳的 `status=ok` census 和 GUI 能力证据。本 bounded implement node 交付的是正确计数与可执行 runbook；已经存在的 pre-apply orphan backlog 若需要人工 drain，属于 founder-gated 运维执行，不能冒充本 node 已经完成，也不能授权本 runner 越权 kill/restart。

## 1. Scope / non-goals

### Scope

- 修复 `visualCapture()` 的 post-start failure cleanup。
- 增加 TeamLead read-only browser idle census 纯分类模块、collection adapter、JSON CLI 与测试。
- 编写本 issue 的 cutover/verify runbook，复用 `setup-mcp-on-demand.sh`。
- 用现有 `runner-mcp-profile` / reaper 测试回归普通 default-off 与 QA positive opt-in。
- 完成 targeted + full-repo gates、Codex code review、PR。

### Non-goals

- 不造新的 MCP proxy、browser supervisor、idle timer 或 Chrome kill authority。
- 不增加新的配置 writer、feature flag 或长期双真相。
- 不关闭/回收 founder 普通 Chrome；不把 Claude-in-Chrome 改成 Playwright。
- 不在 implement runner 中执行 `restart-services.sh`、request-restart、批量结束活 session、合并或部署。
- 不把运行中的 browser tree 强制限定为个位数；阈值只针对无受管 browser work 的 idle steady state。

## 2. 设计确认点（design review 的 seam contract）

实现前请 reviewer 明确确认以下 seam；任一项变化先更新本文，再进入 RED：

1. `visualCapture()` 是 ProofShot cleanup 的公共测试 seam。
2. census 只复用一份 `collectChromeSweepSample()` 与现有 exact helpers，不调用 `defaultListProcesses()` 制造第四个采样时间点，也不复制 shell `ps`。
3. census 分类核心是纯函数，输入为完整 `ChromeSweepSample`，输出稳定 JSON；任一 sensor failure、candidate-relevant join 缺失、非 `ppid=1` orphan carve-out 的 ancestor chain 缺失/循环、逐行 classifier `unknown` 一律整体 `unknown`。
4. ownership 是三态而非二元：`activeManaged` 需要 Claude ancestor 或 Flywheel execId；`orphanedManaged` 是 owner evidence 已失但 exact shape 落在现有 Flywheel cleanup 权威（`ppid=1` MCP、`ppid=1` Playwright profile Chrome、无 execId 的 exact agent-browser profile）；只有完整 live ancestor chain 正面证明 non-Claude holder 才是 `external`。
5. `< 10` 才是个位数；`10` 必须 false。
6. 宿主 cutover 直接调用现有 writer，不新增 wrapper writer；operator evidence 与代码 PR 解耦。

### Design review R1 修正记录

| Finding | 处理 |
|---|---|
| HIGH `census-counts-unmanaged-mcp-holders` | managed 改为 ancestor ownership，Cursor/IDE positive holder 排除；R2 再补失附着 orphan 第三态；加 RED 负例 |
| MEDIUM `two-probe-snapshot-skew` | 删除 `defaultListProcesses()`，只消费一份三 pass `ChromeSweepSample` |
| MEDIUM `classify-snapshot-overall-masks-unknown` | 不读 aggregate `overall`；逐行任一 unknown 即整体 unknown；加 match+unknown RED |
| MEDIUM `aggregate-error-hides-cause-in-cli` | 对齐 `publish-report`：cleanup warn，不 mask 原始错误 |
| MEDIUM `runbook-convergence-vs-rollback` | 先拆 pre-apply backlog；R2 将比较尺改为 epoch；等班车/自然 terminal；旧 backlog/external 不 rollback |
| MEDIUM `ci-enumeration-missing` | 明列 `ci.yml`、`ci-structure.test.sh` 与两个本地 inventory gate |
| LOW `preflight-missing-optin-audit` | preflight 加 kill-switch、Lead allowlist、QA/label positive opt-in 审计 |
| LOW `window-census-snippet-not-committed` | runbook 内嵌已验证 JXA 与 founder Chrome 阳性对照 |

### Design review R2 修正记录

| Finding | 处理 |
|---|---|
| HIGH `ownership-rule-hides-orphaned-leaks` | 加 `orphanedManaged` 第三态并计入 in-scope union；只有正面 non-Claude owner 才 external；补三条 orphan RED |
| MEDIUM `applyat-lstart-timezone-mismatch` | `ProcessIdentity` 输出由 census 计算的 `startedAtEpochMs`；runbook 只比较 epoch，并加 post-apply QA positive control 与 ±5s boundary |
| LOW `reuse-argv-split-helper` | 把现有 `splitPsCommand` 以 `splitMcpPsCommand` 向后兼容 export，census 直接复用并加 parity test |
| LOW `warn-default-sink-unspecified` | `warn` 默认明确为 `console.error`；双失败测试断言 warning 实际发出 |

### Design review R3（APPROVED with advisories）

| Advisory | 处理 |
|---|---|
| MEDIUM `orphan-backlog-has-no-drain-path` | runbook 明确两条 founder-gated drain/escalation：boot-time `ppid=1` Chrome main 才可能用既有 one-shot migrate seam；daemon-held tree 不受该 seam 覆盖，必须 founder 批准一次性人工处置。本 implement node 不执行 |
| MEDIUM `ppid1-orphan-cannot-prove-flywheel-origin` | post-apply orphan 一律先 hard-fail/pause；只有 fresh ordinary-session positive control 同时复现 policy failure，或另有 Claude provenance，才 rollback settings；否则升级来源未知 orphan，不回滚正确 policy |

## 3. Slice A — ProofShot failure cleanup（RED → GREEN → REFACTOR）

### A1. RED

文件：`packages/flywheel-comm/src/__tests__/visual-capture.test.ts`

新增使用公开 `visualCapture()` 的测试：

- `proofshot start` 成功；
- `proofshot screenshot` 抛出主错误；
- 断言 `proofshot stop` 恰好尝试一次；
- 断言 visual lock 恰好释放一次；
- 断言 caller 仍能看到 screenshot 主错误。

再补一条双失败合同：screenshot 与 cleanup stop 都失败时，注入的 warning sink 确实收到 cleanup 错误，但 caller 仍收到原始 screenshot 错误；正常 stop 失败时不在 `finally` 二次尝试。另测未注入 sink 时调用默认 `console.error`，不能静默吞错。

先运行该 test file 并记录预期失败。

### A2. GREEN

文件：`packages/flywheel-comm/src/commands/visual-capture.ts`

- start 成功后设置 `proofShotStarted=true`；
- 每次调用 stop 前先设置 `proofShotStopAttempted=true`；
- `finally` 在 started 且尚未 attempted 时补一次 stop；
- cleanup stop 失败调用 `args.warn ?? console.error`，对齐 `publish-report` 的 warn-not-mask 语义；原始错误继续由现有 control flow 抛出；
- 无论哪条路径都 release lock、close local model server。

### A3. REFACTOR / verify

保持现有成功路径顺序和 artifact 解析不变；不增加错误包装 helper。运行 flywheel-comm targeted tests、lint/typecheck/build。

## 4. Slice B — fail-closed idle census（RED → GREEN → REFACTOR）

### B1. 公共类型与输出合同

新增：`packages/teamlead/src/bridge/browser-idle-census.ts`

建议输出：

```ts
type ProcessIdentity = {
  pid: number;
  lstart: string;
  startedAtEpochMs: number;
  comm: string;
};

type BrowserIdleCensus = {
  schemaVersion: 1;
  observedAt: string;
  observedAtEpochMs: number;
  status: "ok" | "unknown";
  singleDigit: boolean | null;
  inScopeProcessCount: number | null;
  activeManaged: {
    playwrightMcpRoots: ProcessIdentity[];
    playwrightChromeMains: ProcessIdentity[];
    proofshotChromeMains: ProcessIdentity[];
    processes: ProcessIdentity[];
  };
  orphanedManaged: {
    playwrightMcpRoots: ProcessIdentity[];
    playwrightChromeMains: ProcessIdentity[];
    agentBrowserChromeMains: ProcessIdentity[];
    processes: ProcessIdentity[];
  };
  inScopeProcesses: ProcessIdentity[];
  external: {
    mcpRoots: Array<ProcessIdentity & { holder: ProcessIdentity }>;
    processes: ProcessIdentity[];
  };
  ruledOut: {
    unattributedPpid1CrashpadHandlers: ProcessIdentity[];
  };
  errors: string[];
};
```

列表排序，输出稳定；必要的 `lstart` / exact profile identity 放在 detail rows，避免只有 pid 无法审计。`ruledOut` 只接纳 executable basename 精确为 `chrome_crashpad_handler` 且 `ppid=1` 的双重证据，不进入 browser tree denominator，但也不得从输出静默消失。真实 macOS orphan handler 使用 `--monitor-self` / `--monitor-self-annotation=ptype=crashpad-handler`，不能要求只存在于 child handler 的 `--type=crashpad-handler` token；测试 fixture 使用真实 argv 形状锁定此差异。对外字段先由测试锁定，避免 CLI 与 module 漂移。

### B2. RED — pure classifier

新增：`packages/teamlead/src/bridge/__tests__/browser-idle-census.test.ts`

最小 test matrix：

1. 健康空样本：`count=0`、`singleDigit=true`；
2. OS `comm=claude` ancestor 持有的 exact Playwright MCP nested wrappers + descendants：进入 managed，roots 与 union 去重；
3. `Cursor Helper: mcp-process` / IDE ancestor 持有的同形 MCP tree：只有完整链正面证明 holder 时进入 external，不改变 `singleDigit`；
4. exact MCP top root `ppid=1`：进入 `orphanedManaged`，其 descendants 计入 in-scope union；
5. managed MCP 下的 `ms-playwright-mcp/mcp-<token>` Chrome main + renderer/GPU descendants：active managed；同 profile main `ppid=1`：`orphanedManaged`；其它缺 ancestry：unknown；
6. `agent-browser-chrome-<owner>` main：`parseChromeProc()` 返回 Flywheel `execId` 时 active managed；exact profile 无 execId 时 `orphanedManaged`，整棵系统 TMPDIR tree 仍计入 union；
7. founder 普通 Chrome：完全排除；
8. 任一 sweep sensor unknown：`count=null`、`singleDigit=null`、错误保留；
9. in-scope active + orphaned union 为 9：true；为 10：false；
10. 重叠 MCP/Chrome descendants：union 不双计数；
11. classifier `match + unknown` 混合、candidate-relevant incomplete join、非 orphan 的 ancestor chain 缺失/循环：整体 fail closed，而不是让 `has_match` 遮蔽 unknown；
12. external 数量达到或超过 10：仍披露，但不改变 in-scope `singleDigit`；
13. `splitMcpPsCommand(command)` 与既有 `parseMcpPsProcessRow()` 对同一 whitespace-safe command 生成逐项相等 argv；census 不自写 splitter；
14. `startedAtEpochMs = observedAtEpochMs - ageMs`，不解析无 timezone 的 `lstart`；用 apply epoch 前/后/boundary fixture 锁住分桶。

先运行该 test file，确认 module missing 或断言失败。

### B3. GREEN — collection adapter

- 从单一 `ChromeSweepSample` 的 comm/command/age maps 重建 classifier input；将 `mcp-descendant-reaper.ts` 现有 private `splitPsCommand` 改名并 export 为 `splitMcpPsCommand`，原模块和 census 共用；exact MCP roots 来自现有逐行 classifier，不使用 `classifyMcpSnapshot().overall`，也不自写 splitter/substr 匹配；
- ancestor ownership 从 MCP top root 向 `ppid` 走完整链；精确 `comm=claude` 是 active managed，完整 non-Claude holder 是 external，top root `ppid=1` 是 orphanedManaged，其它缺行/循环 unknown；
- Chrome main 必须 `isChromeFamilyComm()`、无 `--type=`，且 user-data-dir 匹配 exact 受管 profile；
- 通过 sample 内 `pid/ppid` 构建 descendant closure；
- 用 `Set<number>` 做 union；
- 任一 sensor 非 `ok` 或识别结果 `unknown` 即整体 unknown；
- `collectBrowserIdleCensus()` 只调用 `collectChromeSweepSample()` 一次，注入 clock/profile roots 便于测试；用同一 injected `nowMs` 与 age sensor 的 `ageMs` 产生绝对 `startedAtEpochMs`，`lstart` 只保留为 exact identity/audit 字段。

若现有 helpers 不足，只做向后兼容的 export/type 扩展，不另跑一组 `ps`。三 pass 是 sweep 而非 atomic snapshot；只对 candidate-relevant PID 做 join fail-close，不能用全系统 PID set mismatch 毒化读数。

### B4. RED/GREEN — CLI contract

新增：`scripts/fly-2026-browser-idle-census.mjs` 与 `scripts/__tests__/fly-2026-browser-idle-census.test.sh`。

- 只接受与既有 FLY-1867 工具一致的 `--once --print`，输出一行 JSON；`status=unknown` 或 `singleDigit!=true` 用非零退出码；operator 用 shell redirect 保存带时间戳证据，CLI 本身不写生产文件；
- 导入新鲜 `packages/teamlead/dist`，dirty/stale 时 fail closed；
- shell test 覆盖参数错误、stale guard 与 read-only mode，纯分类细节由 vitest 负责。

shell harness 不读取真实进程表；它导入 CLI 的 pure argument/freshness helpers 测 contract。生产 main 永远走真实 sweep，不增加 test-only production flag。

### B5. REFACTOR / verify

运行 TeamLead targeted tests、shell harness、build 后的真实 CLI。当前 sandbox 预期可能诚实返回 `unknown`；这不是代码失败，测试通过与宿主验收分开记录。

## 5. Slice C — cutover 与真实路径合同

新增：`engineering/doc/FLY-2026-browser-on-demand/runbook.md`，同样带 issue/date/based-on header。只编排现有命令，不实现新 writer：

1. preflight：settings `check`、fresh build、idle census、记录活 session；显式审计 `FLYWHEEL_RUNNER_SLIM_MCP` 不为 `0`、`projects.json` 的 `leads[].playwrightMcp` allowlist 与 QA/label positive opt-in；
2. apply：`setup-mcp-on-demand.sh apply ~/.claude/settings.json`，保存已有 receipt/backup；
3. backlog disclosure：把 writer receipt 的 UTC `appliedAt` 解析为 `applyEpochMs`；只和 census 的 `startedAtEpochMs` 比较，绝不直接比较本地无 timezone 的 `lstart`。`startedAtEpochMs < applyEpochMs-5000` 是 pre-apply active/orphan backlog，`> applyEpochMs+5000` 是 post-apply，±5 秒边界必须重采/人工核，不能静默归 backlog；Cursor/IDE positive external 单列；
4. comparator positive control：apply 至少 10 秒后起一个 QA positive-opt-in session，其 MCP root 必须被 census 标为 post-apply active managed；关闭后再起 fresh ordinary Claude session，必须没有 post-apply MCP root。这样时间比较与 policy 同时可证伪；
5. convergence 与 orphan drain authority：不重启 Bridge；Lead 等 FLY-1959 的 00:00/12:00 班车，长跑 Runner 等自然 terminal，founder Terminal 只在本人协调后重开。active backlog 等 session 收敛；orphan 没有 session 可等，必须分型：只有 boot-time `ppid=1` unattributed Chrome main 才可能在 founder 单次批准后用既有 `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1` seam（该 seam 不持久启用）；挂在 `agent-browser` daemon 下的 main 与 daemon 自身不受该 seam 覆盖，记录 exact pid/lstart/comm/profile/tree 后升级 founder 批准的一次性人工处置。本 node 只披露、不 kill、不 restart。直到 pre-apply active/orphan backlog 清零前不进入稳态验收；
6. steady-state：backlog 清零且无 browser work 后，间隔 60 秒采两份 census，两份都 `status=ok && singleDigit=true`；`orphanedManaged` 已计入该数字；
7. QA browser：启动 opt-in session；tool 前 server/Chrome absence，首 tool 后出现；真实 navigation/screenshot 成功；close/teardown 后 census 回落；
8. ProofShot：真实 capture 成功；stop 后回落；另由自动 test 覆盖 capture failure cleanup；
9. CiC：extension 连接、真实 tab/query 成功，确认没有新 Playwright managed profile；
10. desktop：runbook 内嵌 FLY-1867 已验证的 CoreGraphics JXA；目标受管 Chrome on-screen layer-0 窗口 0，founder 普通 Chrome 阳性对照 >0；
11. failure response：pre-apply active/orphan backlog 未清只暂停验收并走上一步的 founder-gated drain/escalation；positive non-Claude external 只披露；任何 post-apply orphan 先 hard-fail/pause，因为 `ppid=1` 已丢失原 owner。只有 step 4 的 fresh ordinary Claude control 同时复现 post-apply MCP，或另有 Claude provenance，才判 policy/teardown 失败并 rollback；否则按来源未知 orphan 升级，不回滚正确 policy。post-apply agent-browser orphan 表示 ProofShot cleanup hard failure，停止验收并修 cleanup（writer rollback 不能修 agent-browser）；sandbox census unknown 只换 host-authorized QA 重采。所有 orphanedManaged 都计入 `<10`，不存在“满地泄漏仍 singleDigit=true”。

runbook 明确标记 operator authority 和 evidence 文件名，避免 implement runner 越权执行。

## 6. 文件清单

预计修改：

- `packages/flywheel-comm/src/commands/visual-capture.ts`
- `packages/flywheel-comm/src/__tests__/visual-capture.test.ts`
- `packages/teamlead/src/bridge/browser-idle-census.ts`
- `packages/teamlead/src/bridge/__tests__/browser-idle-census.test.ts`
- `packages/teamlead/src/bridge/mcp-descendant-reaper.ts`（只 export 共用 argv splitter）
- 必要时 `packages/teamlead/src/bridge/index.ts` 或 package export seam
- `scripts/fly-2026-browser-idle-census.mjs`
- `scripts/__tests__/fly-2026-browser-idle-census.test.sh`
- `.github/workflows/ci.yml`（字面登记新 shell suite）
- `scripts/__tests__/ci-structure.test.sh`（精确 shard inventory/order）
- 本文件夹 `exploration.md`、`research.md`、`plan.md`、`runbook.md`、`progress.md`

不预计修改 `setup-mcp-on-demand.sh`、runner profile 或现有 reaper；若测试暴露确切缺口，先回到 plan/review 再扩 scope。

## 7. 验证顺序

### Targeted RED/GREEN

1. flywheel-comm `visual-capture.test.ts`；
2. TeamLead `browser-idle-census.test.ts`；
3. 新 shell harness；
4. `ci-shell-suite-enumeration.test.sh` 与 `ci-structure.test.sh`；
5. 相关现有 reaper/profile/publish-report regression tests。

### Package / full repo

按仓库合同执行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/fly-2026-browser-idle-census.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-structure.test.sh
```

若 full test 对生产 self-host host 有资源风险，降低 test worker concurrency，但不跳过合同；记录任何与本 change 无关的既有失败及复现命令。

### Review / delivery

1. 自审 diff、inbox、git status；
2. `stage set code_review`；
3. 新建 `review_code` gate + `request-review --type code`，循环到 APPROVED；
4. commit/push，开 base=`main` PR；
5. PR last commit 只处理文档里程碑/归档（本 doc-flow 无 status directory，不做无意义 `git mv`）；
6. `complete --route needs_review --pr <number>`，不 request ship、不 merge。

## 8. 风险、观察与回滚

| 风险 | 预防 | 回滚/处理 |
|---|---|---|
| census 把 Cursor/IDE shape 误叫 managed | exact classifier + positive ancestor ownership + Cursor 负例 | external 分桶；不触发 rollback |
| census 把失去 owner evidence 的真孤儿误叫 external | `orphanedManaged` 第三态 + ppid1/system-TMP RED | 计入 in-scope `<10`；按 pre/post-apply 来源处置 |
| process probe 权限不足导致假零 | unknown fail closed | 换 host-authorized QA 重采 |
| cleanup 错误覆盖 screenshot 根因 | cleanup warning + 原始错误照旧抛出 | 测试锁定 |
| stop 被调用两次 | attempted-before-call state | 测试 normal stop failure |
| cutover 破坏 QA browser | apply 前后 profile contract + 真实 QA path | writer rollback |
| visible Chrome 盖桌面 | headless policy + CoreGraphics target/positive-control | rollback policy，保留证据诊断 |
| 存量 session 仍有旧 policy | apply epoch/startedAtEpochMs 分桶 + 等班车/自然 terminal | 不强杀、不 rollback，清零后重采 |

## 9. 会过期的结论

| 结论 | 触发器 | 重查 |
|---|---|---|
| upstream Chrome first-tool lazy | `@playwright/mcp` 升级 | 重新审 bundle 并跑真实 tool 前后 census |
| exact process shapes/profile markers | reaper/classifier/ProofShot 升级 | 运行 fixture tests + host sample |
| settings 当前 drift | 任意 apply/rollback | writer `check` |
| 空闲个位数 | 每次部署/session churn | 两份新的、间隔 60 秒 census |
| GUI 无可见受管窗口 | Chrome/headless/OS 升级 | 重跑 CoreGraphics target + positive control |

## 10. 交付判据

- design review 与 code review 均 APPROVED；
- 两个新公共 seam 均先 RED 后 GREEN；
- targeted/full gates 通过；
- runbook 不含越权 restart/merge；
- PR 清晰标注：代码已具备，production cutover/GUI evidence 由后续 QA/operator 在有权限边界执行；
- runner 以 `needs_review` 完成本 bounded node。
