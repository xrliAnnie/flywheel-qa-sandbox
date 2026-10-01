# FLY-3143 Runner 进程认领：沙箱核验与交接 — 实施计划
Issue: FLY-3143 (https://linear.app/geoforge3d/issue/FLY-3143/急起体-1238-pdt-起-runner-起体-原会话续跑的进程认领时好时坏claude-全部失败codex-也有失败process)
日期: 2026-10-01
基于: exploration.md、research.md

## 1. 一句话

这份计划**不是新设计**。FLY-3143 的设计已批准、实现已做完，都在生产仓；沙箱仓里没有那套代码。本计划只规定沙箱里后续两个节点（implement、qa）做什么：用一份只读脚本核验候选构建、记录每个体自己的认领结果，其余如实标 not_run。

## 2. 真源与身份（全部按指纹引用，不复述）

| 名称 | 值 | 用途 |
|---|---|---|
| 候选头 | `d7d72733b101472bd82236b558906f9c90d0e4d4`（生产 PR #1431 的头，也是本测试房源码检出的 HEAD） | 被测对象 |
| 已批准 plan 文本 | 候选头 `engineering/doc/FLY-3143-runner-process-claim/plan.md`，blob `5e27094f7a3ad0573b52e1d92f8e361525b3dafd` | 设计唯一真源 |
| R3 评审绑定的 plan | blob `0dbf0ea588adf1fe891f0e08078b27d71a32f9e8` | 审计基线（之后的文字修订由 Lead 授权，不另开复审） |
| 核验合同 | 本目录 `verify-candidate.sh` | 核验唯一真源；本文不重复它的断言清单 |
| 本次工作流 run | `6655d842-9c97-42c3-b345-717e9ed4e6c6` | 取证范围 |

下文「plan §x」指候选头那份 plan，「本计划」指本文件。

## 3. 范围

**做：**

- implement 节点：跑核验脚本两种模式，把输出原样记进 `implementation.md`。
- qa 节点：重跑核验，收齐三个节点各自的认领记录，按 §6 的表出裁决。
- 任一节点被「原会话拉回」后，再对自己跑一次 `body` 模式并追加记录。

**不做：**

- 不重新设计，不改候选头的 plan，不把生产仓文件拷进这个公开仓。
- 不在沙箱仓写任何 `packages/`、`scripts/` 代码。沙箱 main 没有被修的子系统，照 plan 打补丁无处可落。
- 不重启 Bridge、不停别的体、不制造负载、不改房间状态库。
- 不在候选检出里跑测试或构建（会写它的工作树；它正被 Bridge 使用）。
- 不合并、不部署、不申请 ship。

## 4. 核验合同 `verify-candidate.sh`

从仓库根执行。只读：只用 `git rev-parse / cat-file / grep / diff / merge-base / status`（带 `GIT_OPTIONAL_LOCKS=0`）和 `sqlite3 -readonly`。

```sh
sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh candidate
sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh body "$FLYWHEEL_EXEC_ID"
```

| 模式 | 输入 | 证明什么 |
|---|---|---|
| `candidate [<检出目录>]` | 缺省取 `$FLYWHEEL_COMM_CLI` 去掉 `/packages/flywheel-comm/dist/index.js` 后的目录 | 候选头身份、撤回基线、机械恢复等价、plan §3.2–§7 与验收补充三条的落点、根因测试文件存在。共 46 项 |
| `body <执行 ID> [<状态库>]` | 状态库缺省取 `$FLYWHEEL_STATE_DB_PATH`；执行 ID 必须是小写 UUID，否则拒绝 | 这个体**当前这次起体**被严格认领（plan §4.2 的 accepted 判据），并打印尝试次数、最后阶段、耗时、调度延迟、原会话拉回记录 |

退出码是四态，后三态都不算通过：

| exit | 含义 | 节点该怎么办 |
|---|---|---|
| 0 | PASS | 继续 |
| 1 | FAIL：某项断言不成立 | 记录原样输出，`ask` Lead，停。不改脚本让它变绿 |
| 2 | UNVERIFIABLE：输入缺失 / 读不到 / 库结构不对 | 同上；报告里写 UNVERIFIABLE，不写 PASS |
| 3 | STALE：候选头已不是本设计核过的头 | 同上；不自己改指纹。新头需要设计节点重新核一遍 |

`body` 只对**活着的体自己**有意义：体退下或停车后 owner 会被关闭，`accepted` 自然变成 no。所以规则是每个体在自己干活时对自己跑，不由别的节点事后代查。

`body` 只查安全投影：不读 `owner_token`、`spawn_nonce`、`binding_json`。

## 5. implement 节点的步骤

前置（不计入账本游标）：`turn` 返回 `yours`；`git status --porcelain` 为空；先 `git merge origin/main` 同步，冲突则 abort 并 `ask` Lead。

账本文件：`engineering/doc/FLY-3143-runner-process-claim/progress.md`，`--phase implement`，游标共 3 步。

| 步 | 做什么 | 完成判据 |
|---|---|---|
| 1/3 | 跑 `candidate` 模式 | exit 0，末两行是 `SUMMARY total=46 fail=0 unverifiable=0` 和 `VERDICT PASS` |
| 2/3 | 跑 `body "$FLYWHEEL_EXEC_ID"` | exit 0，含 `accepted=yes` |
| 3/3 | 新建 `engineering/doc/FLY-3143-runner-process-claim/implementation.md`：抬头四行（同本目录其他文档，`基于: plan.md`）；两次输出各放一个代码块，原样不删行；一节「未执行」照抄 §6 表里标 not_run 的行 | 文件已提交 |

任一步非 exit 0：按 §4 的表处理，不继续后面的步骤。

**范围守卫**（交卷前跑）：

```sh
git diff --name-only "$(git merge-base origin/main HEAD)" HEAD
```

每一行都必须以 `engineering/doc/FLY-3143-runner-process-claim/` 开头，或者正好是 `engineering/doc/milestones/FLY-3143.md`（节点自身协议要求 milestone 时）。出现别的路径就停下 `ask` Lead。

开 PR、代码评审门、CI、`complete` 的命令与顺序，按 implement 节点自己被注入的协议执行，本计划不另立一套。只提醒一个已知的坑：`progress` 每次都会落一个 commit，而代码评审门绑定的是评审时的 HEAD，所以账本 3/3 要在最后一次 push 和发起评审**之前**写完，之后不再落任何 commit。

## 6. qa 节点的裁决表

qa 节点先重跑 `candidate`（头可能已动），再对自己跑 `body`，然后从 `research.md` §4（design 体）和 `implementation.md`（implement 体）读另外两条记录。

| 编号 | 项 | 沙箱节点能否观测 | 通过判据 / 标记 |
|---|---|---|---|
| A1 | 候选头身份与 46 项落点 | 能 | `candidate` exit 0 |
| A2 | 真 Claude 新起认领通过（design 体 `dde8719b`，Claude Code 2.1.286） | 能，已有 | research.md §4：accepted，1 次尝试，1076ms |
| A3 | implement 体新起认领通过 | 能 | implementation.md 里 `body` 输出 exit 0；记下 adapter 是 claude-tmux 还是 codex-tmux |
| A4 | qa 体新起认领通过 | 能 | qa 自己的 `body` 输出 exit 0 |
| A5 | 原会话拉回成功 | 仅当本 run 里真发生了拉回 | 被拉回的体重跑 `body`：`accepted=yes`，且有 `resume_attempt … state=succeeded`。没发生就标 not_run，不算失败也不算通过 |
| B1 | 被标 failed 后恢复（验收补充 2） | 不能 | not_run：沙箱节点无权把体标 failed |
| B2 | 启动对账遇 activation_mismatch 不杀活体（验收补充 3） | 不能 | not_run：需要重启 Bridge |
| B3 | plan §10 其余真机矩阵（Claude 新起 ≥2、同体连续拉回 ≥3、Codex 冷启动 ≥10、近生产负载、例行重启接管、socket 复用、quota pre-auth 原因） | 不能 | not_run：归持有本测试房的生产 QA |
| B4 | 529 e2e flow | 本 run 本身是否算，由 Lead 认定 | qa 节点如实写「本 run 走到了哪些阶段」，不自己宣布 529 通过 |

裁决规则：

- A1–A4 全部 exit 0 → 沙箱合同 PASS。A5 按实际。
- B1–B4 一律写 not_run 和归属，**不得**并入 PASS，也不得因为它们没跑而判 FAIL。
- qa 报告必须有一句原话：「本裁决只覆盖沙箱核验合同，不是 FLY-3143 plan §10 的真机验收。」
- 任何一条是 stub、转述或推断得来的，都不算证据。

## 7. 反向用例（设计节点已实跑）

| 用例 | 输入 | 实测 exit |
|---|---|---|
| N1 头不对 | `candidate <本沙箱工作区>` | 3 |
| N2 目录不存在 | `candidate /nonexistent-dir-fly3143` | 2 |
| N3 没给目录、也没有 `FLYWHEEL_COMM_CLI` | `env -u FLYWHEEL_COMM_CLI sh … candidate` | 2 |
| N4 执行 ID 不是 UUID（含引号的注入串） | `body "x' OR 1=1 --"` | 2 |
| N5 不存在的执行 ID | `body 00000000-0000-0000-0000-000000000000` | 1 |
| N6 状态库读不到 | `body <id> /nonexistent.db` | 2 |
| N7 状态库没有这些表（旧结构） | `body <id> <空库>` | 2 |
| N8 不带模式 | 无参数 | 2 |

另：`shellcheck -s sh verify-candidate.sh` 零告警。

## 8. 回滚与影响面

- 本分支只新增 `engineering/doc/FLY-3143-runner-process-claim/` 下的文档和一个只读脚本。没有迁移、没有配置、没有运行时代码。
- 回滚 = 关 PR、删分支。对候选构建、测试房、生产零影响。
- 脚本里的六个指纹是唯一需要随候选头更新的东西；更新它们等于重新做一次设计核验，由设计节点做，不由 implement / qa 顺手改。

## 9. 待 Lead 裁定（非阻塞）

问题 `aa23e108-28cf-4a06-8873-54292db5c47b`：沙箱里走 A（本计划）、B（镜像生产文档）还是 C（另有指定）。写本文时未回。Lead 若改选，按合同新增 `design-correction.md` 增量修订，不回滚分支。

research.md §5 的缺口 G1–G5 随本计划一并交给 Lead 知悉；其中 G1（验收补充 3 只有保底、根修归 FLY-2127 家族）需要 Lead 确认这是已知裁定。
