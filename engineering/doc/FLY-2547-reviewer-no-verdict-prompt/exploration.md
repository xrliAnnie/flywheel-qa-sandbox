# FLY-2547 评审体 end_turn 无判决 — 探索

Issue: FLY-2547 (https://linear.app/geoforge3d/issue/FLY-2547/病根-跨家族-claude-评审作业-end-turn-无判决-no-verdict门关到-lead-令体同-requestid)
日期: 2026-09-22
基于: 无

## 现象

跨家族 Claude 评审作业（Codex 实现体 → Claude 评审 lane）在 97–300s 内以 `stop_reason=end_turn`
结束，但输出里没有判决 JSON。`claude-review-runner.ts:553` 的 `parseClaudeReviewOutput(res.stdout)`
返回 null，于是 runner 返回 `{ kind: "failed", reason: "no_verdict" }`，
`codex_review_job.status=failed / failure_reason=no_verdict`，评审门保持关闭，
告警要求 Lead 令实现体用**同一 requestId** 重放一次。

class_key 已累计 5 次（首见 2026-09-14T04:58:05Z）。

## 确定性复现（Lead 2026-09-22 提供）

FLY-2770 PR #1283 同一个头上 4/4 复现。评审体 result 原话：
「等完成通知即可，结果到了就出结论」。

也就是说：评审体把长测试套件**放到后台**（`&` / background bash），然后**结束回合**去等通知。
但 `claude -p` 是一次性 headless 会话——回合结束即会话结束，通知永远不会到达，
进程退出码 0、stdout 里没有判决 JSON → `no_verdict`。
四次各 6–8 分钟、$5–7。

## 病根定位

`packages/teamlead/src/bridge/review-request-coordinator.ts` 的 `buildPrompt`，
`legacyContract` 字符串（2399–2407 行）。它对输出格式讲得很细：

```
When done, output ONLY a JSON object: {...}.
No prose outside the JSON. Your very last line must be that JSON object itself.
```

但它对**回合生命周期**只字未提：
- 没说「测试必须前台同步跑完」；
- 没说「禁止把命令放后台后结束回合等通知」；
- 没给「套件太慢时怎么办」的出路——评审体只剩「等」这一条路，于是它等，然后回合结束。

`When done` 这个前提本身是隐含的：评审体判断自己 "not done"，于是合理地选择了结束回合等通知，
而 headless 会话里这个选择等价于自杀。

## 不是病根的地方

- 判决解析 (`parseClaudeReviewOutput`)：它正确地拒绝把无判决输出当判决，这是 §7.2 的 fail-closed 设计，不能动。
- `no_verdict` 重试状态机 (`review-request-coordinator.ts:2110`、`StateStore.ts:20234`)：它正确地把
  连续 `no_verdict` 记成同一代的失败并要求 Lead 重放，也不该动。
- 会话复用 (`codex_review_reuse_binding`)：形状里「同一评审会话跨头复用后更快复发」是观察到的线索，
  但 9/22 的 4/4 同头复现说明会话复用**不是**必要条件——同一个新会话也能稳定复现。
  会话复用只会让上下文里已有的「后台任务」习惯更早出现。

## 结论

改 prompt，给评审体三层语义：
1. 前台同步跑完测试再出判决；
2. 禁止「放后台 + 结束回合等通知」，并说明为什么（回合结束即会话结束，通知永不到达）；
3. 超时出路——基于已有证据出判决，并在 findings 里加一条 `severity: LOW, title: tests_incomplete`
   说明哪些套件没跑完。

第 3 条是关键：只有禁令没有出路，评审体在慢套件上仍然会卡住，只是换一种卡法。
