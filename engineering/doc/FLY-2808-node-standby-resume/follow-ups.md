# FLY-2808 非阻塞评审建议 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-22
基于: plan.md、review-receipt.json

有效设计 verdict=APPROVED（R2）。Lead 后续授权本单直接实现；以下 disposition 只说明当前代码是否覆盖建议，完整 findingKey 和理由仍见 review-receipt.json。生产与真实 QA 证据仍未执行。

| 优先级 | findingKey | 后续建议 / 验收关注 |
|---|---|---|
| MEDIUM | sweep-scope-misses-core-and-claude-runner | 已覆盖 core adapter contract、Claude/Codex adapter、completion/rework、Heartbeat、pane loss、auto reowner、expiry、recipient 与 fault budget；validation 记录消费者搜索及排除项 |
| MEDIUM | stale-worktree-context-after-head-advance | 已实现 lastObservedHead/current HEAD/dirty 比对，并在恢复首轮 prompt 前注入重读提示；真实模型收到提示待独立 QA |
| MEDIUM | single-issue-scope-vs-incremental-pr-landing | Lead 明确要求当前一张 PR 完成完整默认关闭实现；仍保留小提交、独立 code review/QA，未获得 ship 权限 |
| LOW | pane-loss-reconcile-missing-from-closure-list | 已接线：confirmed standby 跳过 pane-loss/monitor-lost 误报，并有定向测试 |
| LOW | carrier-term-collides-with-existing-ship-gate-carrier | 实现采用 `process_body` / process lifecycle 命名，未引入新的裸 `carrier` 类型 |

以上“已覆盖”只指当前分支源代码和定向本地证明，不表示生产启用或 QA 通过。

## 实现 code review R2 disposition

旧 head `3f03ea22` 的 gate `0afda40e-8a35-4302-bbb2-7e6687293f06` 为 `CHANGES_REQUESTED`。三个 HIGH（共享工作树被重建、失败后孤儿进程、无 lease 的永久 resuming）与 substantive MEDIUM 已在后续代码提交修正，并由当前 code-head focused/related/build/typecheck 复核；必须对新的 exact head 再请求 review，旧 verdict 不可复用。

仍保留两项 LOW，避免为默认关闭路径提前引入新的 scheduler 抽象：

- 同 worktree 串行、跨 worktree 最大 2 的 admission/queue limiter 尚未实现；设计默认值保留给后续实现单。
- `queueMs` 仍是占位，`totalMs` 当前止于身份确认而非首个模型消费回执；需要后续定义并接入可审计 receipt。

## 实现 code review R3 disposition

旧 head `09d931b99` 的有效 verdict 为 `CHANGES_REQUESTED`。本轮按 Ponytail 只处理评审指出的现有路径，没有新增 scheduler 或监控抽象：

- HIGH：恢复失败不再调用只接受终态 session 的通用 teardown；新增的物理 cleanup 只接受精确 process generation/demand/owner fence，保留 workflow lifecycle/CommDB 状态，并在 execution-wide liveness 证实死亡后才返回成功。cleanup 未确认仍阻止重试和 fresh fallback。
- HIGH：resume 同时观察 `StartResult.launchOutcome` 与身份回报。`absent`/`cleaned` 的 precommit failure 不做破坏性 cleanup；已启动或证据 unknown 才进入上述 fence 清理，避免后台 launch 留活。
- MEDIUM：resume lease 从 180 秒增至 5 分钟，明确长于 180 秒身份超时；非 generalized resume 也可选择观测 launch outcome。
- LOW：Claude/Codex adapter 的 `onRetired` observer 异常被隔离，不再把已成功 launch 改写为失败。

R3 关于 limiter、`queueMs`/首个模型消费 receipt 的 LOW 建议与 R2 已记录的两项相同，继续保留为后续单，未在默认关闭实现中提前扩面。以上 disposition 仍需新的 exact-head code review 才能生效，不能复用 R3 旧头 verdict。

## 实现 code review R4 advisories

Exact head `a351d044b` 的 R4 effective verdict 为 `APPROVED`；以下建议不阻塞该 review，但已通过 `ask --report` 交给 Lead：

- MEDIUM `resume-cleanup-unconfirmed-permanent-latch`：`cleanup_unconfirmed` 已只在物理死亡无法证明时 fail closed，但仍缺少 Lead 可审计的 reopen 操作；同时 founder activity DTO 对该 latch 仍可能投影 `canResume: true`。需后续把人工解锁权限、审计 receipt 与 `canResume` 语义一并设计，不能以直接改库代替。
- LOW `resume-metrics-and-concurrency-caps-missing`：与 R2/R3 已记录项相同，仍缺同 worktree 串行、跨 worktree 最大 2，以及 queue/首模型消费时点的准确 receipt。

QA full CI 后的首轮 implement rework 只修复 feature-flag governance 红项，没有修改无关真实 tmux/load-probe 测试。由于 head 已移动，R4 approval 不能绑定新头。

## 实现 code review R5 advisories 与 Lead 必修 disposition

R5 gate `14b2c500-dc14-46e4-9207-826823ffa26f` / request `4480df89-00ae-4bab-aac8-aac34fd81bc5` 对旧 head `b39a2ea75` effective verdict 为 `APPROVED`。Lead 随后以 `[lead-instruction ec413437-959a-4757-8b3a-d1d6f6e76d4d]` 明确要求交卷前处理 cleanup latch，因此该项不再作为可选 follow-up：

- MEDIUM `resume-cleanup-unconfirmed-permanent-latch`：已覆盖。latch 期间 founder activity DTO 返回 `canResume=false`；master-token-only、无 `/api/actions` alias 的审计 route 事务内记录 server-derived actor、时间、原因和 prior attempt 边界，再将 reason 改为 `operator_reopened`。旧尝试保留可审计，新的 resume budget 从审计边界后重新计数；fault replacement 额度不受影响。先红后绿与权限负例见 validation.md。
- MEDIUM `standby-enrollment-misses-two-admission-paths`：已在 QA 529 返工覆盖。fresh run 首节点与 Lead retry 都在 admission 时读取同一个 governed flag resolver 并传 `standbyResumeEnabled`；正例分别断言 generation 1 process body 建立，默认缺省仍为 false。没有引入第二套 flag read 或新抽象。
- LOW `resume-metrics-and-concurrency-caps-missing`：仍保留。缺同 worktree 串行、跨 worktree 最大 2，以及真实 queue/首模型消费 receipt。
- LOW `admit-env-param-now-dead`：仍保留。flag 已改走 governed boolean 后，admission API 的 `env` 参数不再使用；后续删除该参数及调用方传值，不重新引入 env flag read。

plan 批准后的追加实现与历次修正均通过 scoped code review 重新绑定移动后的 head；本轮 Lead 必修提交后仍必须以 literal-last exact head 请求 R6。R5 approval 不能复用为当前头证据。
