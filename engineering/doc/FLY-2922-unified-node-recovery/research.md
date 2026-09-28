# FLY-2922 529 递归等待与现有通道 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: exploration.md

## Evidence Scope

当前 design worktree 基线是 `d576a27b9`，只含进度账本；既有 FLY-2922 产品设计与实现证据从 `origin/flywheel-FLY-2922` 只读核对。远端可见头是 `2dd29e027`，而 Lead 交接记录的最新产品头是 `473ec191`；因此本调研把符号名和协议当权威，不把远端行号当最新实现行号。未切换、merge 或修改产品分支，未运行测试。

本轮事实还包括 Lead 给出的 2026-09-28 真房结果：slot 6 + extra 4 的 real generalized driver 到 step 3 后，房内 QA execution 等待宿主侧 529 最终回执，导致外层 driver 无法得到 QA verdict。该 evidence 标记为 INCONCLUSIVE，不能算 strength-two PASS。

## Existing Driver Contract

`scripts/qa-529-generalized-e2e.mjs`：

- `parseArgs()` 当前公开 `<slot> --issue <FLY-N> [--real] [--timeout-ms]`；默认 stub，`--real` 才启真 Runner。
- `runDrillSteps()` 用 `buildGeneralizedStartRequest()` 启动 generalized DAG，再逐步观察 design、implement、QA rework、attempt 2、founder approval、land 与 park settlement。
- driver 已持有 `room.agentId`、slot master token、slot `comm.db`、StateStore 只读句柄、当前 `runId` 与每个 node 的 `execution_id`。
- `runComm()` 已把所有 comm 调用绑定到 slot-local CommDB、projects registry、Lead identity 和 summary home。driver 已用同一身份开/答 question gate，不需要新认证机制。
- `owner.json` 和 step evidence 已按 run 写在 `${SLOT_DIR}/e2e-evidence/<run>-<timestamp>/`，可承载新增的 boundary message id 与 tuple。

`scripts/lib/qa-generalized-e2e-lib.mjs`：

- `buildGeneralizedStartRequest()` 只设置 issue/project/Lead、code task、main session 和 node model overrides，不支持任意 prompt bypass。
- `nextStubAction()` 的 `qaFailReady` / `qaReady` 是 stub lane handshake；不能拿它当 real QA 的证据所有权合同。
- 现有 helper 已采用 required-string、tuple equality 和 fail-closed 错误风格，新增边界 helper 应沿用。

## Existing Mailbox Contract

`flywheel-comm send --from <lead> --to <execution> --json <text>` 是现成 Lead → Runner durable instruction：

- `packages/flywheel-comm/src/commands/send.ts` 先验证 Lead write authority，再用 StateStore/CommDB 将 recipient 解析为 exact execution，最后原子写 instruction 并清理旧 declared state。
- `--json` 回包含 `instruction_id`、`resolved_to` 和 `verify_command`；driver 可拒绝 `resolved_to !== qaExecutionId`。
- Bridge `runner-mailbox-lane.ts` 投递时加 `[lead-instruction <id>]`，绑定 `executionId`，由现有 Runner transport 唤醒/送达。
- `message-status <id> --json` 可只读得到 live/archive、state 以及 `created_at / delivered_at / notified_at / settled_at`。只有 exact message 的 `delivered_at != null` 或已 ACKED 才能证明指令已送到 Runner；“send 命令 exit 0”只证明写入。
- 普通 CLI 不暴露稳定 instruction id。harness 应把第一次返回的 id 立即写进 `owner.json`，重入先复核 owner + message-status；若 crash 落在 send 成功与 owner 写入之间，可按 exact `{from,to,content}` 查询 slot CommDB 复用唯一行。多行或字段冲突必须 fail closed。

## Why This Does Not Relax Production QA

通用 QA 规则仍然要求 Discord-capable 变更自行完成真实 529 N-to-N。新增消息只在一个已经位于 generalized real room 内的嵌套 QA execution 上声明：本 execution 是外层 campaign 的被测节点，不再作为第二个 campaign 的 owner。

它没有以下能力：

- 不调用或修改 `evidence-run record`；
- 不改变 strength-two judge、CI 或 founder ship gate；
- 不改 QA role 文件或全局 prompt；
- 不把 `qa-result` 自动设为 pass；
- 不允许 driver 在 step 9 前输出成功。

因此边界是责任分工，不是豁免。内层 QA 仍要验证 exact head 和产品行为；外层 driver 必须完成真实拓扑、held → unified recovery → new dispatch 等场景并保存 evidence。

## Proposed Harness Protocol

### CLI

新增 `--outer-evidence-boundary`，只在 `runnerMode === "real"` 合法。help 文本明确写：它让当前 real generalized campaign 的外层 driver 成为唯一 529 evidence owner；不是 PASS 开关。

### Tuple and message

在每次 QA attempt 首次看到 current node 后，driver 构造 canonical tuple：

```json
{
  "schemaVersion": 1,
  "kind": "qa529_outer_evidence_boundary",
  "issue": "FLY-2922",
  "slot": 6,
  "runId": "<workflow-run-id>",
  "qaExecutionId": "<exact-current-execution>",
  "qaAttempt": 1,
  "evidenceDir": "<slot-local-run-evidence-dir>"
}
```

消息正文使用固定前缀和 JSON，避免自然语言歧义：

```text
[qa529-outer-evidence-boundary/v1] This QA execution is inside the generalized real-runner campaign named below. The outer driver is the sole producer of the campaign's final 529 evidence. Do not start or wait for a nested 529 campaign. Still verify the exact head and this node's required scenarios, then submit the normal qa-result. This instruction is not PASS and is not an evidence receipt. tuple=<canonical-json>
```

attempt 1 与 attempt 2 分别绑定各自 execution；死体替换后不得沿用旧 execution 的消息。正文只含 slot-local 路径和非秘密身份，不放 token、credential 或用户文本。

### Ordering

1. driver 观察 current QA node/execution 并同步 owner set；
2. 确认 run、nodeId=`qa`、attempt、execution 与 StateStore 当前行一致；
3. 发送或复用 exact boundary instruction；
4. `message-status` 观察 delivered/ACKED；DEAD、torn、foreign recipient 或超时即失败；
5. 才进入该 attempt 的 QA-ready / verdict wait；
6. QA 换体时回到步骤 1，旧消息只作为历史证据；
7. driver 走完全部 step 后，外层 QA 才能另外执行 `evidence-run record`。

## Test Surface

| File | Evidence |
|---|---|
| `scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs`（新增） | 无开关时 fake real QA 保持 `awaiting_host_receipt` 并在既定边界超时；开关时 exact instruction delivered，两个 QA attempts 正常给 verdict，driver step 1–9 完成；foreign/stale/dead message 负控 |
| `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` | canonical tuple、正文无 secret、stable comparison、real-only guard、replacement execution 重新绑定 |
| `scripts/__tests__/test-deploy-generalized.test.sh` | help 暴露 flag；stub + flag 被拒；现有 ordinary/stub 输出合同不变 |
| real QA campaign | 两个真 Lead；开关显式开启；step 1–9、held → unified recovery → new dispatch、派发账本和最终外层 evidence 全部可见 |

测试发现必须先用 `git grep -lF -- '--outer-evidence-boundary'`、变更全路径/文件名/父目录搜索；每个 concrete file 单独运行。没有匹配不允许回退成广泛 suite。

## Risks

- **消息到达但 Agent 忽略**：要求 delivered/ACKED 只是 transport 证据，真正收敛仍看后续 `qa-result`；超时保留 instruction id 和 message-status 诊断。
- **instruction 触发完成义务**：正文带正式 `[lead-instruction id]`，内层 QA 应按其合同在完成前报告 DONE；这是正常 mailbox 语义，不在 harness 绕过。
- **重入重复消息**：owner + exact CommDB query 复用；多行歧义 fail closed。
- **内层 QA 错把边界当 PASS**：正文、HTML 和测试都写明 not PASS / not receipt；driver 不读取该消息来满足 step verdict。
- **最新产品头与 sandbox remote 漂移**：实施前以 PR exact head 重新定位符号和测试；本计划禁止按这里的旧行号机械修改。
