# FLY-2546 SIGTERM 测试同步 — 实施计划
Issue: FLY-2546 (https://linear.app/geoforge3d/issue/FLY-2546/flake-flywheel-log-janitortestsh-sigterm-契约在-ci-shell2-间歇红sent1)
日期: 2026-09-14
基于: research.md

## 锁定方案
执行方式：本 implement 节点独立执行，经注入的 design/code review 门审核，不分派后继。

### 1. RED 与同步夹具
- 运行原始 bash scripts/__tests__/flywheel-log-janitor.test.sh，保存返回码和日志。必要时在 /tmp 提取 setup/run_janitor/SIGTERM 原块，注入发送者调度延迟以证明原等待策略允许完成竞态，保留实验脚本和差异。
- 仅在 SIGTERM 测试块创建一个过期候选和 lsof 夹具。夹具以自身绝对路径派生 ready/release 文件，使用 /bin/sleep 有界短轮询；超时退出非正常码。
- 配置 JANITOR_TEST_LSOF_BIN 启动真实 janitor，等待 ready 和合法 lock PID（有界轮询）；只有 ready 后才发 TERM，之后无论成功与否均写 release，解除命令替换等待。
- 保留 signal_sent=1、signal_rc=143、lock.d 不存在三项断言，并加入 ready 条件；未 ready / signal 失败 / 超时必须失败。
- 有界 watchdog 覆盖异常路径，取消并 wait 回收；退出清理解除夹具等待并回收该用例进程。恢复注入变量，避免影响其他用例。

### 2. GREEN 与验证
- bash -n scripts/__tests__/flywheel-log-janitor.test.sh。
- for i in $(seq 1 20); do bash scripts/__tests__/flywheel-log-janitor.test.sh > /tmp/FLY-2546-green-$i.log 2>&1 || exit 1; done；保存每次返回码和总计 20/20。
- pnpm install --frozen-lockfile，然后 pnpm lint、pnpm -r build、pnpm test:packages:run，日志分别保存；新 scripts/__tests__/*.test.sh 如有全部运行。
- 已知宿主 onTaskUpdate/超时保留红并针对失败项隔离验证，不能声称全量绿；其他失败调查与基线对比。
- git diff 检查仅测试与任务文档变动；在 /tmp 实验副本中将 TERM trap 改为 exit 0 或 release_lock 后继续，必须失败；删除 trap 的默认信号退出与契约等价，不作为负向判据。

### 3. 冻结头与交接
- 每批 flywheel-comm progress 更新并回读；所有台账与 engineering/doc/milestones/FLY-2546.md 在最后代码提交同推，里程碑位于 literal last commit。
- push、创建 PR，注入 stage code_review、gate review_code、request-review；等待有效 reviewVerdict APPROVED，修复阻塞项时新头新 review。报告 advisories。
- 同一精确头 shell2 首次 CI 绿后重跑该相关 job，再次绿；记录 run/job/attempt/head。零 diff 且仅 SIGTERM 红按一次 rerun，保留红；再次红本地隔离一次。
- review 后不推文档；后续 CI/review 回执放 PR body 与结构化 report/handoff，避免移动头。
- 按注入身份 ask --report，complete --route needs_review --pr NUMBER；不 merge、不派 QA。阶段完成后 park，保持 issue goal。

## 设计门回执

2026-09-14，request c4b12b4e-2c0a-47bf-abdd-0b88a887550a，reviewVerdict=APPROVED。按非阻塞建议明确 ready 10s < fixture 30s < watchdog 60s；先 release 再 wait、最后清理。sent=1 rc=0 与 EXIT teardown 窗口相符，但机制仍为推断。保留生产 Bash 临时隔离验证。mandatory full package 命令已跑并保留超时红/隔离绿；不为测试夹具变化重复触发 Terminal.app 测试。
