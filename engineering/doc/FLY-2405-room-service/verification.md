# FLY-2405 起房服务 — 实现验证
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405)
日期: 2026-09-26
基于: plan.md、design-correction.md

## 实现与验证边界

C1–C8 按已批准设计实现：归属锁、拆房修复、持久化操作/审计、受信 job 包装器、Bridge API/reconciliation、room CLI、告警值守房、沙箱外固定 generalized drill，以及两类 runner 指引。managed `qa_room_service` flag 按 Lead 裁定接入。生产默认 on；隔离默认 off，TEST_ opt-in 仍受 store off 约束。

合并 `d52df7841` 和 `fdd1b404d` 后，在独立 checkout `e4fe21c5d` 安装锁定依赖并构建。`verification-results.json` 保存逐命令结果、日志路径、当前源码 SHA256 和重试历史；全部生产源码与该测试 checkout 相同。唯一后续测试变更 `661092c64` 修复 C7 fixture 的 Bash 3 空数组 nounset，并在共享分支单独验证。`verification-consumers.json` 保存搜索输入、命中、保留项及逐项排除理由。

## 当前源码的局部结果

- 按 Lead 收窄范围执行 28 个具体 TypeScript 文件：976 tests 全部通过。event-route、close-runner、bridge 各一次完整文件重试共 234 tests 通过，保留原门限和断言。没有把首次失败与重试重复计数。
- 同步后另 7 个具体 teamlead 文件：149 tests 通过，涵盖 StateStore 迁移/执行/房间、接管、终止与 issue 读取。合计 35 个不同 teamlead 文件、1,125 tests 通过。
- 同步后 config related：21 文件/386 tests；comm：1 文件/97 tests；edge-worker related：29 文件/356 tests；kill-path inventory：1 文件/5 tests，均通过。这些是局部验证，不能称为全套。
- 41 条限定命令已结束，包含上述 28 个 TS 文件、12 个 shell 文件和 1 个 Node 文件。Bash 3 下两个 shell 失败分别记录纠正结果：C7 fixture 修复后 9 组通过；上游 launchd fixture 的 Bash 3 解析错误保持源码不动，使用 Bash 5 验证，61 项通过。其余起房、拆房、claim、slot、generalized、multilead 和 launch boundary 命令通过。
- 受影响包及依赖 build（17 projects）、config/teamlead/comm 下游 typecheck（12 projects）、`pnpm lint` 通过；lint 为 25 条既有 warning。最终提交的 package smoke 单独核验源码 HEAD 与构建身份，其结果由 PR 与 registered handoff 承载。

## 被撤销的宽范围运行

Lead question `298915b0-fccc-4d03-92ed-e60fefb65b26` 裁定：原 StateStore/plugin related（4 workers，约 1h50m）实际上接近整包范围，在主机高负载时被 Lead SIGTERM。包装器返回 0 但没有最终报告，观察到的 426 文件/7,807 tests/11 failures **不作为验证证据**。未报告文件的恢复队列已撤销，不再运行该 related 或补齐其传递依赖。

后续按 Lead 指令，仅已改测试及直接导入变更模块的具体文件，每次一个、串行执行；超时文件至多重跑一次，再超时则记录 load-timeout。旧的广泛图谱及同步前守卫结果仅保留历史，不混入上面的当前源码统计。此裁定没有冻结当前 HEAD，不请求 full CI。

## 已知限制

- `audit-discord-mailbox-ingest.test.sh` 期待 protocolVersion 2，但 merge-base `af853328d33b2e3cb7ad812f537bac8ced499b34` 的 CLI 已返回 3；当前同样不一致。精确行号与输入在 `verification-baseline.json`，没有顺手更改协议或守卫。
- `fly2655-voice-room.test.mjs` 两项 live-daemon 测试在进程探测先收到 `ps EPERM`，未进入产品断言。没有用 mock 替代真实探测，也没有放松断言。
- `tmux-viewer.macos.test.ts` 依赖真实 macOS GUI/进程能力，本轮未作该能力的验收。
- 当前证据不代表 effective review、CI OK、QA pass、生产证明或 ship；最终 review/PR/route 需绑定同一个提交。

## QA 接续与回退

QA 使用最终 origin head，由 Codex 与 Claude 各自只经 `room deploy|drill|status|teardown` 完成真起房、房内验证和零残留。验证陌生 owner/生产 label 拒绝审计、同 issue 终止后接管、负载队列、快照失败与显式跳过、C7 实际告警值守座位，按 plan §17 保存真实证据。当前 fixture 通过不等于 launchd/Discord 实测通过。

部署由独立 ship/updater 流程负责。回退使用 `node "$FLYWHEEL_COMM_CLI" feature-flags set --name qa_room_service --to off --reason "FLY-2405 rollback"`，下一次 admission/launch 边界生效，既有 job 安全收敛；恢复使用 `--to on`。不修改生产 `.env`。
