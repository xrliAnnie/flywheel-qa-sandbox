# FLY-3143 Runner 进程认领：沙箱核验与交接 — 探索
Issue: FLY-3143 (https://linear.app/geoforge3d/issue/FLY-3143/急起体-1238-pdt-起-runner-起体-原会话续跑的进程认领时好时坏claude-全部失败codex-也有失败process)
日期: 2026-10-01
基于: 无

## 1. 这一轮被派来做什么

派单最新一段（founder 2026-09-30 21:46 PDT 回「开」）的要求：

- **不重新设计**。设计在分支 `flywheel-FLY-3143` 的 `plan.md`（R3 APPROVED，含 §13/§14 的落实裁定）和 `design.html`。
- 按该 plan 实现；三条「验收补充」必须有用例或真机覆盖。
- QA 一轮测全：真 Claude + 真 Codex，新起、原会话拉回、被标 failed 后恢复各至少一次；stub 不算证据；真机通道坏就是 blocked。

本体是这次工作流的 `eng_design` 节点（执行 `dde8719b`，Claude Code 2.1.286）。

## 2. 开工审计到的事实

| 项 | 事实 | 怎么核的 |
|---|---|---|
| 本工作区的仓库 | `xrliAnnie/flywheel-qa-sandbox`，**公开** | `git remote -v`、`gh repo view` |
| 沙箱远端有没有 `flywheel-FLY-3143` | 没有 | `git ls-remote --heads origin`（462 个分支，无此名） |
| 沙箱 main 有没有被修的那套代码 | 没有。`execution-process-*`、`SPAWN_BIND_WINDOW_MS`、`process_spawn_identity_unavailable` 等零命中 | `git grep` |
| 已批准设计在哪 | 生产仓 `xrliAnnie/flywheel`（**私有**）的 `origin/flywheel-FLY-3143` | `git ls-remote` |
| 该分支当前头 | `d7d72733b101472bd82236b558906f9c90d0e4d4`，生产 PR #1431 OPEN，头一致 | `gh pr list -R xrliAnnie/flywheel` |
| 该头上的实现进度 | 账本 `implement 10/10`，有 `implementation.md`、`verification.md` | 读该头的 `progress.md` |
| 本测试房跑的是什么构建 | 房间源码检出的 HEAD 就是 `d7d72733b…`，工作树干净 | `git -C <房间 src> rev-parse HEAD` |
| plan 的评审绑定 | R3 评审的 blob `0dbf0ea5…`；之后 Lead 授权的文字修订版 blob `5e27094f…` | 该头 plan.md 状态行 + `git rev-parse` |

## 3. 由此得出的判断

1. 派单里「分支上已有批准设计」这句话，只在生产仓成立；沙箱仓里没有那条分支，也没有那套代码。
2. 生产分支上，按批准 plan 的实现已经做完并开了 PR。这个测试房正在用那份实现当 Bridge 跑——本体能被拉起来，本身就是它在工作。
3. 所以在沙箱里既不该重新设计（派单明令禁止），也没有东西可以重新实现（代码不在这个仓）。后续节点在沙箱里能做、也该做的，是**核验**和**取证**。

## 4. 三个走法

| 走法 | 内容 | 取舍 |
|---|---|---|
| **A（采用）** | 不重写设计，不把私有仓文档逐字拷进公开沙箱。交付：按 commit / blob 指纹引用已批准 plan，核验它在候选头的落点；把「验收补充」三条逐条对到机制和测试；给后续节点一份只读核验脚本当合同 | 不产生第二份设计真源；不公开私有内容；后续节点有可照抄的命令 |
| B | 把生产分支的设计文档原样镜像进沙箱分支 | 会把私有仓内容发到公开仓；还会出现两份 plan，哪份算数说不清 |
| C | 在沙箱里从头再设计一遍 | 派单明令禁止 |

已用非阻塞问题 `aa23e108-28cf-4a06-8873-54292db5c47b` 请 Lead 在 A/B/C 里定。写本文时未回，按 A 推进；Lead 若另有裁定，按合同记 `design-correction.md` 增量改，不回滚分支。

## 5. 明说的假设

- 房间源码检出的 HEAD 代表正在跑的构建。源码与实际加载的 `dist` 是否逐字节对应，本体无法核（见 research.md 边界）。
- 「9dcd9313 的三种形状」「6c9541eb 的证据」是 Linear 评论。本会话 Linear 连接返回 401，原文读不到；三种形状的含义取自生产头 `implementation.md` 的归类，未与评论原文逐字对过。
- 后续 `implement`、`qa` 节点与本体共用这个工作区和测试房，能读房间源码检出和房间状态库（只读）。读不到时脚本返回 UNVERIFIABLE，不算通过。
- 沙箱节点没有权限重启 Bridge、制造近生产负载、或连起 10 个 Codex 体。这些真机项属于持有这个测试房的生产 QA，不在沙箱节点能力内。
