# FLY-2909 ACK 与首动作同轮 — QA 报告
Issue: FLY-2909 (https://linear.app/geoforge3d/issue/FLY-2909/token2-lead-规则收信-ack-和对这批信的第一个动作放进同一次工具调用纯通知与最后一个动作同发不再单独多转一轮)
日期: 2026-09-26
基于: qa-handoff.md、validation.md

## 结论

**QA FAIL**，验证候选头 `bd40e1eb05d4f4e364336a22b2895c5485717b72`（PR #1348）。

失败依据是精确候选头的 mandatory full CI 为 `full_failed`，不是 `CI OK`：GitHub Actions run [36256758303](https://github.com/xrliAnnie/flywheel/actions/runs/36256758303) 中 `Script Tests 5/6 — balanced shell suites E` 的 `Test — FLY-1986 load probe contract` 失败，错误为：

```text
positive control failed — the block did not certify without 401 (got 'incomplete_expected=3')
passed=61 failed=1
```

该失败未指向本单 ACK 规则改动，较像共享测试基准/负载问题；但当前头存在红 CI job，按 QA 协议不能 PASS。

## 候选与用户路径核对

- 本地 `HEAD`、`origin/flywheel-FLY-2909`、PR #1348 `headRefOid` 三者一致：`bd40e1eb05d4f4e364336a22b2895c5485717b72`。
- 工作区在验证开始时为空。
- diff 通过 `lead_ack_action_batching` 开关选择新旧规则；开关关闭时保留历史规则字节，Claude/Codex Lead 启动路径均读取同一项目级开关。
- 新规则明确要求 ACK 与本批首个处理动作同一次工具调用并行发出；纯通知批次则与本轮最后动作同发，同时保留“不在处理前 ACK、不代 Lead ACK、紧急 founder 消息不为凑批延后”的约束。
- 未改 Bridge 产品逻辑；本次 QA 也未改产品代码。

## 定向验证

以下均在候选头运行：

- Teamlead 直接相关 Vitest：5 files / 99 tests，全部通过。
- Config 开关/漂移/策略 Vitest：3 files / 93 tests，全部通过。
- `fly2909-ack-first-action.test.sh`：通过。
- `fly1402-single-bundle.test.sh`：41/41 通过。
- `fly1674-residue.test.sh`：88/88 通过。
- `pnpm --filter "flywheel-teamlead..." build`：13 个 workspace project/dependency 构建通过。
- `pnpm --filter "...flywheel-teamlead" --filter "...flywheel-config" typecheck`：12 个 project/dependent 通过。
- `pnpm lint`：退出码 0；扫描 5,111 files，保留 25 个既有 warning。

Changed-file related 结果：

- Config：21 files；384 通过、1 个 15 秒超时。该用例隔离复跑通过（1/1），归因为负载型 bench timeout。
- Teamlead：191 files；2,646 通过、4 失败、1 skipped。它因高连接源文件扩张为近整包验证，耗时 2,995 秒；QA 保留原始失败，不把它当作 full CI 替代品。
  - `bridge.test.ts` 的 5 秒超时隔离复跑通过（1/1）。
  - `runs-route-registration.test.ts` 隔离复跑两次仍在 15 秒超时。
  - `createLeadRuntime-preflight.test.ts` 隔离复跑仍出现 15 秒超时/后续 mock 状态不符。
  - 上述持久红项不在 FLY-2909 的规则改动路径，但属于当前 checkout 的额外本地红证据。

## 度量基线复跑

复用候选提供的脚本：

```bash
python3 packages/teamlead/scripts/measure-ack-roundtrips.py \
  --transcript-root /Users/xiaorongli/.claude/projects \
  --since 2026-09-11T22:00:00Z \
  --until 2026-09-25T22:00:00Z \
  --json
```

本次独立复跑读取 245 个 transcript，解析错误 0；统计仍为：

- 只由 ACK 返回触发的请求：6,811；token 3,293,551,689。
- 其中之后无工具调用：5,457；token 2,582,466,787。

## 529 与 ship-report 边界

FLY-2909 涉及真实 Lead 收信与 cross-Lead 行为，本应在 529 房完成 Claude + Codex 的开/关对照、首动作失败、处理中杀进程后重投、关闭时字节一致四项验收；它不是 “no N-to-N surface”。

本轮未进入 529：精确头 full CI 已先触发 mandatory fail-close，当前候选不具备 PASS 前置条件，因此没有向 Lead 请求开房，也没有制造无效的 live evidence。四项补充验收仍未被证明，不能被本地单测替代。

FAIL 不发布 founder ship-report。

## 流程备注

QA progress ledger 更新被 StateStore 拒绝：当前权威 stage/phase 为 `test/implement`，`--phase qa` 与之冲突；未强行改账。
