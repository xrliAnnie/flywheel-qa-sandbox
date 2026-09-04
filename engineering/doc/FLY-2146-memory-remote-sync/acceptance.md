# FLY-2146 记忆远端真同步 — 阶段一验收记录
Issue: FLY-2146 (https://linear.app/geoforge3d/issue/FLY-2146/2132a2-记忆定时真同步以远端上有没有为准-连续多日新鲜度验证)
日期: 2026-09-04
基于: design-addendum-2.md(design-correction.md 与 plan.md 为其上游)

## 结论

当前状态: **阶段一代码与隔离验证、宿主真实 manual sync 通过;launchd one-shot smoke 等待 Founder 执行;阶段二连续三日观察尚未开始。**

本实现没有把「命令返回 0」当作交付。写者最后重新读远端 `main`,只有远端 SHA 等于本轮冻结的本地 SHA 才写 `arrived=true`;独立看者不读取这个布尔值来判断到达;连续多日验收只认 GitHub 保存的自然 `schedule` 运行和 D/D+1 两棵远端树。

设计权威:

- 锁定计划 blob: `83cbd495a7602a7d8dd1a29940961dcfb2fd1075`。
- 并发与 structural/freeze/CI 修正: `design-correction.md`。
- 可移植锁、600/660 秒和三文件发布闭包: `design-addendum-2.md`。

## 阶段一证据

### 1. 真实宿主只读预检

2026-09-04 在真实 `~/.claude/agent-memory` 上只读取得:

| 项 | 结果 |
|---|---|
| 仓根 / 分支 / hooks | 安全的独立 `.git`;`main`;`.githooks` |
| origin | canonical `https://github.com/xrliAnnie/lead-memory.git`;无独立 push URL |
| index | 0 条 staged |
| 工作树 | 64 条待处理记录(未把路径或内容写入本文) |
| 起点 | 本地 `f39602a8b591` == 新执行的 `ls-remote` `f39602a8b591` |
| 远端 main 日期 | `2026-09-04T00:42:40Z` |
| gitleaks | `8.30.1` |
| 实际 writer 锁后端 | macOS `lockf` |
| chezmoi/dotfiles 对照 | `origin/main..HEAD = 124`;本单未触碰 |

runner 沙箱随后拒绝在真实仓创建 `.git/flywheel-writer.lock`(`Operation not permitted`)。产品按合同返回 6、写 `preflight_failed` / `observation=undetermined` receipt,并再次证明本地与远端仍同为 `f39602a8b591`。这次是**沙箱负向证据**,不是 live PASS。

宿主代跑请求 `344c9491-6460-4aa3-b3af-30e757a28670` 已由 Lead 接单;精确命令、安全边界、receipt schema 和两个 one-shot/no-KeepAlive 临时 label 已通过 report `04d7e92b-d356-4235-9b70-98fb60c00bb0` 回传。Lead 的真实 manual sync 返回 0,远端从 `f39602a8b59115fd7e5514f85e89e2cc9cc0bad7` 推进到 `86020cbf12c9e099bbcd0f68118d440aec015c7a`;fresh `ls-remote` 相等,receipt 为 `arrived=true`,`arrival_observation=observed`,`committed_n=5`,`failed_n=0`,`fetch_rc=0`,`push_rc=0`,结束后工作树 0 条。完整无路径/内容证据见 `host-stage1-evidence.json`。

Lead shell 的 FLY-913 deploy guard 在执行前拒绝了 `launchctl` install/kickstart;没有安装临时 plist,也没有发生 launchd mutation。没有绕过 guard。两个 one-shot/no-KeepAlive smoke 和 observer fresh/none 行因此明确记作 `pending_founder_execution`,作为 merge 前 Founder 宿主验收项。

### 2. 隔离写者与远端真值

`test-lead-memory-sync.test.sh` 在 fresh clone + bare origin 上证明:

- 夹 A 已 staged、夹 B 待送时,只产生 B-owner 提交;A 的 path/blob/mode 集合逐字保持;普通 A writer 随后仍能提交。
- push 返回 0 但远端未动 ⇒ `arrived=false`,退出 5。
- push 已把远端推进但 wrapper 返回 42 ⇒ `arrived=true`,退出 7;命令状态与到达事实分开。
- fetch 失败时不 push;远端本来已含 expected SHA 时仍记 `arrived=true` + 退出 7。
- closed HTTPS proxy ⇒ 退出 5、`observation=undetermined`、`push_rc=null`。
- 活锁 ⇒ 75,`runs.tsv` 和远端逐字不变。
- 普通 writer 卡住时 sync 返回 75且不写 run;普通 writer 的缩短 2 秒副本返回 75,待送文件与既有 staged 集合不变。
- sync 卡在 commit hook 时,缩短 2 秒副本走 TERM 恢复、退出 143、receipt `reason=interrupted`,本轮 own staged 路径清除;此时普通 writer 不交错并返回 75。另一个本地 `git add` 卡死反例证明全写序列也受同一剩余预算限制,不是只给远端命令设超时。
- `commit --only` 换成 `--include` 的 mutation 会把 A staged 搭进 B 提交,所以护栏测试确实能红。
- push 桩直接 `fstat(1)` 证明 hook stdout/stderr FD 是 `0600`;fetch/rebase/commit/push 输出都先私有创建再使用,结束删除。
- 普通 writer 的 post-commit 校验不再与 bounded runner 争用 stdin:禁用 hooks 的隔离仓会真的生成一个无 owner trailer 的本地提交,校验返回 6,远端 SHA 保持不动。旧版嵌套 `python3 -` 的 mutation 会返回 0 并把该提交推上远端,所以这不是只断言源码形状。
- 普通 writer 在任何 mutation 前逐项校验 canonical raw/resolved fetch/push URL;显式 wrong `pushurl` 反例返回专用 10,本地 HEAD、canonical remote 与 wrong remote 均不动。detached HEAD、`rebase-merge`、`rebase-apply` 三态与 scheduled sync 用同一批 fixture 做 parity,均返回 6且不改 HEAD/index。
- scheduled sync 的 rebase 前置覆盖全仓 staged 与 tracked-dirty 路径并返回既有 defer 码 3,不再把非 Lead admin index 误送进 rebase/abort 后报 8;纯 untracked 结构残留仍不阻断。writer 依赖预检只含投递实际需要的工具,缺 observer-only `gh/curl` 不再停送。

生产常量是 `SYNC_LOCK_HOLD_MAX_SECONDS=600`,`LEAD_WRITE_HOLD_MAX_SECONDS=600`,`LEAD_WRITE_LOCK_WAIT_SECONDS=660`;测试只在一次性副本按用例把超时缩短到 2–15 秒。macOS 实跑选择 `lockf`;同套 CI 在 Linux 必须断言并运行真实 `flock`;另有直接继承 FD 的真实 Python `fcntl` 互斥、争用和 SIGKILL 后重取证明。

### 3. 独立看者反向对照

`test-lead-memory-arrival-check.test.sh` 证明:

- stale、writer_silent、unfetched、remote_unreachable、structural 五本 episode 独立;失败通知不写成已送达,失败恢复不误清账。
- 缺 receipt 连续两次产生 `writer_silent`;这与上面的 stuck writer / sync 75 / runs 不变组成完整反例。
- 远端读不到时 `local_ahead=undetermined`;假 token/假 channel seam 返回失败时,台账写 `post_status=failed`,没有真消息。
- Discord 投递失败在 state 与 TSV 落证据后返回专用 10,因此 launchd 不再把告警器自身失败当作健康退出;下一轮仍会重试未送达 episode。
- 删除从第一次观察开始计龄,不借用已不存在文件的旧 mtime;顶层模板残留不混进 stale。
- 看者不 fetch、不读 `runs.tsv`、不读写者日志;报告与看者并发时 `state.json` 字节不变。

### 4. 多日证据工具与发布闭包

- `remote-observe.yml` 恰好一个 job/step,只读 contents,每日 `09:05 UTC` 自然运行;summary 只写 `GITHUB_SHA`、run id 和服务端 UTC 时间。
- `freshness-report.sh` 对每个 UTC 日固定查询一次,只接受 `schedule/main/completed/success/attempt==1`;rerun 和 dispatch 不计。窗口上限七天。
- freeze 是 create-if-absent,只接受当天专用 marker;先证明 D 树没有目标 blob,D+1 再证明有。D 树已含相同 blob 的 mutation 被拒。
- `--local --json` 与 `--commits --json` 输出已用 `jq` 验证;报告不取看者锁、不改看者状态。
- 隔离发布演练完整走过 C6.1 第 1–8 步:Lead 夹仅工作树脏时可发布恰好 `README.md`、`remote-observe.yml`、可执行 `write-memory.sh`;预先 staged Lead 路径在第 1 步停;第四条 staged 路径在第 5 步 reset 并停,均不产生 admin 提交。
- A1 的 `sync-template.sh`、`first-import.sh` 两份精确集合/显式 add、hooks/bootstrap 测试都已纳入 remote observer 与普通 writer。生产历史根提交早于这两文件;不倒写历史,由 post-merge 三文件 admin 提交发布。

### 5. 退役与防复活

`retire-units.sh` 只接受两个生产精确 label,且要求交互 TTY、显式 operator 确认和 durable audit。测试覆盖 disable、bootout、archive、unlink 每步失败,foreign active/archive,hard-link 发布后崩溃恢复,authority 缺失时拒绝 enable,以及完整幂等。

真实 `converge-nonlead-daemons.sh` seam 反例证明:manifest copy 单元仍 enabled 时,删掉 active plist 会被重新复制并 bootstrap;先写 disabled override 后才不会复活。因此退役顺序固定为 `disable → bootout → hard-link archive → identity-safe unlink`。

## 测试墙钟与资源边界

阶段一最近一次本机串行观测(同一 shell,无并发 suite):

| suite | 目标 | 本机结果 |
|---|---:|---:|
| sync | ≤120s | PASS,48 项;R1 五项修复后本机串行重跑约 75s(含三态 writer/sync parity 与全仓 rebase defer) |
| arrival | ≤45s | PASS,15 项,6.16s |
| freshness | ≤45s | PASS,7 项,2.32s |
| observe workflow | ≤10s | PASS,1 项,0.04s |
| retire | ≤30s | PASS,14 项,2.43s |

五套合计低于 250 秒设计预算。CI 新增独立第五分片,20 分钟 cap 与 85% tripwire 不变。所有 vitest 后续门固定 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`,且排除会操作真实 Terminal.app 的 `packages/core/test/tmux-viewer.macos.test.ts`;相关包构建串行。

创始人静态 HTML 通过本地 HTTP 200、必含文案、nonce placeholder 与 external/inline script 检查。系统 Chrome 与独立下载的 Playwright headless Chromium 都在 runner 启动阶段被 Mach-port policy 拒绝(`bootstrap_check_in … Permission denied (1100)`),因此这里不伪称完成人工截图检查;视觉截图保留为 merge 前可写宿主验收项。

## 实施门禁与审查状态

- `pnpm lint` 返回 0;14 条既有 warning 均不在 FLY-2146 文件。按 pinned plan 的 Lead 并行度红线,没有运行被明确禁止的 `pnpm -r build` / `pnpm test:packages:run`;本单没有 package source 改动。kill-path inventory fixture 因新增 deadline killer / lock probe 同步后,只跑受影响的 `flywheel-claude-runner` 单测 1/1,固定 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`、`--maxWorkers=4 --minWorkers=1` 并排除真实 Terminal.app 用例。
- 新增五套 shell suite 全绿;修改过的 hooks 27/27、bootstrap 57/57、CI shell 枚举、CI structure、manifest fail-closed 与完整 manifest(22 rows / 3 census scopes)也全部通过。生产脚本 `bash -n`、`shellcheck -S warning` 与 `git diff --check` 通过;path-hygiene 13/13 通过。
- 依角色要求调用 `codex:rescue` companion,但它在读取仓前被 runner 的嵌套 macOS sandbox 拒绝(`sandbox_apply: Operation not permitted`,status 71);没有调用原始 `codex exec`,也没有把失败伪称为通过。有效代码审查走 request-driven cross-family gate。
- cross-family round 4 在 `6c30aa29d` 找到一个 HIGH:`write-memory.sh` 的 nested-stdin post-commit verification 实际为空程序。先以端到端负向夹具复现 RED,再在 `033fa456c` 改用 `python3 -c`。Lead 随后以 `[lead-instruction c7c994a7-1f56-408b-801f-902bf4fa9a7e]` 裁定同批修完六项 MEDIUM 与 temp cleanup LOW;实现提交 `4ad50dd10` 后取得 sync 40/40、arrival 15/15。
- 已修项各有行为证据:普通 writer 在 mutation 前验证 hooksPath、四个 hook、两份 policy 与 gitleaks 8.30.1;actor 环境只在 bounded Git child 周围变成 sync 并精确恢复;远端领先且仅自身目录脏时先提交/验证、再 rebase/push;`gh api` 日期失败不再伪造 remote-unreachable;根 `.DS_Store` 既不阻断 rebase 也不进入 structural;测试直接打生产 `sync_*` helper,两个死 `lm_*` 副本已删;arrival 失败与 signal 都清理私有 `run.*`。
- final-head review request `4b96a068-17ef-4eb3-9efb-62ecfc64498c` 在 `0512fceb0` 找到两个 HIGH 与四个 MEDIUM。`8f1b21d2c` 按 Lead handoff 一批关闭:GNU coreutils 先走并校验 `stat -c`;local-Git deadline 在临时 fixture 的目标 `git add` 前重启真实 4s deadline,不再赌 preflight 墙钟;exit 3/4 的远端读失败保持 `undetermined`;未尝试 push 时 `push_rc=null`;三个证据早退先停 killer;rebase dirtiness 只看合法 Lead 夹。旧 GNU fallback 的最小命令先稳定 RED,随后 sync 44/44、retire 14/14、hooks 27/27 全绿。
- Ubuntu CI 随后揭示 local-Git stall fixture 偷用了 macOS 全局 gitleaks:该 fixture 的私有 `PATH` 没有像相邻 stuck-writer fixture 一样链接测试 scanner,writer 正确地在 preflight fail-closed,因而 marker 永远不会出现。先在本机剥离全局 gitleaks 稳定复现同一句失败,再补齐 fixture 依赖;同一隔离命令随后 sync 44/44 全绿,生产脚本没有为测试让步。
- exact-head R1 `4fe6afd0-7214-4ef4-aebc-2e19c738e7b3` 在 `c49eb3963` 报告 ordinary writer origin HIGH、全仓 rebase precheck 与 writer state parity 两项 MEDIUM、writer/observer 依赖隔离与 notification exit 两项 LOW。Lead `[lead-instruction a869c530-17d5-4db1-a707-38f2e8f000df]` 明确要求五项各自 TDD、一次推送、一次 R2;`95464649c` 已全部实现,本机 sync 48/48、arrival 15/15。
- 其余 LOW 仍按 review policy 保留为非阻断 advisory,没有写成已修:`freshness-404-heuristic-on-stderr`、`sync-aborts-8-on-unborn-head`、`arrival-oldest-unpushed-dead-parameter`。修复后的 literal-last milestone 头由 coordinator 自动发起 fresh exact-head review,通过前不交接。

## 尚未完成的硬门

1. Founder 完成 `host-stage1-evidence.json` 中两个 `pending_founder_execution` 项:launchd sentinel 创建和删除各推进远端一次;独立看者新增一行 `fresh/none`;两个临时 label/plist 清理并留 identity-safe archive。真实 manual sync 子项已经 PASS。
2. PR 合并且 updater 部署后,由 Lead 发布三文件 admin 提交并确认 guard workflow 与 remote-observe dispatch 成功。
3. milestone 保持「观察中」。从首个自然观察日 D1 起执行 D1 freeze、D2 check D1 + freeze D2、D3 check D2;两次连续「次日远端可见」缺一即重开 issue。
4. 新机 fresh clone 后立即独立读 `ls-remote`;clone HEAD 必须等于同一时刻 remote main,最近自然观察 SHA 必须是其祖先或本身。
