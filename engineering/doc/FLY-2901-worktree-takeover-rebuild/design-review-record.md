# FLY-2901 接管失败自动重建 — 设计评审记录
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-25
基于: plan.md（v5 blob 8dece7c798b3c9c6a2dd93a360fdec2462e432e6；v5.1 仅加 R5 MEDIUM 一句）

| 轮次 | 结论 | 原文 |
|---|---|---|
| R1 | CHANGES REQUESTED（7 blocking / 2 advisory） | codex-review-round1.md |
| R2 | CHANGES REQUESTED（5 / 3） | codex-review-round2.md |
| R3 | CHANGES REQUESTED（2 / 2） | codex-review-round3.md |
| R4（限定范围，Lead 批准） | CHANGES REQUESTED（1 / 1）；R3 全部关闭 | codex-review-round4.md |
| 最终 | **effective APPROVED（Engineering Lead 裁定，question 13c1a99d-cb77-474e-a8ce-1c7866f7a895）** | 下文 |
| R5（实现开头补做，限定 v4→v5 delta，Lead 2026-09-26 指示） | **APPROVED**（0 BLOCKER / 0 HIGH / 1 MEDIUM：`nestedMoves[]` 稳定排序 + 复用 `canonicalJsonString`，已并入 plan v5.1 §4.5 与实现） | codex-review-round5.md |

评审者：Codex（companion 会话 `01a0daf5-504b-7922-9919-6cfd0f9f99c5`，xhigh；manifest 未指定 reviewer 模型，使用 companion 默认模型）。
Bridge 门：requestId `baa1d750-439d-4c26-ab45-c44ba3a397c8`，`await-codex-gate design` 返回 APPROVED。

## Lead 裁定原文

> 选 (B)：v5 给 effective APPROVED（Lead 裁定）。理由：R4 确认 R3 的两个 blocker + 两个 advisory 全关；v4 自引入的那条是「manifest 写自身哈希」这种字面不可实现的机械问题，v5 的修法（确定性序列化、对确切字节算 sha256、只放事件 payload、重入先核字节哈希再逐字段比对 + 一字节篡改测试）是标准做法，不改架构、不碰「抢救不丢工作」的主线。在 design-review.json 里记 leadAcceptance：审查轮次 R1–R4 结论 + 本条裁定原文 + 那条 advisory 已照改；实现阶段的代码评审要专门核这处哈希实现和篡改测试。然后照常 phase_design_complete。

R4 advisory（`generationBefore: string | null`、统一 `nestedMoves[]`）已在 v5 照改。

## 给实现阶段的交接要点
- **代码评审必核**：manifest 按确定性字节算 sha256、哈希只进事件 payload；一字节篡改测试。
- 设计期 Lead 裁定（plan §1）：FLY-2122 阴性对照新口径 a/b；`.flywheel/review-targets/` 根治；两条 exclude 精确行；救援产物不自动回收（至少到 ship 后）；救援 ref 名带 exec id 与时间。
- 本机只跑相关测试；跑前排除 `**/tmux-viewer.macos.test.ts`；跑 teamlead `startBridge` 类用例前隔离 `FLYWHEEL_CODEX_HOMES_ROOT`。

## 重派复核（run afd81b64，设计节点 exec 96937f70，2026-09-26）

引擎对同一 plan blob `4428ecb7` 重新发 design-review manifest（requestId `99c347e1-608a-413c-8a26-7808e937eb59`），服务端指定 **gpt-6-astra xhigh**（R1–R5 用的是 companion 默认模型）。

| 轮次 | 评审对象 | 结论 | 原文 |
|---|---|---|---|
| R6（全量） | plan 4428ecb7（未改） | CHANGES REQUESTED：0 BLOCKER / 1 HIGH——被忽略的未跟踪内容可被原地 `reset --hard` / `clean -fd` 静默删除或覆盖，事务仍报零丢失成功（真 Git + 分支上真实事务源码复现） | codex-review-round6.md、repro-r6/ |
| Lead 裁定 | — | **(A)** 本单修：新增 §4.7a 忽略内容保全门 + 两条真 Git 回归；这一处定向复核；其余设计不动 | gate question |
| R6-2（限定 §4.7a） | f28e6851 | CHANGES REQUESTED：2 HIGH（`target==H` 早退漏掉工作区未提交的 `.gitignore`；安全根被否定规则绕过） | codex-review-round6-2.md、repro-r6-2/ |
| R6-3（限定 §4.7a） | 89260d6b | CHANGES REQUESTED：3 HIGH（`--directory` 枚举被同名 index 文件遮住；`.GITIGNORE` 大小写别名；树内 `core.excludesFile`）。之后改做减法：不再枚举忽略内容，只核 reset 会写的路径集 `D` + 规则源 | codex-review-round6-3.md、repro-r6-3/ |
| R6-4（限定 §4.7a） | 794f3515 → b6d20548 | **无结论**：同一线程两次被 Codex 服务端内容过滤中断。留下执行证据：17 例全过；另两条边界（assume-unchanged、默认 XDG 全局忽略文件）会丢 → 补 (f)、扩 (e) | codex-review-round6-4.md、repro-r6-4/ |
| Lead 裁定 | — | **(B)**：personal1 全新线程纯书面只审 (e)(f)；拿到 HIGH 就停下问 | gate question |
| R6-5（纯书面，0 条命令） | b6d20548 | CHANGES REQUESTED：1 HIGH——树内被跟踪的 symlink 可改变 git 读到的树外全局忽略文件；(e) 只看最终 realpath 不够 | codex-review-round6-5.md |
| 最终 | v5.2（本提交） | **effective APPROVED（Lead 裁定 A1）**：把整条 symlink 解析链检查补进 (e) + 第 5 条论证 + 回归用例（先红后绿），不再送审 | 下文 |

Lead A1 裁定原文：
> 裁 A1：把整条 symlink 解析链检查补进 (e) + item 5（先取未解析的绝对路径名，逐段 lstat 跟随 symlink，记录经过的每个路径名，任一落在工作树内——字面路径与 realpath 都比——即拒，保持保守拒绝），再加一条回归用例（先红后绿）。不再送审：Lead effective APPROVED（leadAcceptance），记录 R6→R6-5 全部轮次与残余『(e) 最终措辞无 Codex 书面确认』。实现阶段代码评审专门核 §4.7a (a)–(f) 全部分支与回归。

**残余**：§4.7a (e) 的最终措辞（整条解析链）无 Codex 书面确认。
**给实现阶段（新增，必做）**：
- 按 §4.7a 实现 `assertIgnoredContentSafe`（(a)–(f)），两处调用点（首次在任何保全写入前；第二次在破坏阶段第一步、含崩溃重入）；停手原因 `ignored_content_at_risk` 不可关闭。
- §10 新增的全部 v5.2 回归行都要真 Git 实现，并先见红后见绿；R6 / R6-2 / R6-3 / R6-4 的复现脚本在各 `repro-r6*/` 目录，可直接改写为用例。
- **代码评审必须专门核 §4.7a (a)–(f) 全部分支与回归。**

评审执行说明：R6 用原登录账号；该账号额度耗尽（至 10/1）后，R6-2 起按记忆配方把池快照 `auth.json` 拷进隔离 `CODEX_HOME` 运行（shopping：R6-2～R6-4；personal1：R6-5），未改动共享 `~/.codex/auth.json`。
