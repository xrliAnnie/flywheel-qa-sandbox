# FLY-2405 起房服务 — 实现验证
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405)
日期: 2026-09-26
基于: plan.md、design-correction.md

## 变更与证据边界

C1–C8 按已批准设计实现：服务归属锁、拆房坑修复、持久化操作/审计、受信 job 包装器、Bridge API/reconciliation、room CLI、告警值守房、沙箱外 generalized drill，以及两类 runner 的统一使用指引。新增 managed flag 按 Lead 裁定处理。`011dc7772` 为代码检查点，不是 frozen handoff head。

验证只使用 owning-package `vitest related`、显式消费者/仓库守卫及受影响依赖构建。没有执行本地整包 suite，也没有请求 full CI。所有搜索输入、原始命中路径、保留项和逐路径排除原因保存在 `verification-consumers.json`（含 flag-store 增量发现）。FFI/native/process fixture 的通过不等于真实 launchd/Discord 验收。

## 已取得的局部结果

- drill 与生命周期核心：74 tests（contract 26、runtime 14、service 34）；覆盖原始 driver exit/outcome、精确 operation 等待、失败拷贝、teardown/await 竞态、残留进程组、开关在异步期间关闭后不启动以及重开续跑。
- flag-store/wiring/管理路由：73 tests；现有 stage/apply round-trip 自动覆盖新 `qa_room_service`，隔离 TEST_ opt-in 不能覆盖 store off。
- config owning `related`：382 tests 中原有精确 registry/readSite 两项需要新增条目；补齐后对应两文件 70 tests 通过。未修改任何守卫豁免或历史 OFF 合同。
- CLI：97 tests；退出码 0/4/1/2/3、超时续等、选定 operation、传输/服务错误及 credential path 与 raw token 的区别。
- QA 指引直接消费者：edge-worker 初次 related 的 352 tests 中 6 项旧文案断言失败；保留历史基线并追加精确迁移后，三文件 55 tests 通过。N-to-N shell 守卫 29 项通过，精确 prompt 字节门限保留。
- 进程操作清单：5 tests；生产 Bridge 内 room runtime 明确登记为 runner-affecting bounded child mutation，固定 job owner、lstart、PGID 与 TERM/KILL 边界；没有按 qa- 文件名豁免。
- 显式保留的额外 TS 消费者：runner adapter 两文件 353、strength-two contract 24、StateStore evidence/phase compatibility 两文件 15，共 392 tests 通过。
- shell fixture 对齐后：restart watcher 20、fly1389 29、launch boundary 9 全绿；依赖补建后 fly1697 18、fly2867 4 全绿。
- 新增 flag 消费者：flag provenance / retirement / renderer 42 tests，truth/freeze shell 43 项通过。
- 受影响包及依赖 build、所有 config/teamlead/comm 下游 typecheck、`pnpm lint` 已通过（lint 保留 25 条既有 warning）。

## 环境/基线限制（不计作产品绿灯）

- `audit-discord-mailbox-ingest.test.sh:30` 仍期待 protocolVersion 2；merge-base `af853328d33b2e3cb7ad812f537bac8ced499b34` 的 CLI 已在 `index.ts:884` 返回 3。本次没有更改该协议或测试；此为可重现基线不一致。
- `fly2655-voice-room.test.mjs` 两项 live-daemon 测试在 `fly2867LiveDaemon` 调 `ps` 时先收到 EPERM，`stdout` 为 undefined，尚未进入产品断言。未将真实进程探测替换为 mock 或放松断言。
- `tmux-viewer.macos.test.ts` 为真实 macOS GUI/进程测试，在 owning related 命令中显式排除；本轮没有该能力的验收证据。
- 打包 smoke 绑定源码 HEAD 与构建身份；提交移动后必须在最终 head 重建身份再跑，不复用旧 SHA 的成功。

## 技术同步与后续复核

Draft PR #1363 与 main 的冲突在隔离工作树解决：`67123bebe` 合并 `d52df7841`，保持六房位配置、上游 Codex teardown disposer 与本单 room stop/marker 行为。随后 `3ed89bb44` 合并 `fdd1b404d` 的 FLY-2934 上游清理，删除其已退休的冗余整数计数断言，完整 flag 名称/文案相等与 authoring/readSite 守卫继续保留。

flag runtime 补充 related 实际完成 76 文件、920 tests：917 通过、2 超时、1 skip；请求的重叠路径排除在 workspace projects 中没有全部生效，不将这次执行称为仅 8 文件或 175 文件。两项超时与主 related 的五项超时一起，用原默认 5 秒门限精确重跑 7 cases / 5 files，全部通过；没有改超时或产品断言。

基线/沙箱限制的可复核输入见 `verification-baseline.json`。合并后的新消费者与准确父提交已追加到消费者 artifact；合并后验证不能沿用旧源码的成功作为新字节的证明。

## 收尾检查

本页为创建 PR 前的局部证据快照。StateStore/plugin owning related 选择 590 文件，flag runtime related 另有 8 个未重叠消费者；创建 PR 时仍在收尾，具体最终结果、重跑记录、effective review 与 HEAD 绑定由 PR 正文及 implement handoff 报告承载。本页不声称 CI OK、QA pass、生产证明或已 ship。

## QA 接续

使用最终 origin head；先外层服务测试房，再由 Codex 与 Claude 各自只经 `room deploy|drill|status|teardown` 完成真验证和零残留。验证陌生 owner/生产 label 拒绝审计、同 issue 终止后接管、负载队列、快照失败与显式跳过、C7 实际告警值守座位。按 plan §17 保留完整真实证据。

部署由独立 ship/updater 流程负责。回退使用 `node "$FLYWHEEL_COMM_CLI" feature-flags set --name qa_room_service --to off --reason "FLY-2405 rollback"`，下一次 admission/launch 边界生效，既有 job 仍做安全收敛；恢复使用 `--to on`。不修改生产 `.env`。
