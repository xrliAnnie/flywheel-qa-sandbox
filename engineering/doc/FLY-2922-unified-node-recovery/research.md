# FLY-2922 三域权限与 QA@4 证据面 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: exploration.md

本文件记录 2026-09-29 的只读审计。未修改生产 checkout/GitHub PR，未运行本机测试、driver 或房间部署。

## 1. 当前执行环境不是生产 DAG

`/tmp/flywheel-test-slot-2/room-info.json` 给出：

- `projectName=test-slot-2`；
- `hostRepo=/tmp/flywheel-test-slot-2/project-slot-2`，即 QA sandbox；
- `runnerMode=real`、`qaRunnerMode=stub`；
- `flywheelRepo=/Users/xiaorongli/Dev/flywheel-FLY-2922`，这是房间运行的 Flywheel 源码 checkout；
- `buildSha=6e21a123d34bb53ee29b8536503133d714f46435`。

因此 `flywheelRepo` 只能说明房间由哪份源码构建，不能把其路径当成房内 runner 的生产写入授权。当前 design、后继 implement 和 QA stub 共用 QA sandbox DAG 身份；生产 PR 收口必须由另一个、绑定生产 repo 的生产执行完成。

## 2. 原计划为何会越界和递归

### 2.1 repo/cwd 绑定

review coordinator 用执行体的 worktree binding 选择审阅对象；`complete --pr` 也要求 PR 属于当前 cwd 根仓。因此房内执行体不能为生产 PR #1374 取得有效同头 review 或 completion。让它临时 `cd /Users/xiaorongli/Dev/flywheel-FLY-2922` 只会绕过身份边界，不会产生生产 Bridge 的授权。

`qa-529-generalized-e2e.mjs` 在 real 模式从 `room.flywheelRepo` 执行 `gh repo view` 来决定 PR authority。当前值是生产仓源码 checkout；若不增加 sandbox repo guard，房内 fixture 的 PR 证据可能错误地查询生产仓。QA@4 必须先让 harness 把 repo authority 绑定到 `room.hostRepo` 的 sandbox remote，并对生产 repo fail closed。

### 2.2 stub QA 只执行脚本协议

driver 在 Step 8 写 `<qa-exec>.release.json`，然后等待 stub 产出 `qaPassResult`；房内 QA 不会自行执行“起双房、跑 driver、保存快照”等计划。把这些 host 操作分配给房内 QA 是不可执行的自引用。

driver 随后会推进 founder approval/land 流程，所以 stub 的结果只允许作用于 sandbox fixture run。它不能成为生产 PR 的 QA verdict。

### 2.3 使用生产 issue 会自递归

`buildGeneralizedStartRequest` 直接传入 `issueId`，没有 fixture body 覆盖。当前外层 run 已由 FLY-2922 启动；内层再执行 `--issue FLY-2922 --real` 会让真实 design/implement 再次收到同一生产指令。正确边界是 Lead 授权的 QA fixture issue：内容只允许写 sandbox repo、明确禁止生产路径/PR/ship，并记录 identifier 与 description digest。

## 3. 生产状态只读快照

| 证据 | 当前值 | 设计含义 |
|---|---|---|
| 生产 checkout / remote branch | `6e21a123d34bb53ee29b8536503133d714f46435`，树净 | 旧指令中的 `7d5d084cf` 已过期 |
| GitHub PR #1374 | OPEN，head 同上，base `main@b165d6490`，`MERGEABLE/CLEAN` | 当前快照不需要重复 merge；main 后移才同步 |
| 精确头 CI | run `36544821509` 全绿 | 只对 `6e21a123d` 有效；新 push 后失效 |
| 同头 review | 当前材料未证明 `6e21a123d` APPROVED | 生产 DAG 仍需有效 review receipt |
| QA@4 | 无 owner-isolated 双房、九步证据与 teardown receipt | 不可声称 QA PASS |

## 4. merge 语义与定点测试

若生产 main 再移动，冲突解法仍须同时保留：

- FLY-2922：统一恢复口、initial-start authority、真实 dispatch ledger/receipt、dead-only replacement、carrier close 不级联终结 run；
- main：workflow role prefix、lifecycle/rework/quota guards、QA-only Claude shim 与 Codex guard record；
- driver：`probeRoomPaneAlive` 使用 slot 的 `TMUX_TMPDIR`，清除继承的 `TMUX/TMUX_PANE`。

生产头上存在的直接测试包括：

- `packages/teamlead/src/__tests__/workflow-node-recovery.test.ts`
- `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts`
- `packages/teamlead/src/__tests__/StateStore.land-carryover.test.ts`
- `packages/teamlead/src/bridge/__tests__/workflow-carrier-close-recovery.test.ts`
- `packages/teamlead/src/bridge/__tests__/run-dispatcher-prefix.test.ts`
- `packages/teamlead/src/__tests__/workflow-prefix-context.test.ts`
- `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`
- `scripts/__tests__/test-deploy-generalized.test.sh`

`pnpm --filter flywheel-teamlead exec ...` 的 cwd 是 `packages/teamlead`，所以 Vitest 的 concrete/related 参数必须写包内 `src/...` 路径，而不是重复 `packages/teamlead/` 前缀。

## 5. 房外 QA 的 source 与 teardown 合同

QA source 不能是 implement 仍可能写入的 worktree。房外 QA 应从生产 remote fetch 后创建专用、临时、detached checkout，固定在 `QA_HEAD`；在该 checkout 运行 `test-deploy.sh` 与 driver，结束后移除自己的 worktree。

本拓扑使用 raw `scripts/test-deploy.sh ... --qa-stub-runner`，不是 room service deploy，因为后者不支持该 flag。因此 owner teardown 的主路径是 `scripts/test-teardown.sh "$PRIMARY_SLOT"`；它会读取 owner slot 的 `campaign-manifest.json`，停止 extra Lead 并释放 borrowed slot locks。`room teardown --room` 不属于此拓扑。

## 6. QA evidence 的判据

driver Steps 1–9 是受测流程的自动化证据，但外层 owner 还必须独立确认：

1. fixture issue 与 sandbox repository authority；
2. source checkout 与生产冻结 head 相同；
3. design review 实际由 Claude 完成，QA-only stub 没截获 review；
4. Step 6 的 rework request/wake receipt 与 run 仍 active；
5. Step 7 新 execution、launch ordinal、dispatch ledger/receipt 与新 PR head；
6. pane probe 使用房间 `TMUX_TMPDIR`；
7. 快照发生在 teardown 之前，两个 slot 都由 owner 清理。

stub 的 `qaPassResult` 只说明脚本按预定路径走到 Step 8；生产 QA verdict 仍由房外 QA/Lead 基于上述原始证据签发。

## 7. 结论

当前生产头的实现与 CI 快照看起来接近收口，但本 sandbox DAG 没有生产写入或裁决权。实施计划必须把生产 closeout、host QA controller、inner sandbox run 分开；任何一个域都不能借用另一个域的 cwd、issue、PR 或 verdict。
