# Design Review — plan.md (Round 1)

Date: 2026-09-04
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向是对的：独立写者与看者、`ls-remote` 作为唯一到达真值、沿用 A1 hook、拒绝 autostash/force/no-verify、隔离反向台架，这些都贴合 founder PRD。当前 plan 仍不可实施，原因不是缺少代码细节，而是几条核心判据在现有描述下会假绿或根本跑不到：写者的 mutation test 没有经过 push，watcher 未必拥有远端 SHA 对象，删除项可能永远没有 pending age，commit metadata 不能证明远端到达日，launchd 验收也不会真正经过 push credential path。另有 shared index/crash recovery、push URL、告警 episode 与 state durability 等活仓风险需要先收口。

## What's Good (Keep)

- 保留写者/看者进程与判断输入分离。看者不信 `receipt.arrived`、不读 `runs.tsv` 或日志，是对 chezmoi 事故的正确结构性回应。
- 保留 A1 的真实 hook 路径。当前 `guard.sh` 确实在 sync 模式按唯一暂存夹推导 owner，并在 pre-push 拒绝 merge、非快进、删分支和新发布的 admin-owned history（`scripts/lead-memory/lib/guard.sh:65-100,213-259`）。
- 保留逐夹提交、脏树不 autostash、rebase 冲突 abort 的保守策略；它比 stash 被拦内容更符合 fail-closed。
- 保留有界远端命令。仓内 `scripts/lib/bounded-run.sh` 已有命令状态透传与 timeout=124 合同，可直接复用，不需要再造 timeout 状态机。
- 保留不可达、错误 actor、gitleaks 命中、活锁、rebase 冲突、无 TTY、假 receipt 等负向用例；测试思路总体比普通 happy-path 套件扎实。
- 保留不碰 chezmoi、claude-config、多机自动解冲突和元监控的边界，也保留“连续多日/真第二台机器不能在单次 QA 内证明”的诚实说明。

## Issues & Recommendations

1. **BLOCKER — `arrived` 的唯一赋值与 mutation/反向验收目前互相矛盾，核心不变量会假绿。**

   为什么重要：C2 第 1 步在初次 `lm_remote_head` 失败时明确跳过 fetch/push（plan:74），但 mutation test 用的正是“origin 不存在”（plan:89），所以把第 5 步改成读 push rc 的 mutant 根本不会经过被改代码。C6 同样把 origin 改成不可达 URL（plan:140），却又要求预检先核对 origin 必须等于生产常量（plan:68-69）；实际应在预检退出 6，不会得到写者 5 / 看者 `remote_unreachable`。此外，冲突/脏树等早退 receipt 如何得到 `arrived=false`、无 push 路径何时刷新 `remote_head_after` 都未定义。A1 README 还要求 push command failure 本身算失败（`repo-template/README.md:155-167`），而当前退出优先级会在“push rc 非零、但远端实际已更新”时返回 0。

   建议修复：把 `arrived` 收口到单一 finalizer：对所有经过可信 origin 预检的终态重新执行一次 `ls-remote`，且只有 `remote_rc=0 && remote_sha==expected_local_sha` 能置 true；预检/锁等没有可信远端观察的终态明确使用 `arrival_observation=undetermined`（若 schema 必须保留 bool，则 `arrived=false` 且另记 observation）。把操作结果与到达结果拆开，保留 `push_rc/fetch_rc`，并为“arrived=true 但 push command 失败”定义非零退出码以满足 A1。mutation 必须至少有两个非对称 fake-git 用例：(a) push rc=0 但不改远端，正确实现必须 false/非零；(b) 远端已更新但 wrapper 返回非零，`arrived` 必须 true、operation 仍失败。测试常量用脚本副本或命令 seam 注入，不能靠改生产 origin 配置绕过预检。

2. **BLOCKER — 看者拿到 `ls-remote` SHA 后，不保证本地对象库含该 commit，`rev-list`/`log` 在真实多机推进场景会失败。**

   为什么重要：C3 禁止 fetch，并直接运行 `git rev-list --count <remote_head>..HEAD`（plan:99-104）。当“另一台机器”刚推了本机从未 fetch 的 commit 时，`ls-remote` 能返回 SHA，但本地 Git 会报 bad object；这恰好是本设计宣称要覆盖的场景。当前 verdict 表也没有 `local_compare=undetermined` 的 fail-closed 分支，最坏会把未知当 0/fresh。

   建议修复：明确一种不写活仓的比较实现。推荐在 state/temp 下建一次性 bare repo，以活仓 object directory 作为只读 alternate，fetch 远端 main 到临时 ref，再对临时 remote ref 与活仓 HEAD 做 rev-list；完成即删。更简单但较弱的方案是对象缺失时把 `local_ahead`、unpushed age 记为 `undetermined` 并产生独立非-fresh verdict，绝不能默认 0。增加“远端 SHA 只存在于 bare origin、不存在于本地 objects”的测试，并让 `--local` 报告复用同一实现。

3. **BLOCKER — pending age 算法会漏掉删除，且“最早未推提交”的命令写反了。**

   为什么重要：plan 明定删除路径计入 dirty_count 但不参与 mtime（plan:104）。若待送内容全部是删除，dirty_count>0、两个 age 都为空，`pending_age_h` 永远为空，因此永远不会 stale。`git log -1 --format=%ct <remote>..HEAD` 通常给的是遍历中的最新提交，不是所有未推提交的最小 committer time；一个 30h 老提交后跟一个 1h 新提交会被误判为 1h。非 NUL 的 porcelain v1 也无法可靠解析空格、引号、换行和 rename path。

   建议修复：用 `git status --porcelain=v1 -z` + NUL-safe parser/lstat。删除项需要可持续的 first-observed 时间：在 arrival state 中按稳定 path/status fingerprint 记录首次观察，消失后清理；不能凭空把 age 留空。未推提交 age 对整个 local-only commit 集合取 `min(%ct)`，不要用 `-1`。补三类测试：only-deletions 跨 26h、old+new 两个未推提交、含空格/rename 的路径。报告 `--local` 必须调用同一个函数而不是复制算法。

4. **BLOCKER — `freshness-report --days N` 不能用 commit committer date 证明“哪天到达远端”。**

   为什么重要：GitHub commits API 的 `.commit.committer.date` 是 commit 对象中的时间，不是 branch ref 被更新的时间。当前写者在远端不可达时先本地 commit、数日后再 push（plan:74）；若无需 rebase，远端最终仍显示旧 committer date。报告会把 9 月 4 日才到达的内容算到 9 月 1 日，直接违背“判断只看远端有没有”。反向也成立：某日没有新记忆/新 commit 不代表同步失效。由远端当前历史无法事后重建每个 ref 的到达时刻，所以 research 中“每一行都可从远端重建”的论断不成立。

   建议修复：把报告输出诚实改名为“当前远端可见 commit 的 metadata 日期”，不要称作 arrival day，也不要拿它单独证明连续多日。连续多日验收必须是每天在约定时刻重新执行远端观察，记录当日 `ls-remote`/API SHA 与待验 blob 已可见；若要求事后仍只凭远端复核，就需要把观察证据放到一个远端可查询面（而不是本地 freshness.tsv）。在 plan 中明确“无待送内容的日子”如何判 pass，并加“commit day 1、push day 4”的反例测试，保证报告不会宣称 day 1 arrived。

5. **BLOCKER — C6 的 launchd 验收既可能执行错 checkout，也没有真正测到 push/keyring。**

   为什么重要：manifest 的 host-prefix 是 `/Users/xiaorongli/Dev/flywheel/`，现有 plist/解析测试要求 shell `exec` 的也是这个 canonical checkout（`units.manifest:3`; `launchd-units-manifest.test.sh:176-185,252-254`）。本分支位于 `flywheel-FLY-2146`，合并前把 repo plist 原样复制到 LaunchAgents 会执行 canonical main 的旧/不存在脚本，而不是待验代码。即使路径问题解决，C6 第 1 步先把 43 条变化手工推完，第 2 步 kickstart 的 writer 很可能无新提交，只验证 `ls-remote`，完全没经过 `git push` 或 keyring credential helper。`trigger=launchd` 也只能证明 env 标签，不能区分人工 kickstart 与日历自然触发。最后又 bootout/delete，完成定义却没有 updater 正式 converge 后的 loaded 检查。

   建议修复：拆成两阶段证据。合并前只用隔离 label/临时 plist 显式指向本 worktree，证明 launchd 环境与脚本形状；合并并由 updater 部署后，再验证 production label 的 canonical bytes、`launchctl print` 和自然日历触发。凭据验证必须让 launchd run 确实产生一个安全、可回滚、单夹的受控变更（或等待并绑定一个真实 Lead 变更），证明 remote SHA 前后推进且 receipt 的 compared SHA 相同；随后用下一次合法 sync 清理哨兵。另记录至少两个自然 `Minute=17` run 的真实开始时间，不能只看 `trigger` 字段。

6. **BLOCKER — origin 预检漏掉 push URL 重定向，可能先把私密记忆推错地方再由 `ls-remote` 判失败。**

   为什么重要：A1 bootstrap 已显式拒绝任何 `remote.origin.pushurl`（`bootstrap.sh:62-68`），本 plan 只写“origin URL == 常量”。Git 允许 fetch URL 与 push URL 不同，也允许 `url.*.pushInsteadOf/insteadOf` 重写。此时 `ls-remote origin` 可读正确私仓，而 `git push origin main` 可把内容送到另一个仓；最终 `arrived=false` 并不能撤销泄漏。

   建议修复：预检必须验证 local raw config 不含 pushurl，并验证 `git remote get-url --all origin` 与 `git remote get-url --push --all origin` 解析后都恰好只有一个、且都是 canonical HTTPS URL；测试 separate pushurl、pushInsteadOf 和多个 URL。任何不一致在第一次 add/commit 前退出 6。不要用 `url.*.insteadOf` 搭测试 bare origin，否则正好掩盖生产要拒绝的形状。

7. **HIGH — shared index、崩溃恢复和 Lead 并发写没有形成可执行合同。**

   为什么重要：writer lock 只约束 writer，不约束 Lead/manual Git。流程中的 `git diff --cached --quiet` 是全 index 判断，而 `git commit` 也会提交全 index；若启动前已有另一夹/顶层 staged path，当前循环会误归因、反复失败，甚至提交别人预先 staged 的单夹变化。writer 若在 add 后崩溃，陈旧锁虽能回收，index 却留脏；下一轮可把 B 夹的 staged change 当作 A 夹处理。`git reset -- <夹>` 也可能破坏人工 staging。status-clean 与 rebase 之间另有 TOCTOU；rebase abort 只检查 `.git/rebase-merge`，未覆盖 apply backend 的 `.git/rebase-apply` 或 abort 自身失败。

   建议修复：选择并写死 index ownership。最简单的安全边界是：预检要求 index 完全 clean；每夹 add 前后验证 staged paths 恰好属于该夹；commit 后验证 index 归零及新 commit owner/path；发现外来 staged 状态只 fail-closed，不 reset。增加 EXIT/INT/TERM trap，只在能证明当前 run 拥有该 staged set 时清理锁/index。所有 rebase 失败先分类，再要求 `git rebase --abort` 成功、HEAD 复原且两种 rebase state dir 均不存在；若恢复失败使用独立 terminal code 并停止。补 pre-staged、kill-after-add、status 后并发改写、abort 失败注入测试，并说明人工恢复命令。

8. **HIGH — 只枚举当前存在的顶层目录会永久漏掉整夹删除/rename。**

   为什么重要：`lm_lead_folders` 只列当前工作树中的合法目录（plan:64）。若一个已跟踪 Lead 夹被整个删除，它已不再是目录，writer 永远不会对它执行 `git add -A -- <夹>/`；rename A→B 也只会新增 B 而不删除 A。现有测试仅删“仍存在的夹中的一个文件”，没有覆盖这个差异。

   建议修复：候选集取“HEAD/index 中已跟踪的合法顶层 Lead 目录”与“工作树当前合法、非 symlink 目录”的并集，再逐个 add；仍排除顶层文件和非法名。增加 entire-folder deletion 与 A→B rename 测试，验证删除侧和新增侧各自形成合法单夹 commit（或明确禁止整夹删除并产生 fail-closed 告警，不能静默忽略）。

9. **HIGH — gitleaks 的原始命中会经现有 hook 直接写到 writer stderr，负向保密断言没有实现路径。**

   为什么重要：真实 `pre-commit` 直接执行 gitleaks，未使用 value-free 输出格式（`hooks/pre-commit:17-20`）。`git commit` 会把 hook stdout/stderr 原样交给调用者；若 sync.sh 不捕获，launchd ErrorPath 会落下命中值。plan 只说从“钩子首行”取 reason 和不泄漏，并未规定如何拦截/清洗原始流。把 receipt 原文贴进 tracked acceptance.md 还会公开 `ignored_paths`/失败相对路径，需另做最小化处理。

   建议修复：writer 必须把 commit 的 stdout/stderr 捕获到 mode-0600 私有临时文件，外部只输出固定错误码/夹名；除非能从结构化 gitleaks JSON 严格提取 allowlisted rule id/path，否则不要解析并回显 hook 文本。无论成功失败都删除临时原文。测试 fake gitleaks 同时向 stdout/stderr 打随机 secret，断言 receipt、runs、台账、launchd 捕获输出和 acceptance 摘要均不含它。acceptance 只贴 schema-safe 摘要和 hash/count，不贴含文件名的完整 receipt。

10. **HIGH — watcher 的周期、episode 转移和 delivery latch 尚不闭合。**

   为什么重要：每日 08:40 检查配 26h 阈值，最坏在变化约 50h 后才首次报警；3h `writer_silent` 最坏也要约 27h 后才观察，常量名称暗示的 SLA 与实际不符。机器在 08:40 后唤醒时 writer/checker 的 coalesced 顺序不保证，checker 还可能先发一次 `writer_silent`。research 说三类 episode 独立，plan 却用单一优先 verdict；`remote_unreachable → stale` 时哪个 episode恢复、是否同时开启另一个没有定义。发帖失败后是否写 `lastNotifiedAt`、恢复帖失败是否清 episode 也未说明；现有 liveness pattern 是只有 delivery 成功才 arm latch（`bridge-liveness-probe.sh:217-224`）。

   建议修复：要么把 checker 改为每小时在 writer 之后的固定分钟运行、台账按 UTC 日去重；要么把阈值诚实写成“下一次日检才发现”并接受 26-50h/3-27h 延迟。state 按三种 episode 分开：未知不能清旧 episode，成功观察到恢复才清；post 成功后才更新 lastNotifiedAt，恢复 post 成功后才清。测试 `stale → remote_unreachable → stale → fresh`、post failure retry、wake 后先 checker/先 writer 两种顺序。

11. **HIGH — receipt/TSV/state 的写失败与 schema 目前会造成无证据成功或不可解析台账。**

   为什么重要：plan 要求每 run 写 receipt/runs，但没有定义 push 已发生后 atomic mv 或 append 失败时的退出码；磁盘满、目录被替换或权限漂移会出现“远端已变、脚本却返回既定业务码且无证据”。锁占用路径还在未持锁时并发 append runs.tsv。freshness schema 也自相矛盾：research 定义第一列 `utc_date`、第二三列才是远端字段（research:100），plan 却称前三列都来自远端且 remote failure 时前三列都是 `undetermined`（plan:108,119）；`post=failed` 作为“额外列”会让 TSV 行列数变化。

   建议修复：定义固定 schema/header/version；每行始终含 `observed_at_utc, remote_head, remote_commit_date, ..., post_status`，远端失败时只把远端字段设 undetermined。所有 state/receipt/ledger write 都检查 rc；最终 evidence write 失败必须覆盖业务 exit 为专门的非 allowed code，并输出固定无敏感信息错误。runs append 使用单次短写或独立 lock，测试 ENOSPC/只读目录/mv 失败/两个并发 append。明确“preflight 零改动”指记忆仓零改动，因为它同时又要求写失败 receipt。

12. **MEDIUM — A1 常量与 launchd/CI 相邻合同没有真正列入变更闭包。**

   为什么重要：plan 称 sync-common 是“一处源”，但 A1 的 canonical `REMOTE_URL/MEMORY_PATH/LEAD_NAME_PATTERN` 已在 `guard.sh:5-13`，而 guard.sh 末尾直接 dispatch，不能安全 source；在“不改 guard.sh”边界下只能重复常量。另，`launchd-units-manifest.test.sh` 对 approved label 集合做精确相等检查（lines 193-219），加两行 manifest 必然要求改该测试，不能只写“必须仍绿”。它还应为两个 shell-c target 增加 resolved-payload 断言。现有 `copy` converge 对已安装但漂移的 plist只记 degraded，不会替换（`converge-nonlead-daemons.sh:1038-1054`），所以“repo plist byte authority”并不等于后续自动更新。

   建议修复：二选一：(a) 允许极小 A1 重构，把纯常量移到可 source 且无副作用的文件，guard/sync-common 共用；或 (b) 承认重复并加 contract test 锁定三处一致。把 `scripts/__tests__/launchd-units-manifest.test.sh` 明列进 C5 文件清单及测试 mutation；`ci-structure.test.sh` 当前只钉 shard step 名、不钉 FLY-2145 内部命令，无需无条件改。README/rollout 还要写清：首次缺失会自动 install，后续 plist bytes 变化会被 census 判 drift，须走既有 operator repair/重新安装路径，不能声称 converge 会自动刷新。

## Verdict

CHANGES REQUESTED — address items above
