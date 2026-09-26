# FLY-2906 强度二返工 — 验证记录
Issue: FLY-2906 (https://linear.app/geoforge3d/issue/FLY-2906)
日期: 2026-09-26
基于: Lead 最新 06:0xZ 返工说明与 QA attempt 2 报告

本执行 e993d431-1723-409a-a247-6c035c08a027 在 TURN epoch 11 上继续 PR #1339。
继承头 7c38922c73a4ddc242351e89f7180be4b54fb374；无冲突合入
origin/main dcc7142e24cdf64bf4ba58260c6509a34a14cc16，包含 FLY-2907 #1345。
实测 git ls-files 输出 1,048,938 bytes，仍略大于 1 MiB；没有把“低于 1 MiB”当通过证据，
采用已合入的 FLY-2907 buffer 修复。全量 CI 由 QA 请求。

Lead 对 question f57727c4-37e2-4513-bce2-336cc03c8ef9 明确：
本单原为 simple_code、没有设计节点或 plan；仅按最新两条返工执行，无需重做设计。

## 变更与红绿证据

- Step 2 使用与 Step 4 相同的 nodeStandbyResumeEnabledAtStart。
  开时仅接受 resumable_standby，关时仅接受 completed_unenrolled；
  未知 flag、跨开关形状以及已有未完成 guards 全部 fail closed。
  红测实际返回 completed_unenrolled 而预期 null；修复后通过。
- stub design / implement complete 先 inbox + check；仅在服务端
  consume_pending_mail challenge 后重新读信、验证 TURN、读取指定本执行体 phase-wake 内容，
  将内容落入 stub-state，再通过现有 CommDB.claimRunnerPhaseWakeStart 签收，
  带同一 challenge 重试原参数一次。无 SQL 手改账，不替其他执行体 ACK；
  非 drain 拒绝、缺失/非法 challenge、消费失败、丢 TURN、receipt 再次拒绝都失败退出。
  红测验证旧库无处理函数；绿测包括真实内存 CommDB 的 deferred_midturn 唤醒，
  同 message id 的其他执行体保持 pending，重复签收安全。

## 本机相关验证

- node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs：50/50。
- node --test scripts/__tests__/qa-generalized-codex-stub.test.mjs：3/3。
- bash scripts/__tests__/test-deploy-generalized.test.sh：第二次 exit 0。
  第一次仅已有 detached process-group 回收用例失败：lsof-socket 2003ms 超时，
  outcome=unverifiable；保留第一次失败，未修改该回收逻辑或测试。
- bash scripts/__tests__/fly2045-milestone-layout.test.sh：32/32。
- pnpm lint：exit 0，25 warnings，无 error。
- pnpm --filter "flywheel-claude-runner..." build：六包依赖链通过。
  第一次 preflight 缺 node_modules；pnpm install --frozen-lockfile 后构建成功，无 lockfile 变化。
- 改动 JS 的 Biome 检查和 git diff --check：通过。
- 无 TypeScript 改动，无依赖方 typecheck / vitest related；未跑本地全包套件。
- 新测试放入原有 helper suite，沿用现有 CI 注册。

## 消费方检查

逐改动路径运行 git grep -lF，分别查 full path、basename、parent directory。
完整逐匹配处置清单 /tmp/FLY-2906-consumer-audit.tsv（9632 行匹配）。
保留并运行 helper、generalized shell、Codex stub 及 milestone 测试。
排除项逐行写入该清单，理由分类：
历史 engineering/doc、doc 引用不执行代码；
.github/workflows/ci.yml 及历史 CI manifest 是未变注册；
kill-path-inventory.json 仅枚举既有命令路径；
strength-two-contract 及其测试、test-auto-approve-identity、test-deploy-qa-room、
inject-linear-issue、test-deploy.sh 只消费未变 CLI/部署/证据路径；
workflow-template-selection.test.ts、qa-fly-2519-529-drill.mjs、
qa-fly-2533-phase-protocol.mjs 只导入未变 helper exports。
其余 parent-directory 字面命中不依赖改动的 classifier 或 completion helpers，排除。

原始日志在 /tmp/FLY-2906-{design-red,stub-red,helper-green,node-green,shell,shell-retry,build,lint,milestone}.log。
这些是相关本地证据，不能替代 QA 真房或 exact-head full CI。
QA 按最新派单复验两条失败项并跑冻结头全量 CI；其他已通过项保留。

## 08:1xZ QA step 6 返工（执行 9fc46822）

最新返工仅修 Step 6；无冲突 merge origin/main
eabcd72a5ab758aa389b71fc67a50731bfe03fcd。Step 2 的 run-start flag、
Step 4 生命周期、stub drain 签收均保持原行为。

根因：查询 latest authority=qa 并仅接受 wake_delivered，
但 qa_fail 请求交卷事务中隐含签收后直接 completed；随后
implement -> qa 复验请求 awaiting_receipt 遮住原请求。
现先用 run + QA attempt 1 + qa_fail + 已放行的 QA execution
唯一确定 request_id，后续始终按该 ID 读取 delivery；
接受 wake_delivered 或 completed，且必须有同 run、同 request_id 的
rework_delivery_wake_delivered 事件。保留 active 与 dangerous-rework guards。
Step 6 evidence 同时记录 delivery 和 wakeEvent。

Lead 对 question 302407d7-188d-44f2-be24-f2bcf78ee093 确认 QA 未冻结 DB，
slot 3 已拆除，授权根据归档报告、step-1..5.json 与 stub-state 构造
**合成 SQLite 行集**。这不是原房冻结行集或真房通过证据。
fixture 的 run/request/execution ID 来自
~/.flywheel/qa-evidence/FLY-2906-qa-d287/slot3-20260926T0755Z/，
时序和必要列按归档重建；在同一事务内写入 wake receipt、completed、
后继 awaiting_receipt。测试执行驱动本身的 Step 6 SQL/poll block。

- 红：旧驱动的 completed 与 wake_delivered 两种正向均超时 last=false。
- 绿：helper 53/53；两种终态通过，12 个负向变体拒绝：
  缺事件、其他 request/run/kind、awaiting_receipt/held/needs_lead、
  run held、危险返工行、错误 attempt/execution/outcome。
- generalized shell 通过；六包 claude-runner 依赖链 build 通过。
- pnpm lint exit 0（25 warnings）；改动文件 Biome、node --check、
  git diff --check 通过。
- 消费方 sweep 时间 2026-09-26T08:25:31Z：full path、basename、
  parent directory 逐项 git grep -lF，4461 匹配逐行处置：
  /tmp/FLY-2906-step6-consumer-audit.tsv。保留 helper 和 generalized shell；
  文档/历史制品、CI 注册、未变的 CLI/部署/identity/exit-evidence 消费方、
  不依赖 Step 6 的 parent-directory 字面引用逐行排除。
- 无 TS/类型/API 导出变更，无 vitest related 或依赖方 typecheck；
  未跑本地全包测试、未起房、未请求 full CI。

日志：/tmp/FLY-2906-step6-{red,green,shell,build,lint}.log。
下一轮 QA 负责默认关闭开关的真房全程 exit 0（含 Step 7+）、
record satisfied 与冻结头 full CI；实现阶段不提前声称这些验收已通过。

### 同头 CI 登记修复

Quick Gate 36229797484 在 7c7c8cd56 报
unclassified_retention_consumer:scripts/qa-529-generalized-e2e.mjs:workflow_run_event:read。
这是新增 Step 6 SQL 缺失 consumer 登记。本地同 gate 复现红；
仅补该 read 为 protect（活动 run 的 wake receipt 是驱动决策证据），
不改扫描器、retention 算法或其他登记。gate 绿、相关登记测试 10/10、
配置 Biome 与 diff check 通过；新增配置消费方 sweep 已追加同 TSV。
旧头 CI/复审均不作为新头证据，新头重新请求复审和 scoped CI。
