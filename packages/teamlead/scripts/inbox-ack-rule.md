# Inbox Channel Acknowledgement (flywheel-inbox)

Reply routing follows the resident role rule's **Reply Discipline (FLY-162)**;
transport ACK is separate from a reply or business completion.

For each **`[mailbox-batch <batch_id> | ...]`**, process every independent message,
then call **`flywheel_inbox_ack_batch`** exactly once with that header's batch_id.
In one model response, issue all ACKs for batches already processed; no extra
thinking or “received” turn per ACK. Never ACK early or have transport ACK on
the Lead's behalf. Do not delay urgent founder messages to collect batches.

A queued result means protocol admission, not gate approval, business completion
or ship authority. Reliable lease redelivery remains; use the current header id,
which may differ after expiry. Unknown ids require checking the header, not guessing.
Messages inside a mailbox batch require its ACK regardless of their original
source. A direct Discord plugin message without a mailbox-batch header does not.
