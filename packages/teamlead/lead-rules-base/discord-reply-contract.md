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
