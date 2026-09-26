# Inbox Channel Acknowledgement (flywheel-inbox)

Reply routing still follows **Reply Discipline (FLY-162)**; transport ACK is
neither a reply nor business completion.

For each **`[mailbox-batch <batch_id> | ...]`**, decide every message's handling.
In the **same assistant response as the first handling action**, issue one batch
ACK for its header id, using parallel tool calls. For status-only input, pair the
ACK with the turn's final tool action when one exists. If the ACK is the only
action the input needs (status-only, already handled, or redelivered), send it
alone immediately; never skip or defer it to piggyback. Never ACK before handling
begins or use an ACK-only turn when another action is needed, and never let
transport ACK for the Lead. Do not delay urgent founder input to collect batches.

`queued` means admission, not completion, approval, or ship authority. Redelivery
remains; after expiry use the new header. Never guess an unknown id. Every batched
message needs the batch ACK; headerless direct Discord messages do not.
