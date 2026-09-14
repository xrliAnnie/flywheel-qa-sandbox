# FLY-2543 CI 清理竞态 — 验证记录
Issue: FLY-2543 (https://linear.app/geoforge3d/issue/FLY-2543/flake-ci-classifytestsh-收尾-rm-竞态git-directory-not-empty让-shell3-在-1440)
日期: 2026-09-14
基于: plan.md

范围只有 scripts/__tests__/ci-classify.test.sh 及本 issue 文档。原 144 项断言未改；增加 4 个退出清理组合与 2 个本仓配置断言，共 150 项。

## 先红后绿

- 原脚本自然 baseline：144/0，exit 0；本机未自然复现竞态。
- 原脚本外部故障注入：144/0 后 rm ENOTEMPTY，exit 1。
- 原 trap + 新回归：146 passed / 4 failed，exit 1。清理成功时 0/42 保留；失败时两者变 1；两个配置不存在。
- 修后完整脚本外部注入：150/0，rm ENOTEMPTY 后打印 warning，exit 0。
- 两种原退出码 0/42 × rm 成功/失败均由现有 suite 验证。

日志在 /tmp/fly2543-evidence/{baseline,red-cleanup,regression-red-corrected,green-injected}.log。
regression-red.log 是测试条件修正时受到运行中文件编辑影响的无效试跑（exit127），不作为红证据；有效红证据是 regression-red-corrected.log。

外部注入：PATH 前置以下 rm shim；只拦截带 repo/.git 的夹具根目录，调用真实 rm 后返回失败，避免故意遗留夹具。这是确定性注入，不伪称自然并发复现。

```bash
mkdir -p /tmp/fly2543-evidence/bin
cat > /tmp/fly2543-evidence/bin/rm <<'EOF'
#!/usr/bin/env bash
if [[ "$#" == 2 && "$1" == -rf && -d "$2/repo/.git" ]]; then
  printf 'rm: cannot remove %s/repo/.git: Directory not empty (injected)\n' "$2" >&2
  /bin/rm -rf "$2"
  exit 1
fi
exec /bin/rm "$@"
EOF
chmod +x /tmp/fly2543-evidence/bin/rm
PATH="/tmp/fly2543-evidence/bin:$PATH" bash scripts/__tests__/ci-classify.test.sh
```

## 连续循环

冻结提交时已完成 5/20，全部 150/0、exit 0，循环仍在运行。最终 20/20 计数及进程退出回执须在代码评审/交接前补入 PR 和结构化 handoff；不以部分计数声明达标，也不为补记结果移动评审头。每轮完整执行 150 项，遇到失败立即终止：

```bash
for iteration in {1..20}; do
  bash scripts/__tests__/ci-classify.test.sh > "/tmp/fly2543-evidence/green-$iteration.log" 2>&1
  result=$?
  summary=$(tail -1 "/tmp/fly2543-evidence/green-$iteration.log")
  printf "iteration=%s exit=%s %s\n" "$iteration" "$result" "$summary" | tee -a /tmp/fly2543-evidence/green-counts.log
  if [ "$result" -ne 0 ] || [ "$summary" != "Passed: 150  Failed: 0" ]; then exit 1; fi
done
```

## 仓库 gates

- pnpm install --frozen-lockfile：exit 0。
- pnpm lint：exit 0，18 warnings；没有自动修复。
- pnpm -r build：exit 0。
- bash -n scripts/__tests__/ci-classify.test.sh：exit 0。
- bash scripts/__tests__/ci-shell-suite-enumeration.test.sh：exit 0，315 shell suites 分类、54 Node suites 登记通过。
- pnpm test:packages:run：修改脚本前即 exit 1；config 包 823 passed / 2 failed，加 1 unhandled error。失败为 runner-config-writer symlink EEXIST、fly1981-final-ledgers 15000ms timeout、[vitest-worker]: Timeout calling "onTaskUpdate"。聚合未全绿。
- pnpm --filter flywheel-config exec vitest run src/__tests__/runner-config-writer.test.ts src/__tests__/fly1981-final-ledgers.test.ts：32/32，exit 0。focused 绿不覆盖聚合红。
- Lead disposition question：b17aeb9b-ced1-4ffc-a563-7df36d17aef1，待答复。后续状态由结构化回执传递。

## 精确头 CI 与交接

最终代码与本记录、progress、milestone 一起推送后冻结头。代码 review 与精确头 shell3 连续两次结果通过 PR 和结构化 handoff 记录，本文件不预写通过。评审后不追加文档提交。无 QA 派发、merge 或部署。

同形处置仅适用于断言全绿且唯一失败为退出 rm 竞态：保留红回执，一次 rerun，以 CI 为准；其它失败不可套用。
