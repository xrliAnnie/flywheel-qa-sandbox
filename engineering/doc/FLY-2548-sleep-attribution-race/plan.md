# FLY-2548 sleep 子进程归因 — 实施计划
Issue: FLY-2548 (https://linear.app/geoforge3d/issue/FLY-2548/flake-bridge-event-loop-guardtestts540-sigkill-子进程归因在-ci-teamlead3)
日期: 2026-09-14
基于: research.md

## 锁定设计
只修改目标测试/夹具/清理与本 issue 文档。保留生产 LOOP_GUARD_WORKER_SOURCE 字节、testMode=false、200ms stall 阈值、tick_gap < 200、SIGKILL/null exit 和 child attribution。

## 步骤
1. RED：在临时夹具或测试中令 spawnSync 启动一个 node 子进程，在 exec 到 /bin/sleep 前受控延迟超过 200ms；保留原守卫启动顺序与 sleep 断言，必须得到 comm=node 断言红。记录命令、注入方式和原始输出。不能以自然隔离绿冒充红。
2. GREEN：guard 的测试侧 bootstrap 在有界时间内用真实 /bin/ps 观察 ppid=harness PID 且 basename(comm)=sleep 的直接子进程，记录 PID，刷新 SAB 后才执行原样生产 worker source。主线程继续真实 spawnSync。sleep 保持足够长以覆盖取证，最终由测试清理。ps 不可用路径保留原 unknown/null 断言。握手超时或 spawn 错误必须显式失败。
3. 加强取证匹配到已观测 sleep PID，保留 comm=sleep；失败/超时/成功路径均清理 harness、睡眠子进程和临时目录，使用独立测试进程组避免对兄弟 worker 发信号。延迟启动用例按最终 CI Node 能力实现，禁止新增 skip。
4. 同一用例本地连续 20 次全绿，记录逐次计数；全目标文件绿；执行 pnpm lint、pnpm -r build、pnpm test:packages:run，以及任何新增 shell test。宿主 onTaskUpdate/超时红保留回执与隔离证据，不包装为全绿。
5. 台账、所有证据文档及 engineering/doc/milestones/FLY-2548.md 在最后代码提交同推；创建 PR 后冻结 head，按注入 gate/request-review 流程取得 effective APPROVED。任何阻断修复需新 head、新 review。review 后不推文档。
6. 最终精确 head 的相关 CI 分片连续两次全绿：第一次正常 CI 后重跑该 job/工作流获得第二次，关联 head SHA 和 attempt/job ID；不沿用祖先绿。同形零 diff+唯一该断言红+隔离绿时最多一次 failed rerun，保留红回执。
7. ask --report 汇报所有门的真实状态；complete --route needs_review --pr NUMBER；不派 QA、不合并、不部署，随后按 phase keep-alive park。

## 评审状态
effective APPROVED / reviewer APPROVED，question 1f812107-8658-4f85-9f3e-f9386a86a4db，request 503f0d10-9a94-47a8-a93b-df3dfce2cdac，round 1。MEDIUM/LOW advisories 已报 Lead，非阻断。

## 已批准范围内的落实细节
- psAvailable=false 时不等待 ps 握手，沿用原先启动顺序及 unknown/null 断言；该分支不计归因证据。
- 真实 ps 握手预算 4s，每次 ps 上限 1s；sleep 30s；生产 guard 保留 200ms 阈值及默认 5s grace/2s forensic ps；测试自有 12s deadline 先于 Vitest 15s 限制，统一清理 detached 测试进程组。tick_gap<200 保留，宿主长期饥饿造成该断言红仍是未消除的独立风险。
- bootstrap 使用 nested new Worker(source,{eval:true,workerData}) 执行源字符串原样副本，保持 CommonJS require/workerData 作用域；不拼接修改生产字符串。此用例验证已进入 spawnSync 阻塞后的 kill；从健康状态转冻结的真实进程路径仍由 SIGSTOP/SIGCONT 用例覆盖。
- Lead e6466c8d-7c0c-490d-a37b-68b5e4345b79 裁定 host RED/20 GREEN 由 QA 执行，实现方交付探针及沙箱隔离绿、最终相关 CI 分片两次绿。
- 最终头若目标 sleep 归因断言红，判定修复未通过并返工，不用 rerun 掩盖。原零 diff 处置模板仅用于未修改目标断言的外部案例。
- 宿主全仓补充运行按包串行、每包最多 2 worker，明确排除 **/tmux-viewer.macos.test.ts；构建与全仓测试不并发。原要求的 pnpm test:packages:run 已运行并保留基线超时红。
