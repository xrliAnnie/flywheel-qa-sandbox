# FLY-2298 founder_review 等待判据 — 调研
Issue: FLY-2298 (https://linear.app/geoforge3d/issue/FLY-2298/病根-dwell-的是否等-founder判据不认-founder-review-卡-question-checkpoint)
日期: 2026-09-06
基于: exploration.md

## 当前实现

`scripts/lead-patrol-snapshot.sh` 在 `classified` CTE 中决定 route：

- `node_id='founder_gate' AND state='review'` 直接进入 `founder_reminder`；
- 当前 `workflow_gate_holder` 精确绑定 `approve_to_ship` open question 时进入 `founder_reminder`；
- 旧数据没有 holder 时，才用 question sender 到 CommDB session 的唯一 project/issue 映射；
- 其余在场节点进入 `deep_dive`。

脚本随后以 node admission、`workflow_gate_holder` 活动、founder thread 活动三者最大值计算 `episode_started_at`。`node_dwell_review.verdict='waiting_founder'` 的最新 receipt 若不早于该起点，就设置 `waiting_episode_reminded=yes`，阻止相同 episode 再次提醒。

`packages/teamlead/src/node-dwell-control.ts` 是 shell 与 CommDB question domain 之间的受信 helper。现有 `open-approve-gates` 子命令只调用 `CommDB.getOpenGatesByCheckpoint('approve_to_ship')`，以 hex 编码输出 question id 与 sender，避免把数据库字符串插入 SQL 时发生 shell/SQL 注入。快照严格解析行数与字段后才构造 CTE；任何 schema 或解析异常都会 fail closed。

## founder_review 的现成语义

`CommDB.getOpenGatesByCheckpoint()` 的 canonical open predicate 已排除 `terminal_disposed`、`superseded_at IS NOT NULL` 与已有 response 的 question。它故意忽略 cleanup TTL，因此 durable 的未答 authority 不会只因时间流逝而消失。

`relay_state='protected'` 不是「founder 已拿到可回答卡」的可靠证据：它是 Bridge 投递过程中的 best-effort side effect，CAS 失败后投递仍可继续。真正的 durable card fact 是 StateStore 的 `founder_review_card_binding`：按 question id 唯一绑定 `run_id`、artifact digest 与 card `created_at`，并由 no-update/no-delete trigger 保持 immutable。sender (`from_agent`) 则是发卡节点的 execution id。因此第三判据可以同时使用：

```text
question.checkpoint = founder_review
question 尚未 answer/supersede/terminal dispose
founder_review_card_binding.question_id = question.id
founder_review_card_binding.run_id = active node.run_id
question.from_agent = active node.execution_id
```

这比「同 issue 有卡」更窄：同一 issue 内其他仍在工作的节点不会被错误豁免，复用 execution id 的其他 run 也不会串卡。它也不解析 question raw `content`：大于 content-ref 阈值的合法 founder_review 会把 JSON spill 到文件，直接解析 projection row 会把整个 DWELL 维度错误打成 unavailable。

## Episode 重新武装

若只补 route 判据，而不把 founder_review 卡活动接入 `episode_started_at`，新 round 可能被旧 round 的 `waiting_founder` receipt 永久压住。快照按当前 run + execution 取最新 open question 所绑定 card 的 immutable `created_at`，并与既有三类 episode 事实一起取最大值。

结果是：

- 同一张卡随时间变老不会重新武装；
- founder 回复后 open predicate 消失；
- 节点按修改再次开一张更新的 review 卡时，新 question 时间形成新 episode；
- founder thread 活动和既有 approve gate state/head 活动仍按原逻辑重新武装。

## 测试与变更面

- `packages/teamlead/src/__tests__/node-dwell-control.test.ts`：锁住 canonical open founder_review question id/sender projection，以及 answered、superseded、terminal disposed 的负向行为；不引入 raw content 解析。
- `scripts/__tests__/lead-patrol-snapshot.test.sh`：构造普通 `pm` 节点 + 当前 run 的 immutable card binding + open `founder_review`，先红后绿；验证同 episode receipt 抑制、新 round 重武装，以及缺 binding、其他 run/execution 不误命中。
- `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts` 与 `runner-patrol-rules.md`：把「两个判据」改为三个，明确第三条的 exact run/execution、canonical open question 与 immutable card binding 语义。
- 生产代码限定在 `node-dwell-control.ts` 和 `lead-patrol-snapshot.sh`；不改 schema、阈值、owner attribution、receipt writer、提醒发送器或 workflow engine。
