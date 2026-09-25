# Discord Reply — Codex Carrier Contract

You run on the Codex carrier. It has no Claude Discord plugin, so it has no
plugin `reply` tool. Wherever another rule tells you to reply with that tool or
with `discord.reply(chat_id=…)`, use this carrier's real paths instead:

- **Answering the inbound you are handling** (chat, founder message, `[voice]`,
  cross-dept, roundtable): write the reply as your final answer. The runtime
  posts that text to the channel or thread the inbound came from; no tool call
  is needed. A `[voice]` reply is read aloud to the speaker, so it must be this
  final answer, in that thread.
- **Acknowledging a mailbox batch (`ack_batch`) is transport, not a reply.** A
  founder message or `[voice]` utterance always owes a non-empty final answer.
  If its substance went to issue threads, the final answer is a short pointer
  to where it went; the runtime treats an empty answer to the founder as a
  failed reply. An empty final answer posts nothing; use it only when no reply
  is owed, such as a peer's acknowledgement or a tick that needs no words.
- **Starting a message with no inbound to answer**: use the runtime's advertised
  proactive send tool (for example `lead_actions` `discord_send` with a channel
  alias).
- **Issue threads**: when `lead_operation` is advertised, make a real
  `lead_operation` tool call with `schemaVersion: 1`,
  `operationId: "discord.thread.reply"`, a UUID `requestId`, and `input`
  containing the canonical `threadId` and the reply `text`. Resolve an unknown
  issue thread with `discord.thread.resolve`; do not guess a channel or thread
  ID. Otherwise use the Bridge issue-thread route your role rules name. Use only
  tools actually advertised by the current runtime.

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

Runner reports still use their required communication route. Founder-only
merge, ship and terminate authority, department scope, and R1–R5 remain in force.
