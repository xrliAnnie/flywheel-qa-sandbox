# FLY-2546 SIGTERM 测试同步 — 验证记录
Issue: FLY-2546 (https://linear.app/geoforge3d/issue/FLY-2546/flake-flywheel-log-janitortestsh-sigterm-契约在-ci-shell2-间歇红sent1)
日期: 2026-09-14
基于: plan.md

## 修前证据

- 基线 `14866f7e5`，生产脚本和测试尚未编辑时，`bash scripts/__tests__/flywheel-log-janitor.test.sh > /tmp/FLY-2546-baseline.log 2>&1` 返回 0：40 passed / 0 failed。
- 历史 CI 首次红：`XDG_CACHE_HOME=/tmp/FLY-2546-gh-cache gh run view 34807851299 --attempt 1 --log-failed`。2026-09-14T05:11:53Z SIGTERM `sent=1 rc=0`；05:12:01Z 总计 39 passed / 1 failed。日志 `/tmp/FLY-2546-ci-original-red.log`。
- `git diff cf4b68837 e6ebca81c -- scripts/flywheel-log-janitor.sh scripts/__tests__/flywheel-log-janitor.test.sh` 输出为空；run 当前重跑结论 success，shell2 job 103866193186 success，head cf4b68837308d319bf5146270350171f49dbc655。
- 本地调度注入 RED：从基线测试提取 setup/run_janitor 和完整 SIGTERM 块（不执行无关用例），将 REPO_ROOT 指向本 checkout；仅把发送者的 `/bin/sleep 0.05` 换为 `while [[ -d "$STATE_DIR/lock.d" ]]; do /bin/sleep 0.01; done`。这模拟发送者观察 PID 后未及时获调度，至进程完成才继续；断言不变。`bash /tmp/FLY-2546-red-delayed-sender.sh > /tmp/FLY-2546-red-delayed-sender.log 2>&1` 返回 1：0 passed / 1 failed，SIGTERM sent=0 rc=0。此为显式调度实验，非声称原始未修改测试自然复现 sent=1。
- 另一个诊断实验通过临时 rm 夹具阻塞 EXIT 清理并在此发 TERM，结果 sent=1 rc=143、锁未释放；它不是原始 CI 症状，不作为相同症状复现证明。临时脚本 `/tmp/FLY-2546-red-exit-window.sh` 和日志均保留。此证据支持必须在工作阶段而非 EXIT 阶段同步。

## 仓库门禁（修前）

- `pnpm install --frozen-lockfile` exit 0（缺 dist bin 的安装告警，随后构建补齐）。
- `pnpm lint` 输出 Checked 3572 files，No fixes applied，18 warnings；无 error。
- `pnpm -r build` exit 0。
- `pnpm test:packages:run` exit 1，flywheel-comm 3 failed / 2536 passed / 3 skipped：lead-registry-cli、dependency、qa-result-lock 各一个 5000ms timeout。递归命令首错退出，未执行包不冒充通过。日志 `/tmp/FLY-2546-packages.log`。
- 三文件隔离命令：`pnpm --filter flywheel-comm exec vitest run src/__tests__/lead-registry-cli.test.ts src/commands/__tests__/dependency.test.ts src/commands/__tests__/qa-result-lock.test.ts`；exit 0，3 files / 78 tests passed，11.74s。日志 `/tmp/FLY-2546-packages-isolated.log`。

## 后续验收

修后连续 20 次、精确头 CI shell2 两次、有效 code review 尚待执行。冻结前更新此文件；review 后不再推文档，后续权威回执写入 PR body 和 completion handoff。

## 同步修复与负向验证

- 仅 SIGTERM 测试块改动：一个过期候选、现有 LSOF_BIN seam 的 ready/release 握手；发送 TERM 后放行命令替换，保持 sent=1、rc=143、锁不存在，并拒绝夹具 timeout。
- 临时抽取用例 `/tmp/FLY-2546-green-isolated.sh`：PATH Bash 和 `JANITOR_TEST_SHELL=/bin/bash` 均 exit 0，1 passed / 0 failed。
- `/tmp/FLY-2546-test-exit-zero.sh` 将生产脚本临时副本 TERM trap 改为 exit 0；`/tmp/FLY-2546-test-continue.sh` 改为仅 release_lock 后继续。二者均 exit 1，ready=1 sent=1 rc=0，严格断言抓错。生产文件未修改。
- `bash -n`、`shellcheck scripts/__tests__/flywheel-log-janitor.test.sh`、`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`、`bash scripts/__tests__/ci-structure.test.sh` 均 exit 0。ShellCheck 对仅由 EXIT trap 调用的函数 SC2329 有局部说明性抑制，不涉及测试断言。
- 第一次完整修后运行中的 SIGTERM 通过，但执行者在该 Bash 仍读脚本时增加注释，导致后续输入偏移、解析错误 exit 2；此轮作废，保留 `/tmp/FLY-2546-green-full-first.log`，不计入连续绿。随后冻结 shell 文件启动 `/tmp/FLY-2546-run20.sh`，每轮完整套件顺序执行、首错退出，逐轮日志与计数在 `/tmp/FLY-2546-green20/`。

## 冻结头时验证状态

连续完整套件第 1 轮 exit 0：40 passed / 0 failed；后续 19 轮运行中。代码与本目录文档同推后，运行命令不再修改工作树；最终 20/20 计数、精确头 shell2 两次 CI 和 code-review gate 回执以 PR body 与 flywheel-comm report 为权威补充，不在 review 后另推文档。若代码返工则新头重新验证和 review，不复用旧头结论。

复跑命令（每轮日志保留，首错即停）：

```bash
for i in $(seq 1 20); do
  bash scripts/__tests__/flywheel-log-janitor.test.sh > "/tmp/FLY-2546-green20/run-$i.log" 2>&1
  rc=$?
  printf 'run=%s rc=%s\n' "$i" "$rc"
  [ "$rc" -eq 0 ] || exit "$rc"
done
```

## 完整 20 轮与清单夹具返工

2026-09-14 09:35Z，串行进程 exit 0；`/tmp/FLY-2546-green20/counts.log` 含 run=1..20，全部 rc=0，每轮 40 passed / 0 failed，总计 800 条通过。运行期间 shell 文件字节冻结。上节 1/20 是较早冻结快照，现已被本回执取代。

首个精确头 ec98ce7fc 的 code review（request 0692607a-fe75-40fa-a934-149e42242991）APPROVED，附非阻塞建议已报告 Lead：迭代预算并非墙钟秒数；watchdog 极早中断的 trap 安装窗口；最终回执需同步 PR body。不把这些建议扩展为生产改动。

该头 CI run 34827996888 的 Unit (heavy) job 103924570841 红：kill-path-inventory 期望 676 项、实扫 677 项。差异仅是本测试 watchdog 的两条 qa-only kill 替代原先一条，属于本次遗漏的清单夹具同步，并非 flake。`pnpm --filter flywheel-claude-runner exec vitest run test/kill-path-inventory.test.ts` 本地先红（1 failed / 4 passed），按现有 scanner 重新生成 `packages/claude-runner/test/fixtures/kill-path-inventory.json` 后 5/5 绿。JSON 差异 8 增/2 删，仅对应本用例，分类仍 qa-only。

返工不改变 shell 测试或生产字节，因此 20 轮结果仍覆盖最终 shell 内容。返工后的新精确头需新 code review 及 shell2 连续两次 CI 绿；旧头 review/CI 不代替新头门禁。此文档和里程碑与夹具同一次 push，后续不另推文档。

## 清单并发集成约定

与 FLY-2548（PR #1189）共改 packages/claude-runner/test/fixtures/kill-path-inventory.json；本单仅登记自己的测试清理路径。后合者需同步 main、重登记并在新精确头重新验证/review。现在不互相合分支，等待 Lead 的明确返工令。
