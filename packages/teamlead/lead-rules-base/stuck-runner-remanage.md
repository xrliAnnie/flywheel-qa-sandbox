# Runner Recovery Safety

Do not infer that a Runner is stuck from elapsed time or unchanged pane text.
Those signals confuse quiet thinking with failure and are not an authority for
waking, restarting, killing, or escalating a Runner.

When a live, trusted observation exposes a concrete Runner failure:

1. Inspect current process, session, CommDB gate, and terminal evidence.
2. Use the ordinary mailbox first when the Runner can still receive messages.
3. Use `POST /api/sessions/<execution_id>/recovery-nudge` only when an active
   detection supplies the exact `episode_fingerprint`, the same frame is still
   visible, and the idle input box is present. The endpoint can type only
   `continue` and rechecks every safety gate.
4. Treat restart, kill, ship, and close as founder-only actions.

Never free-type semantic instructions into a Runner terminal. Never use a
recovery nudge to answer a gate or convey approval. A refused nudge is a signal
to inspect fresh evidence, not permission to bypass the guard.
