# Design Review — plan.md (Round 2)

Date: 2026-09-04
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮核对的是 `plan.md` 的实际 blob `6541efa37ead7dedf17aca9a05f71a804cae2693`。R1 的大部分问题已经得到实质修正：统一到达终结器与双向 mutation、`cat-file` 的 fail-closed 分支、NUL-safe 脏龄与删除首见时间、index ownership、rebase 复原断言、小时级独立 episode、固定证据 schema、常量合同测试和 manifest 批准集合都应保留。

但还不能批准。三个核心合同仍有假绿或未定义路径：(1) 对称 `insteadOf` 可把 fetch、push 和最终 `ls-remote` 一起改到非 canonical 仓，现有“三重校验”仍会通过；(2) 本地 `checks.tsv` 加事后的祖先检查不能证明该 SHA 在记录时间已经位于远端，仍不满足 founder 的“判断只看远端”；(3) writer 在 fetch 失败以及多个早退终态上没有完整定义 `expected` 与业务退出。另有 launchd 日志路径、实际回滚、hook 依赖/输出和状态所有权问题，应在实施前收口。

## What's Good (Keep)

- 保留 `finalize_arrival` 作为 `arrived` 的唯一写入点，以及“push rc=0 但远端没变”和“远端已变但 push rc!=0”两个非对称 mutation；这比 R1 的不可达用例真正覆盖了远端真值边界。
- 保留 watcher 不信 `receipt.arrived`、不读 `runs.tsv`/日志且不 fetch 活仓；对象缺失时使用 `unfetched`/`undetermined`，不会把未知冒充 0。
- 保留 `--porcelain=v1 -z`、删除项首见时间、整个 local-only commit 集合取最老 `%ct`，以及 watcher/report 共用计算代码的方向。
- 保留 clean-index 预检、逐夹 staged-set 断言、commit 后 owner/index 断言、保守的 dirty-before-rebase 和 abort 后双 rebase-state 检查。
- 保留 commit hook 原始输出的 0600 隔离、receipt/acceptance 的最小化字段，以及 fake secret 对所有持久面的负向断言。
- 保留 watcher 改为每小时 :40、三类 episode 独立记账、成功投递才 latch/clear 和连续两次才判 `writer_silent`；检测延迟也已写实。
- 保留合并前 worktree 临时 label + 真 push 哨兵、合并后 canonical bytes + 两次自然触发的两阶段 launchd 验证思路。
- 保留 `launchd-units-manifest.test.sh` 的批准集合与 resolved-payload 断言；源码核验确认 `ci-structure.test.sh` 只钉 shard step 名，不需要因追加内部命令而修改。

## Issues & Recommendations

1. **BLOCKER — `lm_origin_check` 仍允许把私密记忆完整地重定向到非 canonical 仓，并由同一个错误仓把 `arrived` 判真。**

   为什么重要：plan:69 只要求两个 resolved URL “各一条且彼此相等”，并明确让对称 `insteadOf` 通过。隔离实测表明，raw `remote.origin.url` 仍是 `https://github.com/xrliAnnie/lead-memory.git` 时，一条 `url.file:///tmp/not-the-canonical-remote.insteadOf` 会让 fetch-resolved 与 push-resolved 同时变成该 file URL；计划的三项检查全部通过。随后 push 和终态 `ls-remote origin` 都访问错误仓，`arrived=true`，而真正 GitHub 私仓没有内容。这比 R1 的“push/read 不同”更危险，因为它会假绿且已经泄漏。A1 bootstrap 的对称 `insteadOf` 只是 hermetic fixture 技巧，不是 runtime 安全合同；其生产预检本身并未声称解析后仍 canonical。

   建议修复：resolved fetch URL 和 resolved push URL 都必须各恰好一条，并且各自精确等于 canonical `REMOTE_URL`，不能只比较彼此相等；任何 `insteadOf`/`pushInsteadOf` 导致解析值改变都在第一次 add 前退出 6。测试 bare origin 改用 PATH fake-git transport、隔离脚本/guard 常量副本，或其他不污染生产 origin 判据的 seam。增加本轮上述“对称重写到同一错误仓”的必拒测试。

2. **BLOCKER — `--verify-ledger` 证明的是“这个 SHA 最终成为 main 的祖先”，不是“它在 `observed_at_utc` 已经在远端”；当前连续多日验收仍依赖本地日志。**

   为什么重要：plan:150-153,204-205 把本地 `checks.tsv` 定为连续多日证据，再用当前 GitHub compare 复核祖先关系。反例是：day 1 在台账伪造一个当时只存在本地的 SHA，day 2 才把它推上 main，day 3 运行 compare；此时 status 同样会是 `ahead`/`identical`，错误的 day-1 观察会通过。PRD:149-152 明确要求连续若干天成立，并且判断看远端、不是本地是否跑过或日志是否写完成。计划自己也承认远端历史不能重建 ref 到达时刻，因此本地 ledger 适合作为运维心跳，却不能升级成该 acceptance 的权威证据。完成定义 plan:228-230 还只要求“把阶段二写进 QA 判据”，把第 3 天证据留到 ship 后，意味着 issue 可在核心 acceptance 尚未发生时被宣告完成。

   建议修复：保留 `checks.tsv` 做监控，但从 founder acceptance 中移除其权威身份。连续多日必须在每天约定时刻现场查询远端，并绑定当天已知的记忆/blob 已可见；若要求事后仍可只凭远端审计，就把观察凭据落到 GitHub 自身可查询且带服务端时间的表面，或先取得 founder 对 acceptance 变更的明确决定。增加更强反例：“先写 ledger、后 push 同一 SHA，`--verify-ledger` 必须不能把早期观察判有效”。阶段二自然运行和第 3 天远端验收应是 FLY-2146 关闭/ship 的硬门，不只是 milestone 占位。

3. **BLOCKER — writer 终态机仍未对所有路径定义可用的 `expected`，且 fetch 失败可能继续使用陈旧 `origin/main`。**

   为什么重要：plan:82 在初始远端读取失败时跳过 fetch/rebase/push；plan:85 的 dirty/rebase-failure 也可在第 5 步前终止，但 `expected` 直到 plan:86 才赋值，plan:87 却要求这些终态统一比较。实现者只能自行猜测。更严重的是，plan:85 记录 `fetch_rc` 后没有规定非零时立即停止；代码可能继续基于旧的 `origin/main` 算 ancestry/pending 并 push，违反 A1 README 的“pull/rebase before publishing”。“abort 失败后不再做任何 git 操作”(plan:102)也和“所有 trusted-preflight 终态都重新 ls-remote”的摘要不一致。

   建议修复：把 `expected_local_sha` 的生命周期写成状态机：本地逐夹提交完成后立即冻结；成功 rebase 后更新；任何终结器入口都必须已定义。fetch 非零必须禁止 rebase/push，单独记录 operation failure，并定义“远端恰好已等于 expected”时的非零业务码。明确普通 rebase error、冲突、abort/复原失败各走哪一终态，以及 exit 8 是否刻意跳过 finalizer并记 `undetermined`。补 fetch rc!=0 + stale `origin/main`、初始 ls-remote 不可达、dirty-before-rebase、conflict、abort-failure 五条逐终态断言。

4. **HIGH — checked-in copy plist 不能把 `StandardOutPath/ErrorPath` 中的 `$HOME` 当作 shell 表达式。**

   为什么重要：plan:156 把路径写成 `$HOME/.flywheel/logs/...`，但这两个键由 launchd 直接解释，不经过 `ProgramArguments` 的 `/bin/bash -c`，不会做 shell 变量展开。当前 repo-owned copy plist 使用的是 `/tmp/...` 等绝对字面量；需要 home 的模板则先把 `__HOME__` 渲染后安装。`policy=copy` 会逐字复制 repo plist，也没有渲染或创建日志父目录的步骤。结果可能是单元在执行脚本前就因日志路径无效而无法启动，阶段一的临时 plist也不能证明 canonical copy plist可运行。

   建议修复：使用 launchd 可直接打开的绝对路径并保证父目录在 bootstrap 前存在，或采用仓内已有的显式 template-render/install 合同；如果不想扩 converge，使用现有 `/tmp` 形状最简单。manifest/plist 测试增加“日志路径为绝对字面量、无 `$HOME`/`~` token”和安装前父目录前置条件的断言。

5. **HIGH — 计划中的 rollback 会被现有 installed-disk convergence 立即撤销。**

   为什么重要：plan:197,200 说 `bootout` 后从 manifest 删行即可停止并可用 revert PR 回滚。但 `converge-nonlead-daemons.sh:1082-1151` 会继续枚举 `~/Library/LaunchAgents/com.flywheel.*.plist`；只要已安装 plist 还在且 launchd override 未 disabled，它即使不在 manifest 也会被当作 enabled unmanaged unit 重新 bootstrap。`update-flywheel.sh:240-250` 每班都会运行这条 convergence。因此“删 manifest + bootout”不是稳定回滚，“revert 一个 PR”也不会清掉已部署副本。

   建议修复：定义精确、持久的退役步骤，例如先 `launchctl disable` + `bootout`，再由既有 operator-safe 路径移除两个精确 installed plist，最后删 manifest/source；同时写明重新启用时要清除 disabled override。增加模拟“manifest 行已删但 installed plist 尚在”的 converge 测试，证明回滚后下一班不会复活。

6. **HIGH — preflight 没覆盖真实 hook/remote 依赖闭包，且“所有 hook 输出不落持久面”的承诺只包住了 commit。**

   为什么重要：plan:77 只检查三个 hook 可执行。实际 `pre-commit` 还执行 `.githooks/lib/guard.sh` 并读取仓根 `.gitleaks.toml`、`.gitleaksignore`（`scripts/lead-memory/hooks/pre-commit:4-20`）；三个脚本的远端超时还依赖 `scripts/lib/bounded-run.sh`。这些缺失/不可执行会被降格成泛化 `hook-refused` 或 remote-undetermined，而不是预检 6，且原始诊断已被刻意丢弃。另一个缺口是 `git push` 会运行 `pre-push`，其 guard 可在 stderr 打出 commit/path 拒绝原因；plan:83 只隔离 `git commit` 输出，plan:86 未隔离 push 输出，却在 plan:178 声称 hook 输出不进任何持久面。

   建议修复：preflight 验证 guard 为 repo-owned regular executable、两份 gitleaks policy 文件为 regular non-symlink，并验证 bounded-run 是预期的 regular executable。对 push 也采用 0600 私有捕获、固定外部错误与 finally 清理；receipt 仍只记 allowlisted 枚举。为缺 guard/config/ignore/bounded-run 以及 pre-push 打随机敏感 path 的用例增加负向测试。

7. **MEDIUM — exit/evidence 与 lock 的文字合同仍互相矛盾，静态 `-f ` 禁令也会误伤正常文件检查。**

   为什么重要：plan:88 先写优先级 `6 > 75 > 8 > 9`，随后又写任何证据失败都由 9 覆盖业务码；两者对 preflight receipt 失败、rebase restore failure 后 receipt 失败会给出不同结果。plan:76 把状态目录不可写列为 preflight 6，但该路径不可能完成所承诺的 receipt。锁在所有 Git preflight 后才获取（plan:76-78），测试/护栏却要求 live lock 路径“零 git 操作”(plan:106,185)。最后，源码禁用原始子串 `-f `（plan:110）会同时匹配合法的 `[ -f file ]`，并不能准确证明没有 `git push -f`。

   建议修复：给“业务结果计算 → evidence 尝试 → 最终 exit”写一张唯一真值表；若 8 有意高于 9，就删除“9 覆盖任何业务码”，否则把 9 放到相应最高位。把 live-lock 保证改成“零 mutating/remote Git 操作”，或把锁前移并保留安全状态根校验。静态测试只检查实际 `git push` argv 中的 `-f/--force*`，不要 grep 通用 `-f ` 子串。

8. **MEDIUM — `freshness-report --local` 会共用并可能改写 watcher 的 `state.json`，报告与告警状态的所有权/并发没有定义。**

   为什么重要：`lm_pending_age` 为删除项维护 first-observed 状态（plan:71,118），而 `--local` 明确复用该函数（plan:150）。这会让一次人工报告提前建立或清理 watcher 的删除指纹；如果恰与 :40 watcher 并发，两个 atomic rewrite 仍可能相互覆盖同一 JSON 中的 episode/删除表。报告因此会改变下一次 stale 判定，而计划没有给 report/watch state lock 或 merge ownership。相邻地，四个 verdict 中的 `unfetched` 被并入 `writer_silent` 三本账（plan:121-127），但没有定义它是否也需要连续两次、与真正 writer_silent 同时存在时何时恢复。

   建议修复：把 pending scan 分成纯采集结果与 watcher-only 的 first-observed state transition；report 使用只读快照或自己的独立 scratch state，绝不写 arrival episode state。若允许手工 watcher 并发，给 `state.json + checks.tsv + post latch` 一个同域短锁。把 `unfetched` 到 episode 的有效 predicate、连续次数、文案与恢复条件写死，并补 `unfetched → writer_silent → fresh`、并发 report/check 两条测试。

## Verdict

CHANGES REQUESTED — address items above
