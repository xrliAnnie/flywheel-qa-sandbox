# Design Review — plan.md (Round 1)
Date: 2026-09-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确：独立的产出物登记表、进程外 observer、按 episode 去重，以及 Bridge/probe 的加法式兼容，都是对这次事故形状的直接回应。但当前计划仍有 3 个阻塞问题：`undetermined` 可以永久静默；所谓只读 SQLite 探针允许执行有副作用的任意 `SELECT`；W-4 为兼容旧版本而永久 optional，导致它以后被漏接/删除也永远不会响。另有若干高风险合同未闭合：Git 拓扑、receipt 的完整性与未来时间、CI 实际枚举、退役顺序、配置变量治理、状态损坏与多文件发布窗口。

本轮基于干净 worktree 的 `daf523b148fb8a3269897be9358d87cb3a22b6a2` 实读；没有修改仓库文件。

## What's Good (Keep)

- 保留独立的 artifact registry，不给五列 `units.manifest` 横加语义。现有 parser 明确要求恰好五列并 fail closed，且 `copy`/`hold` 的交付语义已经稳定（`scripts/lib/converge-nonlead-daemons.sh:651-699`；`docs/operations/launchd-units.md:28-47`）。
- 复用 `lm_write_json_atomic`、`lm_append_tsv`、PID 目录锁和 `lm_remote_head` 是可行的；这些 seam 的实际签名与计划一致（`scripts/lead-memory/lib/sync-common.sh:28-92,195-231`）。保留“成功发帖才记通知时间、恢复帖失败不清账”的 episode 语义；既有 arrival observer 正是这样结账（`scripts/lead-memory/arrival-check.sh:226-236,256-305`）。
- 新 plist 走 `copy` + `units.manifest` + 五套 FLY-1814 守卫是正确交付路径；convergence 会先校验/安装缺失 copy，再 bootstrap 未加载单元（`scripts/lib/converge-nonlead-daemons.sh:1000-1076`）。
- W-4 的第一阶段确实双向兼容：旧 probe 的结构检查只读取 W-1/W-2/W-3，不拒绝额外 component（`scripts/bridge-liveness-probe.sh:125-155`）；按计划，新 probe 对旧 Bridge 的 absent W-4 静默。这个 additive rollout 性质应保留，但不能成为永久合同，见问题 3。
- `--status` 只读、登记表整表拒绝、状态 schema 不符不覆盖、发帖失败仍写证据、生产测试全部走 seam 的方向都对。测试矩阵覆盖了阈值边界、锁、episode 恢复和两个部署方向，基础很扎实（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:89-111`）。
- 对同机/同 launchd 域、`ls-remote` 证明边界和首轮三条阳性的披露是诚实的，应原样保留（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:145-153`）。

## Issues & Recommendations

1. **BLOCKER — `undetermined` 永不进账，会把观察能力长期失效重新变成静默故障。**

   - **Issue:** 文件 `stat` 失败、SQLite 损坏/表不存在/永久 busy、Git 网络或认证永久失败都落入 `undetermined`；真值表规定它既不进入也不清理 episode，风险表甚至只要求人工看一次 `--status`（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:47-60,118-123,161-162`）。
   - **Why:** 这不满足“回答不了产出物是否新鲜也必须出声”的本单目标。旧 arrival observer 没有把远端不可达静默丢掉：它有独立的 `remote_unreachable` condition，并把 True 送入 enter/renotify（`scripts/lead-memory/arrival-check.sh:219-236`）。当前计划反而丢了这个关键保护。
   - **Suggested fix:** 给每个 active artifact 增加一个很小的连续不可判定门槛（例如连续 2 轮），然后让 `undetermined` 进入同一本 artifact episode；它仍不得清掉已有 stale/missing episode，只有 `fresh` 才 recover。至少覆盖：一次瞬态不页、连续 Git 认证失败页、SQLite 损坏页、`stat` 永久失败页，以及可判定恢复后的 all-clear。`last-run.json` 也必须把持续 `undetermined` 暴露为非健康，而不只是“observer 刚运行过”。

2. **BLOCKER — `select ` 前缀 + 禁分号并不是只读 SQL 白名单。**

   - **Issue:** registry 接受任何以 `select ` 开头且无 `;` 的 SQL，并以 `sqlite3 -readonly` 执行（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:30,89-91,118-123`）。`-readonly` 只约束数据库打开模式，不约束 SQLite CLI 扩展函数的外部副作用。本机只读核验 `pragma_function_list` 时确认当前 `/usr/bin/sqlite3` 暴露 `writefile`，因此合法行 `select writefile(...)` 仍可写任意文件；查询也可构造昂贵递归或读取不该进入台账/Discord 的内容。
   - **Why:** 这直接否定“三种探针全部只读”和边界 fail-closed 的声明。v1 唯一需求只是对已知表的 `day` 取 max；表/列已在实现中固定存在（`packages/token-usage/src/store/local-sqlite-store.ts:56-77`），没有引入通用 SQL 解释器的必要。
   - **Suggested fix:** 从 manifest 删除 raw SQL。把 target 改为 `<path>::<table>::<column>`，table/column 只接受严格 identifier，并由脚本构造/引用 `SELECT max(...)`；或为 v1 固定一个受审 query id。新增反例至少包含 `writefile()`、`load_extension()`、CTE/递归、多个结果行/列和控制字符；任何一个都必须在启动 sqlite3 前拒表。

3. **BLOCKER — W-4 的双向兼容没有结束条件，永久 optional 会复刻 shape B。**

   - **Issue:** 计划保持 schema 2、`REQUIRED_LIVENESS_ROWS` 不变、W-4 absent 永久静默，TypeScript validator 也明确接受无 W-4（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:38-39,105-111,126`）。这保证了 rollout 两个顺序都不误报，但也意味着 production wiring 若从未接上，或未来回归删除 W-4，probe 永远把它解释成“旧 Bridge”。手工 post-merge 检查只能证明一次上线，不能持续监控这个合同。
   - **Why:** “看者从未安装”只有在 Bridge 自己仍发布 W-4/not_started 时才会被抓；“W-4 本身从未接入/后来消失”无人抓，正是本 issue 要消灭的“假设存在而从未存在”。既有 W-1 用 schema gating 解决过同类 rollout：probe 对 v1 不要求 tracker 字段，但 schema v2 明确要求（`scripts/bridge-liveness-probe.sh:148-176`；`scripts/__tests__/bridge-liveness-probe.test.sh:352-377`）。
   - **Suggested fix:** 把兼容定义成有期限的两阶段合同。Phase A 可保留本计划的任意顺序 additive rollout；验收后 Phase B 由已部署的新 probe 接受旧 schema 2，但要求新 schema 3 必有合法 W-4，Bridge 再切 schema 3。若坚持单阶段，则至少需要一个由旧 probe 忽略、由新 probe 强制的 capability/cutover marker，并在 DoD 中写明何时从 optional 转 required。没有这个收口，不应宣称环能抓 W-4 自身消失。

4. **HIGH — W-4 receipt 只验 `schema` 和可 `Date.parse` 的时间，仍能“坏着报 fresh”。**

   - **Issue:** reader 计划只检查 `schema===1` 和 `observed_at` 可解析，却不验证已声明的 `registry_sha256`、counts、`post_status`、字段类型/枚举或普通文件身份（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:33,105-107`）。未来时间满足 `nowMs - observedAt <= stallMs`，可无限期 fresh；present 但 malformed 的 W-4 因 shell validator 故意不看 W-4，也可能被 reason 函数的 `// "absent"` 语义静默掉。计划还明确规定所有 Discord 投递都失败时 W-4 仍 fresh（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:165`）。
   - **Why:** 这再次以“写出了一个文件/跑过一轮”代替“产出了有效观察并完成应做投递”。`/health` 的 provider 外层虽会 catch throw（`packages/teamlead/src/bridge/plugin.ts:2225-2237`），却不能修复一个被 reader 误判为有效的残缺/未来 receipt。
   - **Suggested fix:** reader fail closed 校验完整 schema：regular non-symlink、严格大小上限、严格 UTC timestamp、不得超出有限 clock-skew、64 位 hex hash、非负整数 counts 且合计等于行数、`post_status` 闭集。时间新鲜度和本轮结果分开暴露，例如 `freshness` + `run_status`; `post_status=failed` 必须让 probe 产生 unhealthy reason。reason 函数要区分“键完全不存在的旧 Bridge”和“键存在但形状/枚举非法”，后者一律 degraded。补 future timestamp、symlink/FIFO/oversize、缺字段、非法 counts/hash/status、present-null/unknown freshness 和发帖失败的测试。

5. **HIGH — `git_remote_head` 对“远端对象已存在但远端领先/历史分叉”没有判词。**

   - **Issue:** 真值表只分“SHA 相等”“远端 SHA 不在本地对象库”“不等时取最早 `remote..HEAD` 提交”（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:49,93-95`）。如果远端 SHA 已在对象库且包含本地 HEAD，`remote..HEAD` 为空；如果两边分叉，它包含 local-only commit，但不能证明这是正常待推队列。两个格子都未定义。
   - **Why:** 直接复用的 `lm_remote_head` 只返回远端 SHA，不做 ancestry 判断（`scripts/lead-memory/lib/sync-common.sh:84-91`）；arrival 的现实现也只在对象存在后直接计算 range（`scripts/lead-memory/arrival-check.sh:115-125`），不能替计划补齐通用 Git 真值表。
   - **Suggested fix:** 明写并测试图关系：equal→fresh；远端对象未知→undetermined；`remote` 是 `HEAD` 祖先→按最早 local-only `%ct`；`HEAD` 是 `remote` 祖先→fresh（远端至少包含本地）或给出另一条明确策略；两者互非祖先→undetermined/incident。新增“先 fetch 后远端领先”和“对象均存在但分叉”夹具，且所有 ancestry/log 调用经过明确的 bounded seam。

6. **HIGH — C6 的核心 receiving-end 测试实际上不在 CI，新 step 只有两条新 watcher suite。**

   - **Issue:** 计划称 `ci-shell-suite-enumeration` 会“自然通过”，并让新 step 只跑两个 artifact freshness 脚本（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:81-83,101-103`）。但 `bridge-liveness-probe.test.sh` 当前明确在 manual-only inventory（`scripts/__tests__/ci-shell-suite-manual-only.txt:19-21`）；enumeration 会把 manual-only 当成已分类而放行（`scripts/__tests__/ci-shell-suite-enumeration.test.sh:15-46`）。所以 W-4 stale/not_started/recovery 的生产接收端可以在 required CI 完全不执行。文件清单中的 `ci-structure.test.ts/.sh` 也不准确；仓内只有 `.sh`，现有 FLY-2146 exact-command 断言就在其中（`scripts/__tests__/ci-structure.test.sh:932-953`）。
   - **Why:** 完成定义声称 C1–C6/CI exact head 全绿，但现有枚举不能证明 C6。并且 `artifactFreshness` 是 optional 入参，builder 单测可继续像现有调用一样省略它而全绿（`packages/teamlead/src/bridge/__tests__/liveness-manifest.test.ts:143-153`）；生产 `plugin.ts` wiring 也缺独立断言。
   - **Suggested fix:** 要么把整个 hermetic probe suite 纳入该 CI job 并从 manual-only 删除，要么拆一个 Linux-safe 的 W-4 receiver suite进 CI。更新现有 real-producer cross-check（`scripts/__tests__/bridge-liveness-probe.test.sh:302-349`）让它用真实 receipt/真实 `buildLivenessManifest` 产出 W-4，并增加 production `plugin.ts` 路径/阈值 wiring 断言。`ci-structure.test.sh` 应锁三条命令及顺序，而不是两条。

7. **HIGH — 回滚顺序与现有 retire authority 冲突，工具文本/审计仍是 FLY-2146 memory-only。**

   - **Issue:** 计划写“先把 manifest 行改 `hold` + 再跑 retire”（至少未规定相反顺序，`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:133`），但 `retire_authority_present` 只接受当前行仍为 `copy`（`scripts/lead-memory/retire-units.sh:33-40`）。一旦 checkout 已是 hold，apply 会在 mutation 前拒绝。runbook 的权威顺序也是先 bootout/archive，最后才删行或改 hold（`docs/operations/launchd-units.md:110-123`）。此外只加 allowlist 会留下 “exact FLY-2146 label required”、`enable-memory-unit`、`retire-memory-unit` 和 “memory unit” 审计标题（`scripts/lead-memory/retire-units.sh:17-31,60-83,124-128,176-190`）。
   - **Why:** 这是实际不可执行的回滚步骤，也会生成误导的强制审计证据。C4 只计划新增 preview 用例，不能证明新 label 的 apply/enable/audit 分支（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:101-103`）。
   - **Suggested fix:** 明确操作序列：在 `copy` authority 和源 plist 仍存在时执行 audited retire；disabled override 阻止 convergence 复活；随后 PR 把行改 hold。或者有意识地泛化工具对 hold-retire 的 authority 状态机。无论哪条，都要把命名/usage/error/audit kind/title 从 FLY-2146 memory-only 泛化，并把第三个 label 跑过正常 apply、resume、audit failure、identity drift、idempotent、enable authority 的同一矩阵，不能只测 preview。

8. **HIGH — 新配置 knob 未进入 flag-truth，且 Bridge 的 state-root fallback 与 shell 不同。**

   - **Issue:** 计划新增 `FLYWHEEL_ARTIFACT_FRESHNESS_STALL_MIN`、`...BOOT_GRACE_MIN`、`...REGISTRY`，但 `truth.ts` 的改动只写了 W-4 shape validator（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:26,38-39,76-83,105-111`）。当前持久环境验证会拒绝所有不在 flag registry/NON_FLAG_ALLOWLIST 的 `FLYWHEEL_*` 名（`packages/config/src/feature-flags/truth.ts:1013-1019`），现有 liveness tuning 也必须逐个登记（`packages/config/src/feature-flags/truth.ts:635-647`）。另外计划用 `FLYWHEEL_STATE_DIR ?? default`；空字符串会变成相对 `state/...`，而 watcher 的 `${VAR:-default}` 会回退，仓内 Bridge 惯例也是 `.trim() || default`（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:33,106`；`packages/teamlead/src/bridge/plugin.ts:5294-5301`）。
   - **Why:** 一旦 operator 真配置这些 tuning，flag-truth 会报 unknown；空/空白 state root 会让 Bridge 和 watcher 读写不同文件，W-4 假 not_started。
   - **Suggested fix:** 优先删掉不必要 knob、固定本单阈值；若保留，全部以 non-flag numeric/test plumbing 明确登记并测试 unknown/zero/negative/NaN/blank。抽一个与现有惯例一致的 `artifactFreshnessStallMs(env)` 和 state-root helper，使用 trim + fallback；对 shell/TS 默认值和 env 名加跨语言合同测试。

9. **MEDIUM — 直接 source `sync-common.sh` 可行，但它不是“无 source 副作用”，预检顺序需修正。**

   - **Issue:** library 不 dispatch main、也不改 shell options，这是可复用的；但 source 时会强制展开 `${HOME:?}`、执行路径解析，并覆盖 `REMOTE_URL`、`MEMORY_PATH`、`LM_*` 以及锁全局（`scripts/lead-memory/lib/sync-common.sh:3-20`）。因此计划中的“预检 sync-common 可 source → exit 6”不能在无 HOME 或 dot 失败后自然实现（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:24,97-99`），也不能在已持有 LM PID lock 后重复 source。
   - **Why:** 失败可能发生在 `af_main` 及其结构化退出码之前；全局重置也会让 source-and-stub 测试产生顺序依赖。
   - **Suggested fix:** 不必抽新库，但在 dot 前显式验证 HOME/普通非 symlink library，guard source 失败为 6，并规定只在脚本初始化、取得任何锁之前 source；新脚本自己的常量在其后赋值。新增缺 HOME、缺/坏 common、重复 source/预持锁保护测试，均要求零状态写、exit 6。

10. **HIGH — `state.json` 只检查 schema 号，多文件发布窗口和旧 ledger header 未定义。**

   - **Issue:** 计划只对 parse failure/schema≠1 no-clobber；没有约束 `episodes` 必须是 object、`active` 必须 boolean、`lastNotifiedAt` 必须 null/非负且不能在未来（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:53-64,97-99,122-124`）。一个 schema 1 但 shape 坏/未来通知时间的文件可以崩溃或永久抑制 renotify。发布顺序又是 state→逐行 append checks→last-run；这些分别是不同文件操作，而复用 helper 只在文件首次创建时写 header、不会验证已有 header（`scripts/lead-memory/lib/sync-common.sh:35-69`）。state 成功后 ledger 失败会提前结账却没有台账/receipt；第 k 行 append 后失败会留下半轮。
   - **Why:** 计划只披露“post 成功后 state 前崩溃会重发”，没有披露/测试其余可发生窗口；“固定表头”和“last-run 代表完整一轮”目前不是 fail-closed 合同。
   - **Suggested fix:** 严格验证完整 state shape，非法/未来字段一律 exit 9 且原字节不变；append 前核对现存 header。明确 `last-run.json` 是整轮 commit marker，给每行同一 `run_id`/observed_at，并注入测试：最后一次 post 后、state 后、checks 第 k 行后、last-run 写失败。文档写明每个窗口下一轮是否重帖、是否补台账，以及 exit 9 对 exit 10 的优先级；无需为了多文件原子性再造事务系统。

11. **MEDIUM — 两个 QA 阴性对照会触碰真实边界。**

   - **Issue:** 阶段一用“假 channel/假 token”直接跑生产脚本，若未覆盖 `_af_post`，仍会向真实 Discord API 发 HTTP；这与“任何测试不得真发 Discord”冲突（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:127,141-143`）。阶段二临时改生产 registry 再改回，又违背同计划“改表要 PR”的 authority 规则（`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:113-114,143`），并给活 checkout 留下 dirty/interruption 窗口。
   - **Why:** 假凭据不等于 hermetic；手工改权威文件也不是可审计、可重放的验收证据。
   - **Suggested fix:** 阶段一 source 脚本并覆盖 `_af_post`，或显式 unset channel/token/token-name 后证明零网络 seam 调用。阶段二复制 registry 到隔离临时文件，只改副本，通过已声明的 registry override 跑 `--status`，记录副本 hash，最后删临时文件并证明 `git status --short` 为空。不要编辑 production authority。

## Verdict

CHANGES REQUESTED — address items above
