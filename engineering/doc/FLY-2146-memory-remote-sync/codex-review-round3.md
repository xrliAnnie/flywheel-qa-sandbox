# Design Review — plan.md (Round 3)

Date: 2026-09-04
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮核对的是 `plan.md` 实际 blob `eb38e9c83066c3ca330ac372abe3566777245a10`。Round 2 的主要修复均已正确进入规范：resolved fetch/push 必须各自等于 canonical、writer 的 `expected_local_sha` 与 fetch-failure 终态已闭合、日志路径改成 launchd 可解释的绝对字面量、证据退出码只有一张真值表、pending 采集与 watcher 状态迁移已拆开、四类 episode 独立、push hook 输出也被私有捕获。这些都应保留。

当前仍不能批准，主要原因是新引入的远端验收面还有两个可假绿路径：报告没有把 observation 限定为 lead-memory/main 的自然 `schedule` run；`--check-visible` 只证明一个当前 blob 存在，不能证明它是前一天的新变化。代码库复核还发现模板文件闭包、watcher 锁/依赖、退役 operator 路径与现有实现不符。它们都可在不改变总体架构的前提下修正。

## What's Good (Keep)

- 保留 `lm_origin_check` 的三条值都必须精确等于 `REMOTE_URL`。这已关闭对称 `insteadOf` 把 push 与最终 `ls-remote` 一起导向错误仓的 R2 BLOCKER。
- 保留常量替换副本作为 hermetic Git transport fixture，且生产脚本无环境变量常量覆盖；这符合 founder 的无开关要求。
- 保留 writer 的唯一 `expected_local_sha` 状态机、fetch 非零禁 rebase/push、exit 7 表达“已到达但远端命令失败”，以及 exit 8 明确跳过 finalizer。
- 保留唯一退出码真值表与 evidence failure 覆盖规则；状态目录不可写归 9、live lock 不写共享文件的边界已自洽。
- 保留 `lm_pending_scan` 纯采集、`apply_first_observed` watcher-only、report 不写 `state.json`，以及 `unfetched` 独立第四 episode。
- 保留 `/tmp` 绝对日志路径及 manifest 测试；现有 `com.flywheel.daily-standup.plist:17-18` 确实采用相同形状。
- 保留“本地 checks.tsv 仅用于运维，不用于 founder acceptance”的降级；把多日权威证据放到 GitHub 服务端 run metadata 是正确方向。GitHub 官方合同也确认 schedule run 的 SHA 是默认分支当时的最新 commit。
- 保留先 disable 再 bootout 的退役顺序；源码核验确认 `converge-nonlead-daemons.sh:1082-1151` 会复活仍在 LaunchAgents 且未 disabled 的 manifestless `com.flywheel.*` plist，计划对此判断正确。

## Issues & Recommendations

1. **BLOCKER — `--remote-observations` 没有把证据绑定到 lead-memory/main 的自然 schedule run，手动 run 或错误仓可以被当成三天权威证据。**

   为什么重要：plan:160 的命令只有 `gh run list --workflow remote-observe.yml --json headSha,createdAt,conclusion --limit N+2`。它没有 `-R xrliAnnie/lead-memory`；从当前 Flywheel checkout 调用时，`gh` 默认解析的是 `xrliAnnie/flywheel`，除非实现者额外猜测要先 `cd ~/.claude/agent-memory`。它也没有过滤 `event=schedule` 或 `headBranch=main`，而同一 workflow 明确开放了 `workflow_dispatch`；手工从其他 ref dispatch 的 run 可进入结果，多个手工 run 还可在 `--limit N+2` 内挤掉自然 run。GitHub CLI 当前原生支持 `--repo`、`--event`、`--branch`，且 JSON 可返回 `event/headBranch/databaseId/url/status`，见 [gh run list 官方手册](https://cli.github.com/manual/gh_run_list)。GitHub 也明确区分 schedule 与 workflow_dispatch 的 ref/SHA 语义，见 [Actions event 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

   建议修复：命令固定显式使用 `-R xrliAnnie/lead-memory --workflow remote-observe.yml --event schedule --branch main`，返回并验证 `event,headBranch,databaseId,url,headSha,createdAt,status,conclusion`；按 UTC 日期窗口取足够分页结果，而不是假设 `N+2` 个 run 覆盖 N 天。ship gate 只接受三个不同 UTC 日的 schedule/main run，并明确要求的 status/conclusion。milestone 贴 run URL/ID，便于直接回到远端复核。测试加入：wrong cwd、manual dispatch、dispatch on non-main、手工 run 挤满 limit、缺一个自然 UTC 日，全部不得计数；workflow 合同测试还应断言 exact one job/one step、无 job-level permission override 与 `github.token`/`secrets` 引用。

2. **BLOCKER — `--check-visible` 可用一个早已在远端的未变化文件连续三天假绿，没有证明“前一天写下的新记忆第二天到达”。**

   为什么重要：plan:161,183 只比较“报告运行时的本地 `git hash-object`”与“最近观察 headSha 下的远端 blob”。反例：选一个几个月前已同步的文件，每天只 `touch` 它使 mtime 落在前一天，内容/hash 和远端一直相同，三个 schedule run 甚至可保持同一个 headSha；当前判据三天都会通过，但 writer 完全可以三天都没推任何新记忆。反过来，文件在观察后又被编辑时，报告运行时重新算出的 hash 也不再代表前一天那版。测试中的“本地 ledger SHA 次日才推”没有覆盖这个更直接的 no-change 假绿。

   建议修复：每个验收日必须绑定一个真实内容转换，而不是只看 mtime。最小合同是：在 day D 的自然 observation 后选择一个 Lead 当天真实新增/修改的 regular non-symlink 文件，冻结 repo-relative path 与 expected blob OID；day D+1 指定那个 schedule run，远端查询必须证明 day-D observation 下该 path 缺失或 blob != expected，且 day-D+1 observation 下 blob == expected。这样“是否出现”仍只由两个远端树回答，本地只提供待验身份。`--check-visible` 应接受/解析明确 run ID 或 UTC 日，不能隐式取“最近一次”；路径必须物理位于 canonical worktree 的合法 Lead 夹并安全 URL-encode。增加 already-present blob、touch-only、同 headSha 连续三日、观察后本地再改四个反例。

3. **HIGH — 新 workflow 并非只需改 `sync-template.sh` 的文件清单；A1 的 first-import 精确闭包会把它排除。**

   为什么重要：plan:14,64,157,232 声称现有 A1 源码唯一修改是 `sync-template.sh` 文件清单 +1。但当前 `first-import.sh` 在 `verify_staged_scope` 与 `verify_committed_scope` 各有一份精确 `required_top` 集合（lines 295-307、343-355），并在 lines 515-522 用显式 `git add` 清单发布顶层文件；三处都只有 `guard.yml`。仅让 sync-template 拷贝 `remote-observe.yml`，first-import 会把它留成 untracked，并仍成功发布一个不含远端观察器的仓。现有 hooks suite 的“exact repository surface”循环（`test-lead-memory-hooks.test.sh:85-95`）也只断言 `guard.yml`，两次 idempotency 本身无法证明新文件真的被复制。

   建议修复：把 `first-import.sh` 的两份 exact set 与显式 add 清单、hooks suite 的 installed-file 断言一起列入变更闭包；更新 first-import 测试，断言 root commit 含两份 workflow。计划中不要再称 A1 源码“唯一只改 sync-template”，除非明确决定 remote-observe 永远只能由已有仓的后续 admin maintenance 发布，并相应把它从 sync-template 的通用 managed surface 中拆开。

4. **HIGH — watcher 新增的 `arrival/lock` 没有陈旧锁恢复合同，一次 crash 可永久关闭看者且每小时都返回 0。**

   为什么重要：writer 锁明确有 pid、`kill -0` 与 stale reclaim；watcher 在 plan:30,133 只说“短锁，活锁退出 0”。若进程在持锁期间被 SIGKILL、机器重启或脚本崩溃而留下目录，后续 run 没有定义如何区分陈旧锁，会持续按 0 跳过、既不写 `checks.tsv` 也不告警。元监控不在本单范围并不能代替本单自己引入的锁生命周期。

   建议修复：给 arrival lock 写出与 writer 同级的 pid/stale/retry-once/trap 合同；活 pid 才静默跳过，死 pid 或无效 owner 必须安全回收。测试 live lock、dead pid、malformed/missing pid、TERM cleanup、SIGKILL 后下一轮恢复。若 launchd 已保证同 label 不重入且 report 不写 state，也可更简单地取消此锁；不要保留一个不可恢复的第二状态机。

5. **HIGH — watcher/report 的只读依赖预检仍不闭合，缺失 bounded runner 会被误判成远端故障并可能发真告警。**

   为什么重要：C1 的 `lm_remote_head` 与所有 gh 调用要求 `scripts/lib/bounded-run.sh`；`lm_pending_scan`/状态处理还可能需要 Python，Discord seam 沿用 liveness 模式时需要 curl。writer 通过 `lm_deps_check` 覆盖这些，但 plan:133 的 watcher 预检只列 `jq gh git`，又明确不需要 gitleaks，因此不能直接调用当前这个包含 hooks/gitleaks 的全量 checker。bounded-run 缺失时，watcher可能把本机安装损坏记成 `remote_unreachable` 并走真实 `_arrival_post`，而不是 preflight 6 的零台账零发帖。report 同样承诺所有 gh 命令 bounded，却没有列依赖前置条件。

   建议修复：拆出无 gitleaks 的 `lm_read_deps_check`，至少校验 git/gh/jq、实际 parser 所需的 python3、bounded-run regular executable，以及 posting 实现所需 curl；watcher preflight 调它，失败 6 且不发帖。report 也在任何本地/远端读取前做对应 read-only dependency check并固定非零退出。补“bounded-run 缺失不得产生 remote_unreachable 帖”、python/curl 缺失和 wrong gh repo 三类测试。

6. **HIGH — “走既有 operator 路径删除 plist”在当前代码库没有可调用实现，退役测试只证明问题、没有证明四步操作可执行。**

   为什么重要：plan:172 未命名实际命令。源码中的 `fly1814-cleanup-zombie.sh` 明确硬编码只处理 `com.xiaohongshu-deep-learning.qa528`（lines 2-4,13,40-48）；`fly1814-enable-aux-job.sh` 也只允许八个固定 auxiliary label（lines 22-26），而 `flywheel-daemon.sh uninstall` 属于 `com.flywheel.lead.*` 家族。`fly1814-operator-tools.sh` 是可复用函数库，不是能删除本单两个 plist 的 operator command。计划新增的 retire test 只 seam converge，不能让 README 中的第 ③ 步成为真实、安全、可恢复的路径。

   建议修复：要么指出并测试一个确实接受这两个精确 label 的现有命令；要么把一个最小的 dedicated retirement command 纳入文件清单，复用 FLY-1814 的 TTY/audit/identity/re-probe/archive模式，先 disable，证明 unloaded 后将精确 plist 可恢复地 archive，而不是裸删除。测试正常、已 absent、disable/bootout/archive 各步失败、identity drift、重复执行与重新 enable；converge seam 测试继续保留作为必要反例。

7. **MEDIUM — “唯一退出码真值表”仍漏掉 signal/foreign-staged 两条已设计的终态。**

   为什么重要：plan:105 把并发产生的 `foreign-staged` “按 8 停”，但 §2.1 对 8 的唯一描述是 rebase abort/restore failure。plan:130 又保留 add 后 TERM 的 `interrupted-staged` 测试，却没有定义 INT/TERM 的 business code、是否写 runs、evidence 失败是否仍覆盖为 9、是否运行 finalizer；此时 `expected_local_sha` 甚至可能尚未冻结。实现者会在 8、130/143 或原业务码之间自行选择，manifest/census 结果也随之不同。

   建议修复：扩展真值表，明确 8 是广义“仓状态/所有权无法安全恢复”还是只限 rebase；为 clean interrupt、owned staged cleanup success、foreign staged/invariant failure分别规定 receipt、observation、finalizer与退出码。信号码若保留 130/143，应明确不在 allowed exits。测试逐项断言，而不只断言锁/index 副作用。

8. **MEDIUM — 新机器验收把 clone HEAD 强制等于“最近一次每日 observation”会对正常的观察后新 push 假红。**

   为什么重要：plan:184 要求 fresh clone HEAD == 最近一次 observation `headSha`。但每日观察只有一次，writer 每小时可继续正常推进 main；若 observation 后有任意合法 push，fresh clone 会得到更新的当前 HEAD，反而不等于旧 observation SHA。此时新机器确实拿到了最新内容，却被验收判失败。

   建议修复：fresh clone 完成后立即用独立 `git ls-remote`/GitHub API 读取当前 main，要求 clone HEAD == 这个同时间远端 SHA；最近 schedule observation 只需验证仍是当前 main 的祖先或本身。增加“observation=H1，之后正常 push H2，fresh clone=H2”的通过用例。

## Verdict

CHANGES REQUESTED — address items above
