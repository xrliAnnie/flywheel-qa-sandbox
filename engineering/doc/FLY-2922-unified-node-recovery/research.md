# FLY-2922 当前头、合并合同与 QA@4 证据面 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: exploration.md

本文件记录 2026-09-29 本轮 design 的只读审计。生产 checkout、GitHub PR 和宿主 QA 设施均未被修改；未执行本机测试、529 driver 或房间部署。

## 1. 权威状态快照

| 证据 | 当前值 | 设计含义 |
|---|---|---|
| 生产 checkout / remote branch | `6e21a123d34bb53ee29b8536503133d714f46435`，树净 | 旧指令中的 `7d5d084cf` 已过期 |
| GitHub PR #1374 | OPEN，head 同上，base `main@b165d6490`，`MERGEABLE/CLEAN` | 当前不需要再 merge；main 后移才重新同步 |
| 当前 head 历史 | `7b5bc1520` 合入 `main@b165d6490`，`6e21a123d` 只追加 milestone | 合并语义已经落地，后续应先核祖先关系 |
| 精确头 CI | run `36544821509`，`CI OK` 与 16 个展开 job 全绿 | 这是 `6e21a123d` 的 full-CI 证据；任何新 push 都使其失效 |
| 生产 progress | `implement 3/4`；要求同头 review、CI、`needs_review` | CI 已完成，但同头 review 与 completion 仍须权威回执 |
| 本 design worktree | QA sandbox `project-slot-2-FLY-2922` | 只承载设计文档；绝不能拿它替生产 PR 合并或 QA |

“PR description 写过 APPROVED”不是当前复审证明；前一轮 `9c5aef2d2` 的 APPROVED 早于 `7b5bc1520/6e21a123d`。实现节点必须让 review gate 明确绑定最终头。

## 2. 已解决冲突的语义

### 2.1 FLY-2913 role prefix 与统一恢复 initial start

merge `703ad7f7c` 解决 `run-dispatcher.ts` 和 `run-infra.ts` 冲突。当前 `RunDispatcher` 构造器顺序为：

- `workflowUsageRecorder`
- `workflowPrefixLookup`（main 的 FLY-2913）
- `initialStartObserver`（FLY-2922）

`run-infra.ts:1320–1321` 用相同顺序传入 `resolveExecutionWorkflowPrefixContext` 和 `input.initialStartObserver`。这不是任意参数排序：错位会让恢复派发读取错误依赖或失去 root 起点权威。若未来 main 再冲突，应维持这组调用/声明一致，并用具体 consumer 文件验证。

### 2.2 FLY-3017 Codex guard 与 QA-only Claude stub

merge `7b5bc1520` 解决 `scripts/test-deploy.sh` 与 `scripts/lib/qa-generalized.sh` 冲突：

- 完整 `--stub-runner` 分支写 room-local Codex guard record；只放行该 stub binary/digest。
- `--qa-stub-runner` 是后续独立 `elif`；只安装 Claude shim，不创建 Codex shim。
- shim 按 activation / StateStore execution binding 识别 QA；无 Runner 身份的真实 Claude 评审透传到宿主 Claude。

这正是 QA@2 曾失败的边界。冲突解法不能把 stub PATH 再变回全局截获 Claude，也不能把 QA-only 分支搬进 STUB_RUNNER 分支。

### 2.3 parked body 与恢复门

`workflow-node-recovery.ts:248–309` 先做 rework context preflight，再读 process body：

- parked body 不是死亡证明，走 state-only `resume_rework`，交回 coordinator；
- latched `resume_failed` 拒绝并要求 reopen；
- 只有非 parked 且物理探活为 dead 才可 materialize replacement。

这保证“关死体不连带终结 run”不会演化成“把无 OS 进程的 parked body 当死体重复铸替身”。

## 3. QA driver 的可观察合同

`qa-529-generalized-e2e.mjs` 当前不是一句“跑到绿”的黑盒，它把九个边界写成逐步证据：

| Step | 关键事实 | 不能接受的替代证据 |
|---|---|---|
| 1 | workflow_v2 entry authority 与 manifest 持久化 | 只看进程启动 |
| 2 | design completion 符合 admitted lifecycle | stub 截获的假评审 |
| 3 | implement attempt 1 已真实 dispatch 且节点有 PR 能力 | 仅创建 session 行 |
| 4 | implement `ship_parked`、park open、pane 在房间 tmux server 存活 | 宿主 tmux namespace 的误判 |
| 5 | QA attempt 1 已派出，question gate 在 parked implement 期间仍可投递 | implement 自己持 gate |
| 6 | QA FAIL 有精确 rework request、durable wake receipt，run 仍 active，零 dangerous hold | 仅有 `returned_to_lead` 或 generic held |
| 7 | implement attempt 2 完成并把 PR head 从 attempt 1 推进 | 没有新 head 的状态翻转 |
| 8 | QA PASS authority、founder approval 与 land 终态 | 人工文本声称 PASS |
| 9 | park cleared、terminal timestamp、当前 actor 已回收 | 只看 run 终态 |

注入文案所称“held → unified-recovery → new-dispatch”在现有 driver 中由 Step 6 的故障/交付事实和 Step 7 的新当前 implement actor/head 共同体现。QA 报告还应导出 StateStore 的旧/新 execution tuple、dispatch ledger/receipt 与 run status，避免把 driver 的总结文字当唯一证据。

## 4. 房间与 tmux 隔离

`probeRoomPaneAlive`（`qa-generalized-e2e-lib.mjs:660–680`）显式把 `TMUX_TMPDIR` 设为 slot root，并删除继承的 `TMUX/TMUX_PANE`。`classifyImplementPark` 只有在 `ship_parked + park_opened` 且房间 pane 真活时才接受 `rework_reachable_wait`。

QA@4 因此必须：

1. 用 `flywheel-comm room list` 查服务账；再检查两个候选槽在宿主上都没有 `/tmp/flywheel-test-slot-N` 与对应活锁/进程。
2. 传两个显式数字槽：主房参数和 `--extra-lead SLOT:LABEL`；禁止省略槽号或使用 `auto`。
3. `--expect-head` 使用冻结的 PR 完整 SHA；脚本在取得任何 slot/lock 前核对运行它的 checkout HEAD。
4. 先保存 strength-two evidence，再拆自己持有 claim 的房；不得对陌生房运行 raw teardown。

当前脚本的相关边界：`test-deploy.sh:327–342` 在锁/构建/clone 前做 head fence；`:347–361` 约束 `--qa-stub-runner` 只与 generalized Codex room 合用；`:1607–1618` 安装 QA-only Claude shim。

## 5. 本地验证选择合同

如果 implement 因新 main 移动而产生新 merge commit，测试选择必须从**实际 merge diff**重新发现，不能沿用上一轮清单：

- 对每个冲突文件，搜索完整路径、文件名、父目录、新旧字面量和直接 importers；逐条记录排除理由。
- 每个保留的 Vitest 文件单独执行；changed TypeScript 再按 local-test-policy 执行 owning package 的 `vitest related file1 file2 --run`，参数只能是实际 changed-file 的精确路径，不能换成目录、glob 或 package filter。
- 每个新增或受影响的 `scripts/__tests__/*.test.sh` 单独执行。
- 保留 `pnpm lint`、affected package+dependencies build、导出 API 的 dependent typecheck 与 `git diff --check`。
- 本地证据只能写“targeted checks passed”；只有精确头 GitHub `CI OK` 可证明 full suite。

## 6. 未完成与不确定项

- 当前 `6e21a123d` 已有 full CI 与 mergeable 证据，但同头有效 code-review gate 尚未在当前提交材料中得到证明。
- QA@4 尚无 owner-isolated 双房、真实 Claude design review、完整九步 driver 或拆房收据。
- main 若在 implementation handoff 前再移动，现有 clean/CI 都只是旧快照；必须从新 merge head 重新绑定 review 与 CI。
- 本设计不声称 PR 可 ship，也不请求 shipping authority。
