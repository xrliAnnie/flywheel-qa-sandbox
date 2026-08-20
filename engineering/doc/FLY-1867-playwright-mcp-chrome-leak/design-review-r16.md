# Design Review — plan.md (Round 16)

Date: 2026-08-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 16 正确接受了 Round 15 的六项 findings 和四个删除方向；`6689dea` 是当前 HEAD，权威 plan 相对 `d147e58` 为 99 行新增、62 行删除。P0 的既有 lifecycle `authorityCheck` 已恢复，census 有 health/coverage schema 与 capability isolation，P3 有 post-rename `lsof` 和受检删除入口，classifier 的真实规则收为四形，P1 验收与 writer 表面也已收口。被 R15 裁掉的 supervisor、managed plugin、activation barrier、Chrome shim、content hash 与自动 drain 均无需恢复。

但本轮仍有一个 HIGH：P3 在 post-rename 命中后执行“先看原路径 absent，再普通 rename 回去”。这两个动作之间仍可重建原路径；macOS `rename(2)` 对已存在的同类型目标会先移除目标，非空目录则失败。因此 `race_rolled_back` 分支不是 fail-closed，反而可能覆盖一个刚创建的空 profile 根，且现有 TDD 没覆盖这个 interleaving。最简单的修复是删除自动 rename-back：post-check 命中或不可判时保留 quarantine、记 `operator_required`、停止后续变异并非零退出。

另有两个 MEDIUM：P1 在 whole-file SHA 已分叉且同一个 env key 被第三方改过时仍会无条件写回 receipt preimage；census 把“三张全系统 PID map 的任意不一致”都定义成整行 unknown，独立 `ps` 之间正常的无关进程 churn 也会毒化 measurement，且 cache-version reader 失败没有 status 语义。最后，§10 和 operator drain 仍留有“五形/P0-census-P3 共用 classifier”的旧文字。以上都能通过删分支、加精确三方条件、收紧文字闭合，不需要新增生产架构。

## Verified against code

| claim | verdict | evidence |
|---|---|---|
| `6689dea` 是本轮权威版本，delta 仅需按 plan 审 | VERIFIED | 当前 HEAD 为 `6689deabd805bd680799610674bea822c406a585`；`git diff d147e58..6689dea -- plan.md` 为 99 additions / 62 deletions，`git diff --check` 通过。 |
| Round 15 HIGH-1：P0 lifecycle authority 已恢复 | CLOSED | `plan.md:76,110,138-139,680` 要求每个 TERM/KILL 前 exact identity + classifier + sticky caller authority，throw/false 后零信号；现有 `McpReapDeps.authorityCheck` 在 `mcp-descendant-reaper.ts:137-145,184-204`，`close-runner.ts:673-690` 把 `authorityLostReason()` 接入并让 outer teardown blocked。 |
| P0 的 5/16/2 总预算起点已消歧 | CLOSED | `plan.md:110-115` 明确 dispatch 从初始枚举起表，并包含 fresh snapshot、classifier、authority probe 与全部 TERM；最后一次成功 TERM 后才给 16 秒，confirmation 整批 2 秒。 |
| Round 15 HIGH-2：census 能区分 ok / unknown / 没运行 | MOSTLY CLOSED | `plan.md:277-288,357-376` 已加入 sweep-sample 术语、`status`、sensor errors、30 分钟硬下限、boot/daily heartbeat、14 天 coverage、TERM/KILL 前重读与数字 reopen rule。现有 reaper 确实用三次 `ps`（`chrome-session-reaper.ts:153-267`）并在 primary failure 时直接返回空 result（`:492-508`），所以新模块必须拥有独立 health 语义。剩余 join/version-reader 缺口见 Issue 3。 |
| Round 15 MEDIUM-4：census 在能力层面与信号/告警隔离 | CLOSED | `plan.md:277-287,369-375` 指定独立 `playwright-orphan-census.ts`，入口没有 store/registry/notifier/signal/kill，周期返回只有 summary line，静态守卫钉 imports、签名与 plugin call site。`StateStore.insertEvent()` 当前只 INSERT + save（`StateStore.ts:5584-5611`），修订后的 JSONL 理由与事实一致。 |
| Census 可复用既有 timer 而不改 legacy grace 行为 | VERIFIED | `plugin.ts:7008-7068` 是 boot + periodic 共用的 single-flight timer；env 可接受任意正数（`:7018-7025`）。`plan.md:280,372` 让 census 单独取 `max(30, configured)` 并用测试钉 legacy 仍读原值。 |
| Round 15 MEDIUM-5：classifier 已收成单一 source 与四种形状 | CLOSED IN §3, STALE IN §10 | `plan.md:301-335` 的调用方只有 P0/P3，形状为 npm、npx、`.bin`、canonical `cli.js`，并要求 dist build identity；本机 `.bin/playwright-mcp` 仍是 package-local symlink `../@playwright/mcp/cli.js`，realpath 落在同包，当前版本 0.0.79。可是 `plan.md:649` 仍写“五形状”及 “P0 / census / P3 共用”。 |
| `--once --print` 属于 Chrome census，而非 MCP classifier | CONTRADICTED IN ADJACENT TEXT | `plan.md:278,301-303,347` 已说明 census 复用 Chrome parser/sweep health；但 `plan.md:294` 仍称 `--once` 使用“同一份 classifier”。它可以校验 built-dist freshness，但不应因此重新成为 classifier caller。 |
| Round 15 HIGH-3：post-rename check 能发现 rename 前已打开的 profile | PARTIAL | `plan.md:428-459` 正确承认 quiet/lsof 不是租约，并在 quarantine 路径立即复查；`lsof` 空值语义与现有 `flywheel-log-janitor.sh:795-829` 一致。问题在检测后的普通 rename-back，见 Issue 1。 |
| 普通 macOS rename-back 在目标并发出现时不会覆盖它 | FALSE | 本机 `rename(2)` man page 明确写明：若 `new` 已存在，会先移除；若目标是非空目录则 `ENOTEMPTY`。`RENAME_EXCL` 才保证目标存在时返回 `EEXIST`。`plan.md:431` 只有 absent check + 普通 rename，没有 no-replace 原语，也没定义 rename-back failure。 |
| `--delete-quarantine` 已具备最终 fail-closed preflight | CLOSED | `plan.md:440-450,486` 要求 exact ledger path、canonical root、non-symlink、owner、可解析 ledger、recursive lsof empty；任一失败不删并非零退出。它仍是 operator 明示 one-shot mode，不是 janitor/timer。 |
| mtime 已被诚实降格为 recreated-path 窄门 | CLOSED | `plan.md:390,407` 明确 recursive mkdir 对已存在根不换 inode、nested writes 不保证碰根 mtime；不再把它称为 inode generation fence 的等价替代。 |
| Round 15 deletion candidate：P1 writer 已收成 apply + rollback | PARTIAL | `plan.md:536-549` 删除了独立 remove/restore-exact 入口，并保留 symlink/JSON/mode/atomic defenses；但 divergent SHA 分支没有检查当前 key 是否仍等于 apply postimage，故会覆盖同-key 的第三方修改。 |
| P1 acceptance 与 WebGL QA deliverable 已闭合 | CLOSED | `plan.md:232-249,495-528,649-653` 保持 CoreGraphics target PID=0 windows + founder Chrome positive control + session UA corroboration，并将 stage-0 corpus/metric/product ceiling/split 列成 writer 部署前 QA 交付物；磁盘普查改用 comm + parsed user-data-dir + exact lstart。 |
| R15 scope cut record仍准确 | VERIFIED | `plan.md:659-684` 仍逐项记录被裁六项、保留结论及延迟风险；没有把 P0 lifecycle authority 与已删的 P2 activation authority混为一谈，也没有恢复 machine-wide plugin cutover。 |

## What's Good (Keep)

- 保留整个 R15 scope ruling；本轮任何修复都不需要恢复 supervisor、shim、managed plugin、activation/barrier、content hash 或自动 drain。
- 保留 P0 每个信号前的三项合取、sticky authority loss、三态 probe、`pid+lstart+command`、23 秒整批预算与 `confirmedGone`。
- 保留独立、consumer-free 的 JSONL census module；不得授予 store/notifier/signal/kill capability，也不得返回可喂给 kill loop 的候选集。
- 保留每日 coverage heartbeat、`status=unknown`、effective grace 下限、current cache versions 的诚实命名以及数字 reopen rule。
- 保留 P3 human-reviewed manifest、quiet gate、pre/post-rename recursive lsof、默认只 quarantine、受检的显式 delete mode；不要挂 janitor。
- 保留 P1 CoreGraphics capability gate、三类会话覆盖、WebGL preregistration 与 receipt-aware writer；不碰官方 playwright plugin identity 或 `--isolated`。
- 保留 classifier 的 npm/npx/`.bin`/canonical cli.js 四形、真实 symlink fixture 和 P3 built-dist freshness gate。

## Issues & Recommendations

1. **HIGH — `race_rolled_back` 的“先检查 absent，再普通 rename”仍会覆盖并发创建的原路径。**

   **Issue:** `plan.md:428-432` 在 post-rename `lsof` 命中/错误后，先读取 original path 是否 absent，再普通 rename 回去。新 MCP 可以在这两个动作之间创建原始 profile 根。macOS `rename()` 对已存在的同类型目标会先移除；目标目录若已有内容则以 `ENOTEMPTY` 失败。TDD 6b 只测“始终 absent”，6c 只测“检查时已经存在”，都没测“检查后、rename 前出现”。

   **Why it matters:** 这个补救分支本身成为新的 TOCTOU mutation：它可能移除刚创建的空目录，干扰正在启动的 Chrome；或者 rename-back 失败而计划没有定义终态/账本。它违背 P3 的 fail-closed 目标，且是 scope cut 后不该留下的额外机制。

   **Concrete fix:** 采用最简单的 fail-closed 路径：post-rename `lsof` 命中或 sensor error 时**不要自动 rename-back**；保留 quarantine 原状，记 `operator_required`，停止处理后续 entries，打印 exact recovery context 并非零退出。operator 在关闭相关进程、确认 original/quarantine exact identities 后再决定恢复。删除 `race_rolled_back` action、summary branch 与 6b 自动恢复测试，改成“命中/unknown → 零后续 mutation、两边内容保留”的测试。不要为了保留自动回滚新增 native `RENAME_EXCL` helper。

2. **MEDIUM — P1 rollback 的 divergent-SHA 分支会覆盖第三方对同一个 key 的修改。**

   **Issue:** `plan.md:544-549` 规定 current SHA != postimage 时直接把 key 写回 receipt preimage。SHA 分叉可能只是新增 hook，也可能是第三方把 `PLAYWRIGHT_MCP_HEADLESS` 改成另一个值；后一种情况下该规则会 clobber 新决策。列出的“该 key 被第三方改值后再 rollback”测试没有写 pass/fail 预期。

   **Why it matters:** writer 的存在就是防止全局 settings 被无意覆盖。把 clobber 从 whole file 缩到一个 policy key 仍是 clobber，尤其该 key 正是舰队 headless 策略边界。

   **Concrete fix:** 把 divergent-SHA rollback 写成三方条件：current key 仍等于 apply 写入值 → 仅恢复 receipt preimage；current key 已等于 preimage → no-op；current key 为第三值/类型不符 → `rollback_conflict`、零写入、非零退出。重复 apply 的 no-op 不得覆盖第一次 mutation 的 receipt；测试明确钉这四种终态。

3. **MEDIUM — Census 的 join/版本健康规则过宽又不完整，可能让 audit 尺子长期 unknown 或把缺版本证据算 ok。**

   **Issue:** `plan.md:283,371` 把“三张 map 按 PID 拼不一致”整体写成 unknown，但三次 `ps` 是全系统独立采样；任意无关短命进程在 pass 间出现/消失都可能造成 set mismatch。相反，`mcp_cache_versions[]` reader 失败没有被纳入 unknown，尽管版本上下文是解释 `ppid==1` 读数所需证据。本轮沙箱实际执行全系统 `ps` 返回 EPERM，因此没有把运行探针当成通过证据；源码已足以证明三次采样不原子。

   **Why it matters:** 全局 join 规则会让正常 churn 毒化 daily coverage；版本读取失败仍记 ok 又会让 14 天 coverage 看似成立但读数不可解释。两者都削弱 scope cut 的“由数据决定”承诺。

   **Concrete fix:** 定义 candidate-relevant join：任一整批 sensor 失败仍整行 unknown；但只在 Chrome-family row 或 parsed user-data-dir 落入目标 root 的 plausible candidate 缺 comm/cmd/age/lstart 时 unknown，无关 PID 的跨 pass churn 忽略。cache-version reader error 也置 unknown（或增加独立 `version_status`，且 reopen coverage 只计 version known 的 ok rows）。新增两个非空测试：无关 PID 在 pass 间消失仍 ok；目标 Chrome 的任一必需字段缺失或 version reader error → unknown。

4. **LOW — 四项删除候选在主契约里成立，但 operator/§10 仍有旧的 classifier 说法。**

   **Issue:** `plan.md:294` 称 Chrome census `--once` 使用“同一份 classifier”；`plan.md:649` 仍写“结构化五形状”及 “P0 / census / P3 共用”。这与 `plan.md:269,301-335` 的四形、P0/P3-only 契约直接冲突。交付物 4 也只写“改既有模块”，未体现独立 census module。

   **Why it matters:** 实施者按 §10 建任务时可能重新把 census 耦合到 MCP classifier，恰好撤销本轮接受的两个删除候选和 capability isolation。即使详细章节更正确，计划不能给两个实现答案。

   **Concrete fix:** `plan.md:294` 改为“同一 Chrome census parser/sweep-health entry”；§10 row 2 改成“四形、P0/P3 共用”，row 4 改成“新独立 module + 既有 mount/sampling seam 的最小 wiring + read-only `.mjs` presentation entry”。`--once` 若从 built dist import census module，freshness gate可保留，但不要把它列为 classifier caller。

## Deletion candidates

1. 删除 P3 自动 `race_rolled_back` 分支及其 action/summary/tests；post-check 异常统一收成 `operator_required + stop + nonzero`，机制更少且更 fail-closed。
2. 删除 `plan.md:294,649` 残留的 census-classifier、五形状、三 caller 文字；这是已接受 deletion candidates 的漏网旧文，不是重开设计。

除此之外没有新的删除建议。`--delete-quarantine` preflight、daily heartbeat、census health schema、P3 dist freshness、P1 WebGL QA 和 receipt-aware rollback 都在关闭真实洞，不应为了追求行数继续删。R15 已裁掉的六项仍全部保持删除；本轮 findings 不依赖其中任何一项。

## Verdict

CHANGES REQUESTED — address items above
