# Discord Reply — Output Contract (FLY-387)

When you reply to anyone on Discord, you MUST actually **execute** the
`mcp__plugin_discord_discord__reply` tool — a real tool call. **Never** write
its `<invoke name="...reply">...</invoke>` XML (or any tool-call XML) as plain
prose in your answer. Tool-call XML emitted as text is NOT sent: the user sees
nothing, while you may believe you replied ("No response requested"). This has
repeatedly left the founder waiting in silence.

- Want to reply? Call the `reply` tool. One real tool call. Pass `chat_id` back.
- Don't intend to reply (background work, deliberate silence)? That's fine — just
  end your turn normally. Do **not** emit reply tool-call XML as text.
- Need to *quote* this malformed XML when explaining the bug? Put it inside a
  Markdown fenced code block (```), so it reads as an example, not an attempted send.

A Stop-hook guard (`discord-reply-enforcer.py`) will catch a leaked, unexecuted
reply and nudge you to resend — but the contract above is the first line of
defense: execute the tool, don't narrate it.

## Durable inbound chat receipts (FLY-1426)

Flywheel-managed Discord notifications can include a `receipt_id`. The stable
formula is `chat:<lead_id>:<message_id>`. A receipt means the message is durable,
but it remains open until you genuinely handle it. Close every such receipt by
exactly one of these paths:

1. For a normal Discord reply, explicitly pass `reply_to=<message_id>` to the
   reply tool. Only a successfully sent Discord message whose payload contains
   that reference auto-settles the receipt. Roundtable routing strips reply
   references, so use the explicit ack command there.
2. When no Discord reply is needed, finish the requested work and then run:

   `node "$FLYWHEEL_COMM_CLI" handle-receipt --lead "$FLYWHEEL_LEAD_ID" --receipt <receipt_id> --request-id <unique_id> --action ack`

   A founder task is handled only after its actual side effect succeeds (for
   example, the report was updated or the Runner was dispatched). Then ack it.
   Do not ack merely because you read or remembered the request.
3. The `relay` and `respond` actions are only for answering an existing, still
   pending Runner question with its `--to-question` id and content. Never use
   them to make a new founder task look handled.

If handling fails or must continue later, leave the receipt pending. Reminder
deliveries are the same durable item, not new work; their resend count tells you
how many times the still-open receipt has been surfaced.
