# R14 收紧之后的双向对照（Tadashi 硬性附加 1）

分析器 commit: 见下面每个 json 里的 `freeze_commit` 对照；本目录产出于 `e9f51f0b8` 之后。
fixture 来源: Codex R14 自建（`/tmp/fly2007-r14/fixtures/`），receipt 的 freeze commit 已重新盖章到当前 commit，state 的 artifact 哈希随之重算。

## 为什么必须有这张表

R14 抓到的三个 HIGH 全部是「分析器信了它该核验的东西」，修法一律是**收紧**。
收紧有一个显而易见的失败模式：**把一切都推成 U**。
一个永远只会说「无法认证」的判据和一个永远说「达标」的判据一样没用。

⇒ 所以每次收紧都必须同时亮出**两个方向**：坏输入被拒，**且**好输入仍然能到 A。

## 结果

| fixture | 期望 | 实测 |
|---|---|---|
| `valid-a` — 完全合法的全违约窗 | **A** | ✅ **A**（lower bound exceeds the SLO） |
| `legal-replacement-a` — 一次 `operator_credential` 失败 + 同窗恰一个具名 `replacement_of` 替换窗 | **A** | ✅ **A** |
| `config-fault-marked-valid` — 样本带 `no_token`，summary 谎称 `block_valid=true` | **U** | ✅ **U**（点名 configuration fault） |
| `completed-service-failure` — canonical state 自相矛盾：`completed` + `health_unreachable` + `exit_code=1` | **U** | ✅ **U** |
| `non-numeric-conservative` — 点估计填字面量 `not-a-number` | **U** | ✅ **U**（点名 is not a number） |

⇒ **三个坏输入全被拒，两个好输入仍然到 A。** 收紧没有把判据变成一台只会说 U 的机器。

⚠ 前三条（U 的那三个）用 `--sim-m 400` 跑，因为它们在资格门就被拒、不需要冻结 M；
两条 A 用**冻结 M** 跑，因为 A 是需要完整敏感性证据才能声称的那一侧。

## 顺带记一条

`valid-a` 与 `legal-replacement-a` 第一次重跑时给的是 **U**，原因是 R14 的 fixture 里
receipt 写的是**旧** freeze commit —— 那是冻结绑定在正常工作，不是回归。
重新盖章之后两条都到 A。**这件事本身也是一次对照**：它证明 freeze 绑定确实会拦。
