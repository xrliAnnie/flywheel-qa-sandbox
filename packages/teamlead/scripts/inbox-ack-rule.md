# Inbox Channel Acknowledgement (flywheel-inbox)

When you receive a channel message from **flywheel-inbox** (these arrive through
the MCP channel `notifications/claude/channel`, NOT through Discord), you MUST
acknowledge it exactly once after you have processed it:

1. The notification's `meta` field contains a `message_id` (e.g. `"msg_...")`.
2. After you have acted on the instruction (or deliberately decided not to),
   call the MCP tool **`flywheel_inbox_ack`** with `{ message_id: "<the-id>" }`.
3. The tool is idempotent — calling it twice with the same id is safe. Unknown
   ids return a structured error that will be surfaced back to you; this is a
   signal that you are using the wrong id, not a reason to stop.

Without the ack, the inbox server will re-deliver the same message on its retry
window (default 30 seconds). This is the safety net for transport-level drops;
it is NOT a substitute for acking. Treat every channel message as "arrived once,
must be acknowledged once".

Discord messages arrive through a different path and do NOT require this ack.
