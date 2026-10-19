# FLY-2808 generalized e2e fixture

- attempt 1: run=39f7f2a8-c733-4ac3-92d2-0ef0c6550b7e execution=60ad4ea2-c663-4937-9f80-86184ed7ce93
- attempt 2: run=39f7f2a8-c733-4ac3-92d2-0ef0c6550b7e execution=b51ecda0-b8c1-4461-95e2-9ae7f7bcdb55

## implement@1 核对记录（529 混合房，真 Claude 载体实现节点）

Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808)
日期: 2026-09-24
基于: doc/FLY-2808-generalized-e2e/design.html

issue 末段「▶ qa@1 返工要求（头 29d3afe85，claim 1508）」A–E 是给真仓 PR #1299 实现体的指令，
已由真实现体完成；本节点在 QA 沙箱内，不改真仓、不推真仓提交，只读核对后在此留痕。

| 核对项 | 期望 | 观测 | 结论 |
|---|---|---|---|
| 真仓 PR `xrliAnnie/flywheel#1299` 远端头 | 已越过 29d3afe85（claim 1508 返工已落） | `e16cebcf736f76a5f9a45f58bb8b760bdb6f1ffd`（OPEN，head `flywheel-FLY-2808`） | 通过 |
| claim 1508 返工提交 | A/B/D/E 各有提交 | `07588f5a0`（A：Claude SessionStart 身份改 POST）、`8cd3b1242`（B：用冻结的 Lead/node 拉起 standby 体）、`077da2e65`（D：退役窗口销毁 runner session 后继任可活）、`2137d4132`（E：拉起中保持 parked 并记失败真因）、`e9bd824bd`/`e16cebcf7`（处置记录 + milestone） | 通过 |
| PR 可合并性 | MERGEABLE | `mergeable=MERGEABLE`，`mergeStateStatus=CLEAN` | 通过 |
| 真仓工作区 | 干净 | `flywheel-FLY-2808` worktree HEAD=`e16cebcf7`，`git status --short` 为空 | 通过 |

边界说明：本沙箱仓（`flywheel-qa-sandbox`）没有 #1299；本文件与所在 PR 只是 529 房 generalized DAG
演练的实现节点载体（do not merge），真实交付仍是真仓 PR #1299。

## implement@2 返工记录（qa@1 FAIL → implement wake）

日期: 2026-09-24
基于: 上节 implement@1 核对记录；返工基线 `72081c359`（沙箱 PR #242 头）
返工来源: qa_fail（qa attempt 1，edge `qa_retry`），QA 要求 = FLY-1775 确定性演练「implement attempt-2 标记」

本节点是替换已死 actor 的 implement attempt 2（activation
`activation:b51ecda0-b8c1-4461-95e2-9ae7f7bcdb55:39f7f2a8-c733-4ac3-92d2-0ef0c6550b7e:implement:2`，
TURN epoch 11 为 `yours`）。上方 `attempt 2` 行即 QA 要求的标记；以下为同一范围的只读复核，
仍不改真仓、不推真仓提交。

| 核对项 | 期望 | 观测 | 结论 |
|---|---|---|---|
| 真仓 PR `xrliAnnie/flywheel#1299` 远端头 | 与 implement@1 记录一致（claim 1508 返工已落） | `e16cebcf736f76a5f9a45f58bb8b760bdb6f1ffd`（OPEN，非 draft） | 通过 |
| PR 可合并性 | MERGEABLE | `mergeable=MERGEABLE`，`mergeStateStatus=CLEAN`（真仓 main 头 `e2c43b2c6`） | 通过 |
| 真仓工作区 | 干净 | `flywheel-FLY-2808` worktree HEAD=`e16cebcf7`，`git status --short` 为空 | 通过 |
| 沙箱 PR #242 | 返工提交落在基线之上 | 基线 `72081c359` → 本提交（attempt-2 标记 + 本节） | 通过 |

边界说明同上：真实交付仍是真仓 PR #1299；本沙箱 PR 只承载 529 房 generalized DAG 演练，do not merge。
