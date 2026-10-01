# FLY-3143 Runner 进程认领：沙箱核验与交接 — 调研
Issue: FLY-3143 (https://linear.app/geoforge3d/issue/FLY-3143/急起体-1238-pdt-起-runner-起体-原会话续跑的进程认领时好时坏claude-全部失败codex-也有失败process)
日期: 2026-10-01
基于: exploration.md

## 1. 方法与来源

全部只读。没有改候选检出、房间状态库、生产仓，也没有起体、停体、重启任何东西。

- **候选头**：测试房源码检出，HEAD `d7d72733b101472bd82236b558906f9c90d0e4d4`（= 生产 PR #1431 的头）。下文「候选头」都指它。
- **已批准 plan**：候选头上的 `engineering/doc/FLY-3143-runner-process-claim/plan.md`，blob `5e27094f7a3ad0573b52e1d92f8e361525b3dafd`。下文写「plan §x」都指这份，不指本目录的 plan.md。
- **房间状态库**：`$FLYWHEEL_STATE_DB_PATH`，用 `sqlite3 -readonly` 查，只取安全投影字段。
- **核验脚本**：本目录 `verify-candidate.sh`，把下面的检查固化成可重跑的命令。

## 2. 已批准 plan 在候选头的落点

`sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh candidate`，2026-10-01 10:07Z 前后实跑：`SUMMARY total=46 fail=0 unverifiable=0`，`VERDICT PASS`，exit 0。

| 检查 | 对应 plan | 结果 |
|---|---|---|
| C1–C3 候选树干净；plan 文本 blob 与 R3 评审 blob 都在 | 状态行 | PASS |
| B1 头建立在撤回提交 `be24a1b57` 之上 | §1 | PASS |
| B2 机械恢复提交 `4c6fb9a86` 与原 2919 `ef5899b51` 在 `packages scripts .github` 下只差 1 个文件（FLY-3123 的 fixture） | §3.1 | PASS |
| Q1–Q3 三个索引 | §3.2 | PASS |
| R1–R3 owner 屏障列、屏障行读作 unknown、旧行对账模块 | §3.3 | PASS |
| D1 绑定窗口仍是 30 秒；D2–D3 诊断投影列；D4 十九个失败原因的封闭枚举 | §4、§5 | PASS |
| E1–E3 有界排空证明、typed cause、pre-auth 拒绝保留原码 | §6.2、§7 | PASS |
| S1a–S3c 验收补充三条的机制（见 §3） | 派单 | PASS |
| T1–T2 根因回归测试文件在头上 | §8 | PASS |

这些是「落点存在」的证据：字面量在候选头的指定文件里。它**不是**行为证据——行为由候选头自己的测试和真机验收证明，见 §3、§5。

## 3. 验收补充三条 → 机制 → 测试

### 3.1 补充 1：评论 9dcd9313 的三种形状

评论原文本会话读不到（Linear 401）。形状定义取自候选头 `implementation.md` 的归类。

| 形状 | 候选头的机制 | 候选头上的测试 |
|---|---|---|
| 1 窗口判死 / 陈旧 failed 标签 | 僵尸判定只走身体真源；已被误标的体在续跑接管或 holder 唤醒时带审计撤销 | 见 3.2 |
| 2 停车体没有绑定，清理永远 `liveness_unknown` | `execution-body-reader.ts` 的 `proveParkedAbsence`：没有决定性样本时，用严格排空普查判「已离开」，只当清理证据，不当死亡 | `execution-body-reader.test.ts:226`、`process-owner-reconcile.test.ts:898`、`:914`（负控） |
| 3 采纳被拒后杀活体 | 见 3.3 | 见 3.3 |

### 3.2 补充 2：被 Bridge 标 failed 的体

今晚两种卡法，各自对到的代码：

**(a) Claude 原会话拉回被拒「session is terminal (failed)」。** 这句报错出自 `pane-loss-reconcile.ts:92` 的 `persistPaneLossGenerationCredential`（claude-tmux 起体回调，会话处于终态就抛）。这个文件在候选头与原 2919 逐字节相同，没改。修法在它**上游**：`StateStore.ts` 的续跑接管事务（约 53395 行）先判断，再在同一事务里把停车体的陈旧 failed 撤销成 `ship_parked`（trigger `resume_stale_terminal_revived`），之后才起体，回调看到的就不再是终态。

- 能撤销的条件（`isStaleTerminalWorkflowSession`）：状态是 failed、这一代**没有**身体死亡决定、activation 仍是当前的。
- 不能撤销（真有死亡决定）：整个续跑在任何写入之前被拒，原因 `resume_session_terminal`，交替身路径。
- 测试：`StateStore.generalized-execution.test.ts:6034`（撤销）、`:6099`、`:6200`（有死亡决定绝不撤销）。

**(b) Codex QA 返工投递 `actor_session_terminal:failed:supersession_close_failed`，replacementCount=0。** 出自 `workflow-rework-coordinator.ts`。候选头在判终态之前加了一步（约 1293 行）：failed 且身体真源探到 alive → 不走「未证实死亡」，改由 holder 唤醒撤销标签后继续投递（`holder-wake-activation.ts`，trigger `wake_stale_terminal_revived`，只在 alive 时撤销，unknown / dead 不撤）。

- 测试：`workflow-rework-coordinator.test.ts:1483`、`holder-wake-activation.test.ts:210`。
- 体确实死了、也不是停车体：仍走「未证实死亡」→ 关窗 → 等证明 → 替身。替身铸造归 FLY-3041，不在本单。

### 3.3 补充 3：新 Bridge 启动对账把停车等依赖的 Codex 体判 activation_mismatch 并关窗

实例：FLY-2127 体 `50214a52`，`thread/resume timed out` → `resident hold refused` → 窗被关。

候选头的做法是**保底**，不是根修：

| 保证 | 落点 | 测试 |
|---|---|---|
| 采纳被拒（resident hold refused）时不 stop、不杀窗、不 fence owner | `CodexTmuxAdapter.ts`（`ResidentHoldRefusedError` 分支）、`codex-daemon-goal-runtime.ts` | `CodexTmuxAdapter.test.ts:6066`、`:6141` |
| 放手的采纳不发 failed / completed | `run-infra.ts:552`、`adapter-types.ts` 的 `adoptionReleased` | `run-infra-codex-recovery.test.ts:339` |
| 原因（预期 / 实际 activation）写进 bridge.log 和 last_error，并跳过该体后续采纳 | `codex-session-reown.ts`（`codex_adoption_unsupported`） | `codex-session-reown.test.ts:1132`、`:1183` |

**没有做的**：让 reown 用当前 activation 重新进入 hold（真正让这种体恢复受管）。候选头 `implementation.md` §4 记录这是 Lead 裁定 `2f265349` 定的范围，根修归 FLY-2127 家族。该裁定原文本体没有读到，只见到实现记录里的转述——列为缺口 G1。

## 4. 真机观测 O1：本体自己的出生

`sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh body dde8719b-2145-40f1-afdc-ec4668fd59c1`，exit 0：

| 字段 | 值 |
|---|---|
| adapter / 可执行版本 | claude-tmux / 2.1.286 |
| 认领结果 | accepted（`spawn_inflight=0`，`binding_spawn_epoch=spawn_epoch=1`，`close_requested=0`，`reconcile_required=0`） |
| 尝试次数 | 1 |
| 十项检查 | input、boot、leader、group、worker、candidate、sample、writers、daemon、nonce 全部 pass，首次满足都在 1076ms |
| 耗时 | 总 1076ms，其中系统探测 1060ms，主线程调度延迟 10ms |
| 进程组 | 2 个进程（上限 32），唯一候选，nonce writer 1 个 |
| session.last_error | 空 |

同一个体跑 `resume` 模式返回 exit 4（NOT_RUN）：本体是新起的，没有被原会话拉回过。

这是派单要的「真 Claude 新起认领通过」的一次真实样本，跑在当前 Claude Code 2.1.286 和候选构建上，新诊断列逐项记了时间线。

**它不证明什么**：这个测试房的 Bridge 很闲（调度延迟 10ms），不是近生产负载；只有 1 次；不是原会话拉回，也不是 failed 后恢复。plan §10 要的次数和负载，这一条顶不了。

## 5. 缺口与边界

| 编号 | 缺口 | 处置 |
|---|---|---|
| G1 | 补充 3 只有保底，没有根修；依据的 Lead 裁定 `2f265349` 本体未见原文 | 已在给 Lead 的问题里点出；QA 验的是保底四条（不杀、不 fence、不标 failed、不交还 Lead），不是「恢复受管」 |
| G2 | 死透且非停车的 failed 体，替身铸造不在本单 | 归 FLY-3041；本单只保证 failed 标签不挡活体和可拉回体 |
| G3 | plan §10 的真机矩阵（Claude 新起 ≥2、同体连续拉回 ≥3、Codex 冷启动 ≥10、近生产负载、Bridge 例行重启接管、socket 复用、quota pre-auth 拒绝）沙箱节点做不了 | 归持有本测试房的生产 QA；沙箱节点只贡献「本工作流各体自己的出生 / 拉回」样本，其余如实标 not_run |
| G4 | 正在跑的 `dist` 与源码是否逐字节对应，核不了 | 脚本只证源码头；构建指纹由生产 QA 按 plan §10 末段绑定 |
| G5 | 9dcd9313、6c9541eb 评论原文读不到 | 形状定义引自候选头实现记录；Lead 如发现归类与评论不符，按 `design-correction.md` 修 |

## 6. 给 plan 的输入

- 不新增设计；本目录 plan.md 只定沙箱后续节点做什么、不做什么。
- 唯一真源：设计 = 候选头的 plan.md（按 blob 引用）；核验 = `verify-candidate.sh`。本目录文档不复述 plan 正文。
- 候选头一旦移动，脚本返回 STALE（exit 3），后续节点停下问 Lead，不自己改指纹。

## 7. 设计评审 R1 的修正

Codex（gpt-6-astra / xhigh）R1 要求修改，三条都采纳：

| 级别 | 问题 | 修正 |
|---|---|---|
| 高 | 执行 ID 校验用了按行匹配的 `grep`，多行参数里只要有一行是 UUID 就放行，其余内容被拼进 SQL，评审者实测注入后返回 PASS | 改成整串校验（长度、字符集、连字符位置），拼查询之前就拒；判定只读 SQL 用固定字面量算出的头三行 |
| 中 | 「拉回成功」只看有没有一条 `succeeded`，旧代次的成功会被当成当前这次 | 新增 `resume` 模式，只认体当前代次的那次尝试，并要求认领与代次一致；进行中、失败、未尝试各有独立退出码 |
| 低 | plan 里的 shellcheck 命令在仓库根跑不通 | 改成完整路径 |

修正后的反向用例固化在 `verify-candidate.test.sh`（25 条，全过）。评审者给的注入复现串对真实状态库复测：exit 2。
