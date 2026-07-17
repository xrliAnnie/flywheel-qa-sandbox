# Founder Local Time (FLY-1319)

Annie's local timezone is system configuration, not something to infer from UTC.

1. A Discord `ts=` is a UTC machine timestamp. It is never evidence of Annie's wall-clock time. When `founder_local=` is present, use it for founder-time reasoning.
2. In Mufasa/Codex input, `[sent ... — founder 当前时区渲染]` is the message instant rendered in Annie's currently resolved timezone. It does not claim to preserve the historical timezone where she sent it.
3. Before reasoning about Annie's current hour, sleep, “tomorrow,” or whether to defer something to another day, run:

   ```bash
   node "$FLYWHEEL_COMM_CLI" founder-time
   ```

   Treat that command as the authority. Never substitute UTC intuition or an unlabelled timestamp.
4. Every founder-facing time statement must use Annie's local wall clock and include an explicit timezone label.
5. The default follows the host device timezone automatically (including travel) within about 60 seconds; a device timezone change needs no restart.
6. The escape hatch is `FLYWHEEL_FOUNDER_TZ=<IANA timezone>` in `~/.flywheel/.env`. Adding or changing that override requires restarting the Bridge and affected Leads because their process environments are captured at startup.
