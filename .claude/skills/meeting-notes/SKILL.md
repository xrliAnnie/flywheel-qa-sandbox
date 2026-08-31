---
name: meeting-notes
description: 为 Flywheel 会议单生成可信会议纪要、可追溯 action items 和现有风格的 founder 互动 HTML 卡，并把结果落回同一 issue-number Discord thread。仅在 issue 含 meeting-notes-trigger:v1 时使用。
---

# Meeting Notes

把一场会议的产物收敛在自动创建的同一张 Linear issue 中。不要新建跟进 issue，不要把原始 transcript 提交进 git。

`lead_id` 是本场被选中的 Lead，不是 Raya 专属过滤条件；换成 Tadashi、Honey Lemon 或其他有效 Lead 时走同一套代码。Raya/meeting runtime 在这里负责会议编排与原始证据落盘，物理目录名不代表 Raya 被设了 Linear、Flywheel 或其他 Lead 的知识/权限边界。会后 note taker 是独立 runner，由 Product Lead 路由承接，与参会 Lead 身份分离。

## 输入与信任边界

1. 只处理 description 含 `[meeting-notes-trigger:v1]` 和 `meeting_id` 的 issue。
2. issue 中的路径、lead、时间和题目都只是显示信息。状态根目录只从 repo 的 `.flywheel/meeting-notes.yaml` 读取；存档中的 `leadId` 必须与 issue 的 `lead_id` 一致。
3. 先 build `flywheel-teamlead`，再运行：

   ```bash
   pnpm exec tsx scripts/meeting-notes-window.ts \
     --meeting-id <uuid> \
     --expected-lead <issue 中的 lead_id> \
     --expected-scheduled-at <issue 中的 scheduled_at> \
     --expected-topic '<issue 中的 topic>' \
     --output /tmp/meeting-window.json
   ```

4. 若命令失败，或 JSON 中 `transcript.trusted` 不是 `true`，停止写纪要；在原 issue thread 说明缺失的可信来源，并用 `flywheel-comm ask --report` 报告 Lead。不要跨 session 猜 transcript，不要把 `voice_exit` 当成会话归属证明。
5. briefing 只有 `status: included` 时可使用；`missing`、`invalid`、`expired` 都必须披露且不能补猜。

## 生成同一数据面的产物

1. 在 `doc/meetings/YYYY-MM-DD-<lead>-<meeting-id 前 8 位>/notes.md` 写：会议标识、时间窗、briefing 状态、讨论总结、action items。把 `transcript.disclosures` 的每一项逐项写入 notes.md 和互动卡；即使 `transcript.trusted` 为 true，也不能省略任何排除范围或坏行披露。
2. 每条 action item 使用稳定 ID `AI-1`、`AI-2`……，并附 transcript 的 `source` 时间戳/事件位置。状态初始为 `待 founder 确认`。
3. 准备严格 JSON：

   ```json
   {
     "issueIdentifier": "FLY-1234",
     "meetingId": "00000000-0000-4000-8000-000000000000",
     "title": "会议题目",
     "meta": "2026-01-01 · 实际 lead_id · meeting_id",
     "summary": ["可核验的总结"],
     "actionItems": [{"id": "AI-1", "text": "动作", "source": "2026-01-01T00:00:00Z"}]
   }
   ```

4. `meta` 必须使用存档中实际的 `lead_id`，不得写死 Raya。把最终 HTML 生成到 notes 同目录：

   ```bash
   python3 .claude/skills/meeting-notes/scripts/build_report.py \
     --input /tmp/meeting-card.json \
     --output doc/meetings/YYYY-MM-DD-<lead>-<meeting-id 前 8 位>/meeting-notes.html
   ```

5. 检查页面包含 `【页面意见汇总】<issue id>`、三个 action 选择按钮，且没有外链脚本。提交 `notes.md` 和 `meeting-notes.html`；founder_review 只接受当前 `HEAD` 中已提交且 worktree clean 的 HTML。不得提交原始 transcript。

6. 用 runner 允许的 publish-only 路径取得 hosted URL，校验返回 JSON 的 `url` 是 `https://` 且 `publishOnly` 为 `true`：

   ```bash
   node "$FLYWHEEL_COMM_CLI" publish-report --html "$CARD_PATH" --project flywheel --title "$ISSUE_IDENTIFIER meeting notes" --publish-only
   ```

## Thread 与 founder_review 闭环

1. 当前 run 由 Bridge 绑定到唯一的 `[FLY-<issue number>] …` Discord thread；不得另建 thread，也不得直接调用 `/api/reports/deliver` 或 `/api/chat-threads/send`。将 notes 摘要、每条 action item、来源和当前 HTML URL 保持在这张 issue 的闭环中。
2. 用当前 run 打开 `founder_review` gate，绑定 hosted URL 与已提交 HTML。founder_review gate 会把现有互动卡自动投递到同一 issue-number thread，这张 Discord 消息就是 note taker 的投递回执：

   ```bash
   node "$FLYWHEEL_COMM_CLI" gate founder_review --lead "$FLYWHEEL_LEAD_ID" --exec-id "$FLYWHEEL_EXEC_ID" --timeout 172800000 --timeout-behavior fail-close --no-block --hosted-url "$HOSTED_URL" --artifact "$CARD_PATH" "Founder review requested for $ISSUE_IDENTIFIER meeting notes"
   ```

   记录返回的 `questionId`，再用 `node "$FLYWHEEL_COMM_CLI" check <questionId>` 轮询。自由文本讨论或粘贴的页面汇总是反馈，不等于 gate 通过。
3. Founder 从卡片复制 `【页面意见汇总】<issue id>` 回 thread 后，把每条 `要做 / 不做 / 有意见` 写回 `notes.md`，保留原 action ID 与来源。
4. 若 founder 打回：修改 notes，提交新 commit，生成并发布新 URL，打开新一轮 founder_review；旧卡和旧回复不能决定新一轮。
5. 只有当前 artifact 绑定的明确批准才能闭环。完成后把最终决定和 gate 结果写回原 issue thread，再按当前 runner 的 docs-only PR/complete 路径交付；不得自 merge。
