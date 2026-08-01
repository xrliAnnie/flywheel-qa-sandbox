# FLY-1580 progress

exec-id: bee48547-352e-4bb0-8679-c5d0543bec11
node: generalized workflow "execute" — **no-write**(不许改共享分支/提交/push/开 PR)
route on complete: `no_code`

## 游标

| # | 步骤 | 状态 |
| -- | -- | -- |
| 1 | onboard(stage set + onboarding skill) | ✅ |
| 2 | 审计 design.md / FLY-1569 / FLY-1573 / 全仓半径 | ✅ |
| 3 | 非阻塞 `ask` ×2(`69bd7068` 四问 / `872d9606` scope) | ✅ **两条 Lead 都已回复** |
| 4 | exploration.md | ✅ |
| 5 | research.md | ✅ |
| 6 | plan.md | ✅ |
| 7 | Codex design review(xhigh,5 轮) | ✅ **APPROVED** |
| 8 | 按 Lead 回复回填三份文档 | ✅ |
| 9 | 写 codex/design-review.json + `await-codex-gate design` | ✅ 门已过(exit 0) |
| 10 | 报 Lead + `complete --route no_code` | ⏳ |

## 交付物

`engineering/doc/FLY-1580-design-errata-sync/` — exploration.md / research.md / plan.md / progress.md

**未落地**(no-write 约束,Lead 已确认这么做对):design.md 两处改动、FLY-1569 正文同步。
逐字 patch 在 plan.md §2 / §3.1,执行链(基线→核验→stage→commit→push→PR→post-merge)在 plan.md §4。

## Lead 已裁决(两条 ask 都回了)

| # | 问题 | 裁决 |
| -- | -- | -- |
| 1 | FLY-1580 前提有误(更正不在 1573 里) | 确认「是我立单时写错了前提」 |
| 2 | D(FLY-1573)带旧硬验收、不在封锁名单 | **Lead 本人改 1573 正文**(别重复做);**封锁名单 E/F/G → D/E/F/G** |
| 3 | 节点 no-write vs 验收要求 PR | **守节点约束**,落地留 implement 节点;整单终态由 Lead 保证 |
| 4 | 更正② 放 §3 开头 | 采纳,不否决 |
| 5 | 过程文档进不进 PR | **A,而且是「必须」** —— 必须随 PR 进 main,不许合并后补(main 检出须单写者干净,否则 updater `git pull --ff-only` 和回滚会坏) |

## Codex design review 收敛轨迹(5 轮,xhigh,thread `019fbae7-ce32-7503-b344-a5fa345ff536`)

| 轮 | 阻塞项 | 抓到的真 bug |
| -- | -- | -- |
| R1 | 4 | `git diff main` 基线错(本地 main 落后一提交,design.md 会显示成整篇新增) |
| R2 | 3 | 第 0 步 fail-open(实跑:fetch 失败仍打印 BASE 退 0);remote tip ≠ merge-base;发布链缺失 |
| R3 | 3 | 后续块仍丢 `$BASE`(fresh shell exit 128);发布链无 `set -e`(shim 证明 commit 失败仍 push) |
| R4 | 1 | `gh pr diff` 不支持 pathspec(实跑 exit 1) |
| R5 | 0 | **APPROVED** |

每轮都是实跑出来的真 bug,不是空转。R2#2 的「未回复就硬停」建议**未采纳**,Lead 事后明确支持该判断。

## 备注

progress.md **未走 `flywheel-comm progress` 提交** —— 该命令会产生 commit,与本节点 no-write 约束冲突;按节点级约束优先,保留为工作区文件(随 implement 节点的 PR 一起进 main)。
