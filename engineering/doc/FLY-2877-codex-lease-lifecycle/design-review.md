# FLY-2877 Codex lease 生命周期 — 设计审查
Issue: FLY-2877 (https://linear.app/geoforge3d/issue/FLY-2877/病根codex-lease-codextmuxadapter-在-runner-的-codex-进程仍活着时就释放了-flywheel)
日期: 2026-09-25
基于: plan.md

审查工具：Codex companion（`gpt-5.6-sol`，effort xhigh，持久 thread `01a0d799-b69b-74f0-b959-43003eb727ce`，后续轮 `--resume-last`）。原始反馈文件：`/tmp/codex-rescue-design-feedback-flywheel-FLY-2877-plan-round{1,2,3}.md`（本机临时文件，不入库；要点抄录如下）。

## R1 — CHANGES REQUESTED（5 blocking + 2 advisory）

| # | 级别 | 要点 | 处置 |
|---|---|---|---|
| 1 | BLOCKING | 自拟的单次 `ps eww` + argv0 匹配与 FLY-2869 的进程权威（ucomm、argv 前后快照、重复 env key、僵尸）不同口径；argv 里伪造的 env 会被当事实 | 采纳：C1 改为逐字复制 2869 的 `host-process-snapshot` 合同到 claude-runner；任一 unattributed → probe unknown；T0 镜像其 fixtures |
| 2 | BLOCKING | 自愈挂在 `heartbeat()` 上：它也被每条 daemon 通知同步调用，拍数≠时间；async reassert 无 single-flight，可能在 `retireOnce` unlink 之后重建 lease | 采纳：独立 60 s wall-clock 定时器（同一 `startHeartbeat` seam）、`leaseReassertInFlight` single-flight、收尾第一步停定时器并 join；T4 加通知风暴与跨收尾竞态用例；目标里把「不变量」与「恢复」分开 |
| 3 | BLOCKING | 清扫调用 `retireCodexExecutionHome` 需要 session.json 解析为 `keyed`，残留场景常无 session.json → 永远 unresolved | 采纳：新增 `scrubCodexAgentHomeLeaseEntry` janitor 原语，启动 janitor 与清扫共用；T5 覆盖 session.json 缺失/损坏 |
| 4 | BLOCKING | 漏了 Blueprint 未交接回滚两处的回归，且 targeted 命令没跑 edge-worker | 采纳：C6 + T8，命令加 edge-worker |
| 5 | BLOCKING | 漏了 `packages/claude-runner/src/index.ts` 根导出，teamlead 无法 import | 采纳：C1 列出导出清单，T9 |
| 6 | ADVISORY | holder 结果不应带完整 command（可能含凭据） | 采纳（零成本）：只暴露 pid；reason 固定枚举 |
| 7 | ADVISORY | §0/流程图与 C3 的收尾顺序不一致 | 采纳（零成本）：统一为 `runtime.stop → killWindow → drained → wait → release` |

## R2 — CHANGES REQUESTED（2 blocking + 3 advisory）

| # | 级别 | 要点 | 处置 |
|---|---|---|---|
| 1 | BLOCKING | C4 把 `agents/<p>/<r>` 目录名当 project/role；目录名是 `encodeMemoryPathComponent` 编码后的（大小写、`--` 会变换），`validateMarkerIdentity` 必失败 → 合法 identity 的残留永远清不掉 | 采纳：`scrubCodexAgentHomeLeaseEntry` 只收 `{home, executionId}`，锁内读 marker 取原始 identity 并以 `codexAgentHomeDir(marker)===home` 证路径；T1/T5 加大写与 `--` identity |
| 2 | BLOCKING | 测试矩阵漏了 adapter keyed 正常收尾（`retireCodexExecutionHome`，约 882 行），且未证明 adapter/janitor 把 probe **转发**到原语 | 采纳：目标 4 逐名列出全部释放点；T2a–d 加 882 且注入 live holder（漏传必红）；T1 加 `scrubOrphanedCodexAgentHomes` 调用层配对 |
| 3 | ADVISORY | `leaseHolderWaitMs=5000` 不是总 deadline（单次 probe 三次 ps 最坏 9 s） | 采纳（零成本）：改为总 deadline，剩余 deadline 传入 capture；`retireOnce` 内最后一次探测明示在外；T2f 加慢探测用例 |
| 4 | ADVISORY | `export interface … = …` 非法 TS；根导出缺 snapshot 类型；T0「同一组向量」需逐项 | 采纳（零成本）：`export type`；导出 `CodexProcessSnapshot/Record/Unattributed`；T0 镜像 2869 fixtures 并逐项列出 |
| 5 | ADVISORY | 「≤60 s + 一次锁」不是可兑现保证（锁 10 s 超时、I/O 失败只等下一 tick） | 采纳（零成本）：改为「≤60 s 发起；首次成功取锁并校验后放回；失败记日志下一 tick 再试」 |

条数 7 → 5，且 R2 的 blocking 都是 R1 修法引入的精确化，不是新机制；未按 memory「条数不降就做减法」触发减法。

## R3 — CHANGES REQUESTED（1 blocking + 3 advisory）

| # | 级别 | 要点 | 处置 |
|---|---|---|---|
| 1 | BLOCKING | `scrubEntry` 在证明 `codexAgentHomeDir(marker)===home` 之前调用 `prepareCodexAgentHomeLock(marker)`，后者会 `mkdirSync(root)` 并 `ensurePlainDirectory` `agents/<encoded>/.locks`；一个声称别的 identity 的坏 marker 会先触碰别人的目录再返回 `entry_invalid`，T1 的「零写入」不成立 | 采纳（最小修法，无新机制）：顺序改为「只读预验证 → 取锁 → 锁内复验」，预验证不调用任何写目录的 helper；T1 零写入改为对整个 homes root 的递归 lstat 快照前后逐项相等 |
| 2 | ADVISORY | probe 签名传不下 5 s 总 deadline | 采纳（零成本）：`CodexLeaseHolderProbe` 加可选 `{deadlineMs}`；守卫内省略，等待阶段传入 |
| 3 | ADVISORY | targeted 命令漏 T9 | 采纳：加入 claude-runner 批次（仍 ≤6 文件）|
| 4 | ADVISORY | §5/§9 残留无条件「≤60 s 放回」文案 | 采纳：统一为条件保证；QA 健康路径注明前提 |

条数 7 → 5 → 4，blocking 5 → 2 → 1，每轮的 blocking 都是上一轮修法的精确化而非新机制。按 memory 规则（FLY-2390 Tadashi 裁定：最多 R3，R3 打回不开 R4，带分档报 Lead 裁定）：四条已按最小修法改进 plan，用 `ask` 报 Lead，等裁定 effective APPROVED 或授权范围限定的 R4 验证轮。

## Lead 裁定（ask 92bcd1b8，2026-09-25 09:5xZ）

裁 B：授权一轮范围限定的 R4，只核 R3 的 4 条（重点：`entry_invalid` 路径真正零写入——只读预验证 → 取锁 → 锁内复验，要有测试证明失败路径不 mkdir/chmod）。R4 若只剩 advisory → 写 design-review.json 直接进实现；若 R4 又出新 blocking → 停下 ask Lead，不开 R5。QA 判据 2 依赖 FLY-2869 分支的 census 提交 `2d5d24efc`：plan 写明 QA 用临时分支（本单头 + cherry-pick 该提交，只推 sandbox）验证，或等 2869 合入后再验；本单不改 host-readiness。本机只跑相关测试。

## R4（范围限定，只核 R3 四条）— APPROVED

| # | 级别 | 要点 | 处置 |
|---|---|---|---|
| — | — | R3 的 1 blocking + 3 advisory 均确认关闭；§7 的 FLY-2869 联合 QA 路径可执行（commit `2d5d24efc1e7fc5fbf26777c68a56626bbc0b9a7` 本地可解析）；`host-readiness.ts` 及测试相对 `origin/main` 零 diff | — |
| 1 | ADVISORY | C2 第 1 条笼统说三个删除函数都锁前 probe，与 scrubEntry 的专门顺序（锁内 probe）不一致 | 采纳（措辞）：第 1 条只适用 release/retire，scrubEntry 明示为例外、以专门顺序为准 |
| 2 | ADVISORY | T2f 应断言注入 probe 收到递减的 `deadlineMs`，而非 capture | 采纳（措辞）：T2f 改为断言 probe options；default probe 转交 capture 由 T0 覆盖 |

有效结论：APPROVED（rounds=4，R4 由 Lead 裁定 92bcd1b8 授权且范围限定）。design-review.json 按 Claude lane 流程写入 `.flywheel/runs/<exec>/codex/`，附 `leadRuling`。
