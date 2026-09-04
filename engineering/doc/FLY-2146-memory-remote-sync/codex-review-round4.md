# Design Review — plan.md (Round 4)

Date: 2026-09-04
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮审的是当前 `plan.md` blob `1f4d302af21e12354803d2fb21cb61000363e2f9`。Round 3 的 8 项反馈都已实质进入计划，而不只是写进评审记录：远端 run 已固定到 `xrliAnnie/lead-memory` 的 `schedule/main`，文件可见性改为 D/D+1 两棵远端树的内容转换，A1 的 first-import 精确闭包已补齐，watcher 复用可回收锁，只读依赖已拆分，退役有了专用命令，信号/8 码进入唯一真值表，新机器判据也不再绑定旧 observation。这些修复方向正确，应保留。

当前仍有两个 BLOCKER，均来自 R4 新增的 post-merge/三日执行清单，而不是被重新打开的旧架构问题：第一，admin 发布步骤在允许 Lead 夹脏的活仓上既无法满足自己的 `git status` 判据，也没有防止已有暂存内容搭便车；第二，D1 就执行 fail-closed 的 `--days 3` 会在 workflow 刚发布时必然失败并阻止 freeze，且 D1–D3 只验了两次内容转换。这意味着当前文字下的关单门要么走不通，要么比声明少验一天。另有若干远端 run 绑定、退役 crash 边界与命令精度问题需要一并收紧。

## What's Good (Keep)

- 保留 writer 的 `expected_local_sha`、fetch 失败禁推、唯一 `finalize_arrival` 与非对称 mutation tests；`arrived` 的 remote-only 不变量已闭合。
- 保留 `-R xrliAnnie/lead-memory --event schedule --branch main` 及本地二次复核。GitHub 官方合同确认 scheduled workflow 只在默认分支运行，run SHA 是当时默认分支最新提交。
- 保留 D 日远端树缺失/不同、D+1 日远端树等于 frozen blob 的判据；它已关闭“旧文件 touch 一下也算到达”的 R3 假绿。
- 保留 A1 模板闭包的完整清单。源码复核确认当前 `first-import.sh:295-307,343-355,515-522` 正有两份 exact `required_top` 和一份显式 add 清单，当前 hooks suite `test-lead-memory-hooks.test.sh:85-95` 也有 exact installed-file loop；计划列出的四处确实都必须改。
- 保留 writer/watcher 共用 `lm_lock_acquire`、dead/missing/malformed pid 回收和 SIGKILL 后恢复测试；R3 的永久陈旧锁问题已解决。
- 保留 `lm_read_deps_check` 与 watcher/report fail-before-post 合同；缺 bounded runner 不再被伪装成远端故障。
- 保留专用 `retire-units.sh` 的方向。源码确认 `converge-nonlead-daemons.sh:1082-1151` 会复活未 disabled 的 manifestless `com.flywheel.*` plist，而 `fly1814-operator-tools.sh:91-162` 已提供 audit、identity、hard-link archive、identity-safe unlink/restore 所需 seam。
- 保留阶段一合并、阶段二观察后关单的 Lead 裁定；这是清晰的 lifecycle 分层，只需消除下面指出的残余矛盾。

## Issues & Recommendations

1. **BLOCKER — C6.1 的 admin 发布清单既会在允许的 Lead 脏树上假失败，也可能把已有暂存内容作为 `admin` 提交搭便车。**

   为什么重要：plan:201 明确只检查 `README.md .github/`，并注明 Lead 夹脏不影响；但 plan:202 跑完模板后却要求不带 pathspec 的 `git status --porcelain` “恰好”只有 README 与 workflow。题面已给出活仓有大量 Lead 脏路径，即使阶段一清过一次，post-merge 时 Lead 继续写也是正常状态；这些路径会出现在全仓 status 中，使合法发布无法通过。更危险的是，清单从未要求 index 全局为空，也未在 `git add` 后证明 staged set 恰好是两个 admin 文件。若某个 Lead 或一次中断留下已暂存路径，plan:203 的普通 `git commit` 会把它一起提交。当前 `guard.sh:74-95` 对 `admin` 明确跳过路径/单夹限制并写 `Memory-Owner: admin`，所以 hook 不会替清单挡住这种 hitchhike。

   建议修复：把 post-merge preflight 写成可复制的 fail-closed 序列：先要求 `git diff --cached --quiet`、无 rebase state，并用 `ls-remote` 证明当前 HEAD 等于远端 main；运行 `sync-template.sh` 后，只对完整的 template-managed 顶层集合做 scoped porcelain/diff，允许 Lead 夹工作树脏，但要求该集合的变化恰好为 README + remote-observe。`git add` 后用 NUL-safe staged-path 检查证明 index 恰好包含这两个路径，再 commit。增加“Lead 夹工作树脏仍通过”和“预先 staged 一个 Lead 路径必须在任何 admin commit 前拒绝”两个测试/演练断言。

2. **BLOCKER — 三日协议按当前命令顺序无法从 D1 开始执行，而且 D1–D3 只验证了两次而非三次“次日可见”转换。**

   为什么重要：plan:168 规定 `--remote-observations --days N` 缺任一 UTC 日就 `MISSING` 非零；plan:197 又规定 checklist 任一步失败即停；但 plan:192/210 要求 workflow 发布后的 D1 就先跑 `--days 3`。此时 D-1/D-2 没有 natural run 是必然状态，因此命令非零，D1 freeze 永远到不了。即便绕过这一点，D1 freeze 在 D2 检、D2 freeze 在 D3 检，而 D3 freeze 要到 D4 才能检；C6.2:225 只要求 D2/D3 两次 `--check-visible`，却在 §7 声称每天的真实内容转换都被两棵树证明。另有文字冲突：plan:190/222/296-298 采纳了“阶段二不是 ship 前置”，但 plan:192 仍写“任一日失败 ⇒ 不 ship、不关单”。

   建议修复：给出一张唯一的 UTC timeline。若目标是“三个观察日覆盖两个连续的次日转换”，则 D1 用 `--days 1`/显式 `--from D1 --through D1` 后 freeze，D2 用两日窗口并 check D1 后 freeze，D3 用三日窗口并 check D2；删除 D3 freeze 与“每天三次转换”的表述。若目标确实是三个写入日都证明次日可见，则必须增加 D4 natural observation/check D3，关单是四个 observation days。最终 D3/D4 再跑一次完整窗口总核验。把“不 ship”改为符合 Lead 裁定的“不验收、Lead 重开 issue；不回滚已完成的合并部署”。测试从一个刚发布、历史 natural run 为零的 workflow 开始演练完整状态机，不能只喂已有三天的静态 fixture。

3. **HIGH — `event=schedule` 不能单独证明这是无人手动补跑的首次 natural attempt。**

   为什么重要：`gh run rerun <run-id>` 会为原 schedule run 创建后续 attempt；它仍保留 `event=schedule`、同一个 run identity 与原 head SHA。当前固定 JSON 字段没有 `attempt`，因此“原 attempt 失败、人工 rerun 后 success”会被当成自然无人干预的成功观察。GitHub CLI 的 `gh run list`/`gh run view` 都公开 `attempt` 字段，且 `gh run view --attempt` 明确支持查看后续尝试，见 [gh run list](https://cli.github.com/manual/gh_run_list)、[gh run view](https://cli.github.com/manual/gh_run_view) 与 [gh run rerun](https://cli.github.com/manual/gh_run_rerun)。

   建议修复：远端 observation JSON 加 `attempt`，关单只接受 `attempt == 1` 的 completed/success schedule run；某日只有 rerun 才成功则该日仍为 `MISSING/FAILED`，不能靠人工修成自然证据。测试加入 schedule attempt 1 failure + attempt 2 success 的反例。若产品决定“run 创建时的 headSha 即足够、job success 不重要”，则应明确删除 conclusion gate，而不是让人工 rerun 改变判定。

4. **HIGH — C6.1 的 guard/manual-workflow 检查未绑定本次 commit/run，旧的 success 可以让本次发布假绿。**

   为什么重要：plan:206 的 `guard.yml --branch main --limit 1` 没有绑定 plan:203 刚产生的 admin SHA，也没等待对应 run；新 run 尚未出现/仍 queued 时，上一条绿色 run 可被误读为“admin 提交过 CI”。plan:208 触发 workflow_dispatch 后立刻再取 `--limit 1`，同样可能读到旧的手动 success，且没有保存触发返回的 URL/ID或等待完成。plan:207 的默认 `gh workflow list` 输出以 workflow name 为主，判据却搜索文件名；CLI 已提供 `--json id,name,path,state`，应直接断言 path/state。plan:205 的含 `?ref=main` endpoint 也必须在默认 zsh 下引用，否则 `?` 会被当作 glob。

   建议修复：plan:203 后捕获 `admin_sha`；用 `--commit "$admin_sha" --event push --json databaseId,headSha,event,status,conclusion,url` 找唯一 guard run，验证 headSha 后按该 ID bounded wait/watch 到 completed success。workflow list 用 `--json path,state` 精确断言 `.github/workflows/remote-observe.yml`/active。dispatch 前记录时间或现有 IDs，解析本次 `gh workflow run` 返回 URL/ID，再按该 ID验证 event/headSha/createdAt并 bounded wait；不能取“最近一条”。把这些 stale-run 反例加入 checklist 测试。

5. **MEDIUM — “按 UTC 日期分页取满窗口”与所写的固定 `gh run list` 命令不一致，`--days N` 在 20 日以后会静默截断。**

   为什么重要：本机 `gh run list --help` 与官方手册都显示该命令只有 `--limit`（默认 20）和 `--created` 过滤，没有可由调用者控制的 page/cursor flag。plan:168 的固定 argv 两者都没有，却承诺对任意 N “分页取满”。三日关单通常不会撞限额，但公共 CLI 合同 `--days N` 会在 N>20 时把老日期误报为 missing，且实现者没有唯一算法可照做。

   建议修复：固定成逐 UTC 日查询，例如每个 D 调一次同仓/同 workflow/event/branch 命令并加 `--created D --limit <有界上限>`，再本地要求当日至少一个合格 attempt；或明确改用 `gh api --paginate` 的 runs endpoint并固定分页/窗口参数。若产品只需要 3–7 天，直接给 N 上限并测试边界，比声称任意分页更简单。

6. **MEDIUM — `retire-units.sh` 复用了正确的原语，但还没有定义一条可证明幂等的 mutation/crash 状态机。**

   为什么重要：`fly1814_archive_publish` 是先 hard-link archive，再由 `fly1814_source_remove` identity-safe unlink active plist；两步之间被 SIGKILL 会留下 active+archive 同 inode。当前计划只列“archive 失败”和一般幂等，没有规定 rerun 如何识别/完成这个合法的 partial state，也没有写明 mandatory audit 必须发生在第一次 `disable` 之前、audit 后需重新核对 plist/domain/disabled/file identity。现有 `fly1814-cleanup-zombie.sh:81-175,285-378` 为这些边界用了显式 rollback/re-probe，而不仅是调用四个 helper。另一个顺序问题是：若下一步已经 revert PR 删除 source/manifest，单做 `launchctl enable + converge` 不可能“重装”；必须先恢复 source + manifest authority。

   建议修复：在 C5 给出状态表（enabled/disabled × loaded/missing × active/archive absent/same/foreign）与每态动作；规定 audit-success 和 post-audit identity revalidation 是首个 mutation 的前置条件；定义 hard-link 已发布后的 crash recovery和 foreign archive fail-closed。测试补 non-TTY、audit delivery failure 零 mutation、SIGKILL/模拟中断发生在 archive publish 后 source unlink 前。恢复顺序改为“先恢复含 source/manifest 的仓版本，再 enable，再 converge”，并验证 installed bytes。

7. **MEDIUM — `--freeze` 叫“冻结”，但记录的 create-once/时间边界尚未形成合同。**

   为什么重要：plan:169 只说写 `day-D.json`，没有规定已有文件是否拒绝覆盖，也没有要求 `frozen_at` 必须位于 run D 的 `createdAt` 之后、run D+1 创建之前。若同一天或事后可覆盖 expected blob/run_id，验收者可以在看到 D+1 树后重新挑一个恰好变化的文件；两棵远端树仍是真的，但“这是 D 日观察后冻结的待送内容”这一 provenance 不再可证。

   建议修复：`day-D.json` 用 create-if-absent 原子发布，存在即拒绝；freeze 时验证 D 等于当前 UTC 日、run_id_D 是该日合格 natural attempt、其 `createdAt <= frozen_at`，且尚无 D+1 observation。milestone 当天立即记录冻结文件的 SHA-256/完整 JSON或把它作为验收附件，后续 check 只读不得改。测试 late freeze、duplicate overwrite、wrong run/day 全部拒绝。另把可选文件限制为 Contents API 支持的普通 blob（GitHub Contents API 对 >100 MB 文件不支持），或改用 Git Trees API；见 [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)。

8. **LOW — 测试数量与 CI 追加行数仍对不上。**

   为什么重要：§1 说“六套 bash 测试并进 CI”，plan:179 又说追加六条 `test-lead-memory-*` 命令；但文件清单新增的是 sync、arrival-check、freshness-report、observe-workflow、retire 五个独立 test 文件。hooks/bootstrap 是既有且当前已在 `Script Tests 4/4` 注册，manifest test 也已注册，不是第六条新增命令。这个差异会让实施者猜是漏了套件还是数字写错。

   建议修复：把新增/修改/既有但重跑三类分开列清。若 C1 没有独立 common suite而并入 sync suite，就写“新增五条、修改并继续运行 hooks/bootstrap/manifest”；若确实要第六套，补出文件名和职责。

## Verdict

CHANGES REQUESTED — address items above
