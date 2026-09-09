# Design Review — plan.md (Round 2)
Date: 2026-09-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 对 Round 1 的核心方向做了实质修正：`undetermined` 不再永久静默，登记表不再承载 SQL，git 拓扑已补齐，W-4 改成有明确 Phase B 收口的两阶段协议，CI、退役顺序、状态发布窗口和 hermetic QA 也明显更扎实。这些修改值得保留。

但当前仍有两个会直接产生“绿灯假象”的 BLOCKER：Phase B 的 W-4 外层行并未按声明的完整合同 fail-closed；receipt reader 也没有校验 producer 自己声明的关键字段和 `run_status` 派生不变量。另有几个高风险缺口集中在 schema 3 上线门槛、`not_started` 的可重置宽限和双 episode 状态机的失败/损坏语义。它们都可以通过收紧现有合同与测试解决，不需要增加新服务或新环境变量。

## What's Good (Keep)

- 保留双账设计：`incident` 与 `unobservable` 分离、连续两轮不可判定才进入、可判定只恢复 `unobservable` 且不清 `incident`，正确闭合了 Round 1 的静默分支。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:57-74`。
- 保留固定 sqlite 查询形状。`<path>::<table>::<column>`、严格 identifier、脚本内生成单句并用 `sqlite3 -readonly -batch -noheader -bail`，已经移除了登记表任意 SQL 的攻击面。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:30-31`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:131-138`。
- 保留完整 git 拓扑划分。equal、remote-ahead、local-ahead、diverged 已互斥覆盖；diverged 继续用最早 local-only commit 年龄是一个可接受且已诚实披露的产品判断。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:45-53`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:198`。
- 保留两 PR rollout。Phase A 先扩 consumer、Phase B 再让 producer 发 schema 3，并把 C8 放进 DoD，方向上解决了两个部署顺序的兼容问题。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:90-97`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:159-161`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:220-225`。
- 保留 `run_id` + receipt commit marker 和显式崩溃窗口。部分 TSV 行可由 `run_id` 识别，只有完成整轮才推进 receipt，边界比 v1 清楚得多。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:76-88`。
- 保留 Linux-safe 的独立 W-4 consumer suite。现有完整 probe suite 确实列在 manual-only inventory，而 v2 新建 required-lane suite、CI 三命令和命令集断言是正确切法。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:120-125`、`scripts/__tests__/ci-shell-suite-manual-only.txt:19-21`、`scripts/__tests__/ci-structure.test.sh:932-953`。
- 保留退役顺序和零新增 `FLYWHEEL_*` knob。先在 `copy` authority 仍存在时 audited retire，再改 `hold`，与工具当前的 mutation fence 一致；state-root 也对齐了现有 `.trim() || default` 约定。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:178-182`、`scripts/lead-memory/retire-units.sh:33-40`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:16`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:34-36`、`packages/teamlead/src/bridge/plugin.ts:5294-5301`。

## Issues & Recommendations

1. **BLOCKER — Phase B 的“W-4 必有”仍只是键存在，不是完整行合同。**

   **Issue:** 计划声明 W-4 有 `class / wired / effective_enabled / switch / observation / receipt_path / last_run_at / freshness / run_status`，但 Phase A 的 `truth.ts` 只要求 `wired===true`、`effective_enabled` 为 boolean、`observation` 和两个 enum；probe 在 schema 3 下更只校验 `wired / freshness / run_status`。`class`、`switch`、`receipt_path`、`last_run_at` 未进入接收端合同，`effective_enabled=false` 也会通过 truth validator；`fresh + unknown` 这样的非法组合同样会被当作健康。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:40-41`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:92-95`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:148-154`。

   **Why:** schema 3 的目的就是把 W-4 从“可选附加键”提升为不可伪造的必有观察行。按当前谓词，一个退化成 `{wired:true,freshness:"fresh",run_status:"ok"}` 的 schema 3 W-4 会被 probe 接受，重新形成“看起来接上了、实际没有 receipt observation”的形状 A。仓内已有 W-1 先例会同时锁 `switch`、`effective_enabled===true` 和 freshness，而不是只验存在性。证据：`packages/config/src/feature-flags/truth.ts:1095-1119`。

   **Suggested fix:** 在 plan 中写出并复用一份完整 W-4 predicate，TS validator 与 shell probe 逐字段等价：`class=="W-4"`、`wired==true`、`effective_enabled==true`、`switch=="required/no_switch"`、`observation=="receipt_file"`、`receipt_path` 为非空字符串、`freshness/run_status` 为闭集、`last_run_at` 类型合法，并校验组合关系：`not_started|invalid => unknown + null`，`fresh|stale => ok|degraded + 非空严格 UTC 时间`。schema 3 缺任一字段或组合非法都必须进入 degraded。新 required-lane suite 和 `flag-truth` 测试应逐字段删除/篡改，而不只测坏 freshness。

2. **BLOCKER — receipt reader 没有验证自身 schema 的全部字段，也没有重算 `run_status`。**

   **Issue:** producer 合同包含 `run_id`、`rows`、`unobservable_active`，并规定 `run_status=degraded` 当且仅当 `unobservable_active>0 || post_status==failed`；reader 的拒绝清单却没有要求/校验 `run_id`、`rows` 的整数类型、`unobservable_active`，也没有校验派生不变量，而是对合法 enum 的 `run_status` 直接照抄。时间规则也只写了格式与未来上限，没有要求 `Date.parse` 有限且 round-trip 后仍等于原 UTC 秒串。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:78-80`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:99-105`。

   **Why:** 一个当前时间、64-hex hash、counts 合计正确，但 `post_status:"failed", run_status:"ok"` 的 receipt 按现有拒绝清单可返回 `fresh/ok`；probe 只对 `run_status=degraded` 报警。它会把“告警投递已经失败”重新显示成健康，正中本 issue 要消灭的 failure shape A。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:41`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:103-104`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:217`。

   **Suggested fix:** reader 必须校验 schema 1 的每个 required field：`run_id` 精确格式；`rows`、所有 count、`unobservable_active` 为 non-negative safe integer；counts 恰有五个键且合计等于 rows；`0 <= unobservable_active <= rows`；UTC 时间可解析并 round-trip；最后从 `unobservable_active` 和 `post_status` 重算 expected `run_status`，不一致即 `invalid`（或根本不信任 receipt 中的派生值）。加入上述 `failed + ok`、`unobservable_active>0 + ok`、缺 `run_id`、缺/字符串 rows、非法日历日期的反例。

3. **HIGH — schema 3 的 `not_started` 宽限绑定 Bridge uptime，可被 Bridge 重启无限重置。**

   **Issue:** W-4 的 receipt 属于外部 watcher 且跨 Bridge 重启持久存在，但计划只有在 `not_started` 且 Bridge uptime 超过 10800 秒时才判不健康。Bridge 启动时间来自每次进程启动时的 `Date.now()`，manifest 与 `/health` 都使用本次进程的 boot/uptime。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:36`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:41`、`packages/teamlead/src/bridge/plugin.ts:4841`、`packages/teamlead/src/bridge/plugin.ts:5871-5877`、`packages/teamlead/src/bridge/plugin.ts:2239-2245`。

   **Why:** receipt 不存在时，只要 Bridge 在每个 3 小时窗口内重启，W-4 可永久保持“宽限内”，即使 watcher 从未产出任何东西。W-1 可以用 Bridge uptime，因为 W-1 owner 本来就在 Bridge 内；W-4 是进程外产物，生命周期不同。

   **Suggested fix:** Phase A 的 schema 2 可以保留 rollout grace；Phase B 的 schema 3 已有 Phase A 24h 前置证据，因此 `not_started` 应立即成为 unhealthy reason，再沿用现有 degraded grace + consecutive-3 滞回即可。若一定要保留 3h，则把 first-seen-not-started 持久化到 probe state，不能从 Bridge uptime 推导。增加“schema 3、receipt missing、Bridge 每轮 uptime 都很小”仍最终报警的序列测试。

4. **HIGH — Phase A 结束条件不能证明生产 probe 已具备 schema 3 接收能力。**

   **Issue:** gate 只看 probe 状态文件“schema 不变、无 degraded”。当前 probe 无论新旧都写 `schemaVersion:4`，当前旧 consumer 又只接受 manifest schema 1/2；在 Phase A 中 Bridge 仍发 schema 2，旧 probe 会忽略额外 W-4 并保持无 degraded，所以这两个观测都可能在旧 probe 仍运行时通过。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:90-97`、`scripts/bridge-liveness-probe.sh:106-120`、`scripts/bridge-liveness-probe.sh:125-155`。

   **Why:** 如果以这个 gate 开 Phase B，Bridge 一升 schema 3，旧 probe 会把健康 manifest 判成缺失/不完整并页 founder；这正是拆两 PR 原本要消除的反向部署窗口。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:97`、`scripts/bridge-liveness-probe.sh:134-155`。

   **Suggested fix:** Phase A post-deploy evidence 必须包含一个只有新 consumer 才能通过的正/负对照：source 主 checkout 的实际 probe，喂 synthetic `schema_version:3 + 完整 W-4` 必须 true，删 W-4 必须 false；同时记录主 checkout exact HEAD/脚本 sha，并证明该文件在至少一次 60s probe cadence 前已部署。把这项设为 C8 PR 可创建/部署的硬门槛，而不是仅看旧状态文件。

5. **HIGH — 双 episode 的损坏状态与投递失败转移仍未闭集。**

   **Issue:** 严格 reader 允许 `active=true,lastNotifiedAt=null`，但 renotify 分支要求对 `lastNotifiedAt` 做 24h 比较；它也未定义 `active` 与 timestamp、`unobservable.active` 与 `streak` 的一致性。转移表只说 unobservable enter/recover 成功时如何写，没有说明 enter 失败是否仍持久化已递增 streak、recover 失败是否完整保留 active/streak；C3 也只列 incident 的 enter/recover failure 用例，没有对应的 unobservable failure 用例。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:59-70`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:140-142`。

   **Why:** 这是 Round 1 BLOCKER 的核心新状态机。允许半合法状态或让一次 Discord 失败丢掉 streak，都会造成崩溃、错误重提或重新静默；“严格 shape/no-clobber”不能只验基础类型。

   **Suggested fix:** 写明状态不变量并 fail-closed：`active iff lastNotifiedAt != null`；`unobservable.active => streak >= 2`；每个已存在 artifact entry 必须恰有两本账（新 artifact 整体缺失才初始化）。写明失败转移：enter 失败仍保存递增后的 streak、保持 false/null，下轮重试；renotify 失败原样；recover 失败保持 active/timestamp/streak 原样。为 unobservable enter failure、recover failure 和三种语义非法 state 各加测试。

6. **MEDIUM — `sync-common.sh` 的 source guard 只防 PID lock，没有防 writer lock 被清空。**

   **Issue:** C1 只检查 `LM_PID_LOCK_PATH`。但被 source 的库还会无条件把 `LM_WRITER_LOCK_HELD/BACKEND/PATH` 重置；writer lock 实际用保留 FD 8 持有，并依赖这些变量释放。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:24`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:131-134`、`scripts/lead-memory/lib/sync-common.sh:16-20`、`scripts/lead-memory/lib/sync-common.sh:294-358`。

   **Why:** 在已持 writer lock 的 shell 中 source watcher 会遗忘锁 ownership，随后 `lm_writer_lock_release` 直接返回而 FD 仍开着。生产独立进程通常不触发，但脚本明确提供 source-and-stub seam，R1 要求处理的正是 load-time side effects。

   **Suggested fix:** source 前同时拒绝 `LM_PID_LOCK_PATH` 非空、`LM_WRITER_LOCK_HELD==1` 或 `LM_WRITER_LOCK_PATH` 非空；测试应真实 acquire 一个临时 git repo 的 writer lock、source watcher 返回 6，并证明原变量/FD lock 可正常释放且未被覆盖。

7. **MEDIUM — 可预知的 checks sink 错误检查得太晚，先产生外部副作用再 exit 9。**

   **Issue:** 顺序规定先发帖、写 `state.json`，之后才核对现存 `checks.tsv` 表头。`lm_append_tsv` 自身只在文件不存在时创建 header，并不会验证已有 header。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:76-88`、`scripts/lead-memory/lib/sync-common.sh:57-70`。

   **Why:** 已存在的坏 header 是本轮开始前就能确定的状态错误；当前顺序仍可能先发 incident、推进 episode，再以 9 退出且不发布 receipt。这个窗口不是不可避免的 crash window。

   **Suggested fix:** 在 probe/action/post 之前预检状态目录和三个 sink 的非 symlink/regular-file 条件，并在 `checks.tsv` 已存在时先验 header。保留写入期间真实 IO failure 的 §2.3 窗口即可。把“坏 header”测试收紧为零 post、`state.json` 字节不变、旧 receipt 字节不变。

8. **MEDIUM — 三处测试/QA 文字目前不可同时满足。**

   **Issue:** (a) C2 一边要求 SQL 精确为 `SELECT max("<c>") ...`，一边要求实际 SQL 不出现 `(`，后者必然被 `max(` 自己击中；(b) C1 把 `/etc/passwd` 描述成“含 `$` 非 `$HOME/`”，使“原始绝对路径是否允许”没有唯一语法；(c) 隔离 QA 预计有三条首轮 incident，但 `_af_post` 被调用后的合法结果应是 `success` 或 `failed`，不是 `none`，而 unset credentials 只能证明零网络调用，不能证明 `_af_post` seam 零调用。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:30`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:134`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:138`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:181-192`。

   **Why:** 这些会让 RED/GREEN 或 acceptance 结果取决于实现者猜测，甚至产生必失败断言。

   **Suggested fix:** (a) 断言整句严格等于固定模板，并单独断言 table/column 原始值不含 `(`、`writefile`、`load_extension`；(b) 明确路径必须以字面 `$HOME/` 开头，若是如此就用 `/etc/passwd` 作为“缺少 `$HOME/`”反例，另用 `$TMP/x` 作为非法变量反例；若允许绝对路径则删除前者；(c) 明确 stub 返回 0 时 `post_status=success`，返回 1/unset credentials 时 `_af_post` 调用三次、网络 seam 零次、`post_status=failed`，全 fresh/no-action 才是 `none`。

9. **MEDIUM — `research.md` 仍保留与 v2 和当前仓库相反的旧合同。**

   **Issue:** upstream research 仍写坏 receipt 为 `not_started`、既有完整 probe suite “已在 CI”、回滚先改 `hold` 再 retire；v2 已分别改成 `invalid`、完整 suite manual-only + 新 required suite、先 retire 后 hold。当前 manual-only authority 也明确列出了完整 probe suite。证据：`engineering/doc/FLY-2134-monitor-the-monitors/research.md:94-101`、`engineering/doc/FLY-2134-monitor-the-monitors/research.md:106-116`、`engineering/doc/FLY-2134-monitor-the-monitors/research.md:120-123`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:99-105`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:120-125`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:178-182`、`scripts/__tests__/ci-shell-suite-manual-only.txt:19-21`。

   **Why:** plan 标注“基于 research.md”，实施者或后续 reviewer 按 upstream 追证会得到相反答案；尤其旧退役顺序会被现有 `copy` authority fence 拒绝。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:4`、`scripts/lead-memory/retire-units.sh:33-40`。

   **Suggested fix:** 同步 research §6–§8 到 v2 最终合同，至少修正 invalid/not_started、CI classification、完整 retirement matrix 与 retire-before-hold 顺序；或者在旧段落上明确标记 superseded 并链接 plan 的规范章节。

## Verdict

CHANGES REQUESTED — address items above
