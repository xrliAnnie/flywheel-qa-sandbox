# Design Review — plan.md (Round 4)
Date: 2026-09-24
Author: Codex

## Part 1 — R4 (A–D)

Status: APPROVED

### Summary

本轮只复核 commit `8d100b172` 对 Round 3 三项意见的修订。三项均已形成明确、可测试的契约，没有遗留阻断项。

### What's Good (Keep)

- occupancy 的发布 fencing 已覆盖关键乱序：采集一开始即发布 unknown，只有 `generation === latestStarted` 的完成者可以发布共享快照；旧调用仍可把自己的 inventory 返回给自己的 readiness caller，却不能回写共享状态。deferred-promise 用例还把乱序结果连接到了 `rotate()`/`recordInstalling` 的 mutation 断言。
- `observeCodexReadingPipeline` 不再接收 caller 计算的 `healthy`/阈值；store 在同一事务内先验证 `nowIso` 与 `latestObservedAt`（含未来 60 秒上界），再用固定 30 分钟规则推导健康度。非法输入在任何行变更前失败，关闭了重放方伪造健康状态的入口。
- `staleMinutesAtAlert` 在 enqueue 事务中固化到 durable payload；ambiguous send 跨时间重放仍从同一 payload 渲染，正文可保持逐字一致。

### Issues & Recommendations

无 BLOCKING 或 ADVISORY 问题。

### Verdict

APPROVED。Round 3 的三项指定问题均已关闭。

## Part 2 — Readiness R1

Status: CHANGES REQUESTED

### Summary

总体方向正确：每项 relaxation 都以具名谓词和非阻断诊断呈现，不清理宿主、不改 CommDB；test-slot 与 comm shard 使用 realpath；pending vendor、归档目录、terminal keep-alive 均保留默认 fail-closed。源码也支持“不在源头清 `phase_keep_alive`”的裁定：`runnerDoorbellConsumerIsLive` 要求 `running && phase_keep_alive=1`，而 `activateSessionForWake` 复活既有行时不会重写该位。

但当前 §1.6 还没有把进程三快照的时间一致性、stale-running 的持续缺席证据，以及桌面签名的精确解析写成足以安全实现的契约。现有整合 fixture 也不能单独证明每个放行谓词。

### What's Good (Keep)

- `ucomm === "codex"` 取代整行正则，能直接消除 Claude/node/zsh 参数或环境值里的 `codex` 误判；无 `CODEX_HOME` 时只接受 `HOME/.codex` realpath 等于 canonical，也保持了默认拒绝。
- test-slot home 与 comm shard 都以 realpath 后的严格前缀判断，非 slot 链接仍失败；注册项目缺库和 null-vendor 非 pending 行仍失败。
- terminal/keep-alive 不再仅凭陈旧数据库位判活，但有真实进程或批准 home lease 时仍进入原有 process/lease reconciliation，而不是直接宣布安全。
- Q1 在切片 17 前设了明确停点；本意见不评价应选 C 还是 A/B。

### Issues & Recommendations

1. **BLOCKING — 三份 `ps` 输出没有定义一个不会漏掉新 codex、也不会混合两次 exec 身份的权威联结。**

   **Why it matters:** §1.6.1 只说按 `(pid, lstart)` 对齐，但未规定采集顺序与缺行集合的处理。如果先取 `ucomm`，之后才启动的 codex 可只出现在 args/env 中并被忽略，collector 可能错误返回 complete。反过来，`exec()` 会保留 PID 和进程 start time，故 `(pid, lstart)` 只能识别 PID reuse，不能证明三行来自同一个 executable image。与此同时，“去掉参数口径前缀”没有规定必须逐字匹配；若实现为宽松查找，argv 中伪造的 `CODEX_HOME=...` 可被当成环境事实。切片 12 还写成“两次 ps”，与设计中的三份清单不一致。

   **Suggested fix:** 明确一个最终权威快照。优先让最后一次 `ps -axeww` 同行输出 `ucomm` 与含环境的 `command`，此前单独取 args；对最终快照里每个 `ucomm === "codex"` 的 `(pid,lstart)`，必须恰好有一条 args 行，且 env command 必须以该 args command 加明确分隔符逐字开头，否则记全局 `process_home_unknown`。若坚持三次调用，则至少用前后两次 `ucomm` 包住 args/env，并把任一 codex 缺行、重复键、前后分类变化或前缀不匹配设为 unknown；只从精确剥离出的 suffix 解析环境，并拒绝重复的 `CODEX_HOME`/`HOME`/`FLYWHEEL_EXEC_ID`。增加阴性：最终 ucomm 才出现的 codex、同 PID/lstart 发生 exec、args 里含伪环境 token、env 前缀不符、重复环境键；增加 canonical `HOME/.codex` 的正例。

2. **BLOCKING — `comm_stale_running` 用一次缺席快照判定；15 分钟约束年龄的是 session，不是 reader 已缺席的时长。**

   **Why it matters:** CommDB、进程和 lease 是顺序读取的。一个很老的 `running` 行在 daemon 重启或 lease 交接窗口中可能恰好同时看不到进程与 lease；单次采集便把它降为 info，会把短暂空窗误当成长期残留。Lead 批准的三个条件都可能在这一瞬间成立，但真实 credential reader 随即恢复，因而仍需持续缺席证据。另一个实现陷阱是 schema 的 `started_at DEFAULT CURRENT_TIMESTAMP` 形如 `YYYY-MM-DD HH:MM:SS` 且语义为 UTC；在本机直接 `Date.parse` 会按本地时间解释，15 分钟边界会偏移数小时。

   **Suggested fix:** 保留已批准的三个条件，但要求同一 `(comm db/project, execution_id, started_at)` 在两个连续完成的 collector generation 中都满足；第一次仍按 blocking `comm_orphan` 处理，第二次才输出 `comm_stale_running`。任一轮出现 process/lease，或行 identity/status/started_at 改变，立即清除候选；Bridge 重启后从保守的第一轮重新开始。年龄判断使用 SQLite UTC 比较或严格把 SQLite timestamp 规范化为 UTC，非法/null/future 时间 fail-closed。测试要覆盖 first sample blocked → second sample info、两轮之间出现 process、两轮之间出现 lease、row identity 改变、恰好 15 分钟、15 分钟+1 秒及非法时间。

3. **BLOCKING — 桌面身份的 `codesign` 判据按当前文字无法无歧义实现。**

   **Why it matters:** 本机实际 `codesign -dv --verbose=4` 输出到 stderr，且有三条 `Authority`（leaf、Developer ID CA、Apple Root CA），`TeamIdentifier` 则是单独的 `2DC432GLL2`。计划把 “Authority/TeamIdentifier” 描述成一个 `Developer ID Application: ... (2DC432GLL2)` 值；实现者若做单值相等会永远不放行，若做任意 substring 又会削弱身份校验。此谓词直接把真实 credential reader 从 readiness 中排除，必须是精确契约。

   **Suggested fix:** 固定命令参数、timeout/maxBuffer 与输出通道：`--verify` 必须 exit 0；从 `-dv` 的 stderr 解析。要求 leaf（第一条）Authority 精确等于 `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)`，TeamIdentifier 精确且唯一地等于 `2DC432GLL2`；缺失、重复冲突、截断或非零退出一律 unknown。fixture 应包含真实的三条 Authority 形状，并分别变异 leaf 与 TeamIdentifier；缓存测试还应证明 inode 或 mtime 改变会重新验签。

4. **BLOCKING — “7 类一起为绿 + 每类一条阴性”尚不能逐项证明所有 relaxation，且若干安全边界没有对应变异。**

   **Why it matters:** 全量 fixture 只能证明组合结果，不能证明每个具名谓词是唯一使对应残留由红转绿的原因。当前列表尤其缺少：三清单 join 的缺行/重复/前缀失败；canonical HOME 推断正例；slot 路径内的 symlink 实际逃逸到前缀外；terminal keep-alive 的 process-only 与 lease-only 两个 OR 分支（当前只写了“进程与 lease”同时存在）；stale-running 的时间边界和持续缺席；桌面真实多 Authority 输出。

   **Suggested fix:** 在切片 12–16 各增加表驱动的“单一 relaxation”测试：同一个最小 baseline 先断言原 blocker，再只改变一个获准事实断言 complete，随后逐个破坏该事实并断言原原因码。切片 18 的七类组合 fixture 只作为组合回归，不替代这些单项证明。所有 case 同时断言 `complete`、`registeredComplete`、diagnostic reason/scope，以及真实 reader 未被静默丢弃。

5. **ADVISORY — Q1 两个技术分支仍需在裁定后同步收口文档和竞态测试。**

   **Why it matters:** 若选 C，新的授权值与现有 `enabled()`/`runtimeAvailable()` 一样，必须在 `CodexQuotaAvailability.run()` 的 `await check()` 之后读取，否则检查进行中撤销授权仍可能发布 automatic；应有 in-flight true→false 用例。若选 A/B，§0 的“本单不开启生产 activation”和 QA 表的“由 §1.6.8 的闸挡住”将不再成立；B 还需要把 FLY-2729 的实现切片与证据显式加入后才能启动切片 17。

   **Suggested fix:** founder 裁定后删除未选分支并同步 §0、§1.6.8、切片 17 与 QA 诚实边界；C 增加 await 期间撤权测试，A/B 则把“合并即启用”作为验收与交卷的显式前置事实。本项不主张任何 Q1 产品选择。

### Verdict

CHANGES REQUESTED。方向与 Lead 裁定一致，但必须先补齐进程快照联结、stale-running 持续缺席、桌面签名精确解析和逐谓词测试矩阵，才能证明这些 relaxation 不会把真实 credential reader 放行。
