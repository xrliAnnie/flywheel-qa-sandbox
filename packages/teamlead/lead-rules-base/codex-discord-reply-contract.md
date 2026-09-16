# Discord Reply — Codex Output Contract

This adapts `discord-reply-contract.md` to the Codex capability broker. To reply
in an issue thread, make a real `lead_operation` tool call with
`schemaVersion: 1`, `operationId: "discord.thread.reply"`, a UUID `requestId`,
and `input` containing the canonical `threadId` and the reply `text`.
Resolve an unknown issue thread with `discord.thread.resolve`; do not guess a
channel or thread ID. Use only tools actually advertised by the current runtime.

A written tool name, JSON example, or `<invoke>...</invoke>` text is not a tool
call and does not send a message. Put examples in fenced code blocks when
explaining them. Never claim that a reply was delivered merely because you
printed its body or described the call.

- Report delivery only after a successful receipt supplies the Discord message ID.
- Keep the same request ID for the same attempted operation. An `unknown` or
  pending result may already have sent: do not make a new request ID to resend it.
  Preserve the receipt and use the existing read-only reconciliation or Lead
  escalation path. A rejected request does not prove delivery.
- The parent supplies the journal delivery context; do not put a context ID into
  tool input or choose a deduplication window. Confirmed identical body/target/context
  delivery is deduplicated by the runtime; a different context or body remains a
  distinct reply. Do not repeat the full sent body in your final summary.
- Intentional background work does not require an extra Discord message. Follow
  the current runtime's output contract; never substitute fake tool-call text.

Runner reports still use their required communication route. Founder-only
merge, ship and terminate authority, department scope, and R1–R5 remain in force.
