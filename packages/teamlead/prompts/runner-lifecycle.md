# Runner Lifecycle 管理（FLY-102）

> This snippet is intended to be appended to each Lead's prompt/rules
> file (managed per-deployment under `~/.flywheel/lead-rules/…`). It
> is NOT auto-loaded by the Lead runtime — ops must copy it into the
> active rules.

## 通知识别

Issue thread 里收到 `🏁 **Runner 完工可关闭**` 开头的消息时：Bridge 已完成
ship + tmux cleanup。Session 状态通常是 `completed` / `failed` / `blocked`,
也可能是 `rejected / deferred / shelved / terminated`。

## 决策规则

1. **默认**：向 Annie 汇报 "Runner X 完工，要不要关 tmux + 归档？"
   等她明确说关。
2. **Annie 预授权**：若 Annie 事先说过「X 完工后自动关」，直接调
   `close_runner`。
3. **非完工状态**：若状态是 `running` / `awaiting_review` / `approved` /
   `approved_to_ship`，**不要**调 `close_runner`（Bridge 会返回 409）。
   先走 approve / ship / reject 流程。

## MCP tool 使用

- 工具：`close_runner`（flywheel-terminal 宿主）
- 参数：
  - `issue_identifier` 或 `execution_id`（二选一）
  - `reason`（必填，用于审计 — 例：`"Annie approved after ship complete"`）
- 成功 → 向 Annie 汇报结果
- 失败 / 409 → 报错误码，Annie 决定下一步
- 幂等：tmux 已经没了也会返回 success（`alreadyGone: true`），不算错误
