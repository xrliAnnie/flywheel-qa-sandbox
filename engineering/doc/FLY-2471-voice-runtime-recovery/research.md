# FLY-2471 语音运行恢复 — 调研
Issue: FLY-2471 (https://linear.app/geoforge3d/issue/FLY-2471)
日期: 2026-09-10
基于: exploration.md

Runtime owns the tick lock, recovery scan and leased-session poll loop. Services supplies provisioning and Discord status effects. The resumable provisioner owns durable state transitions and epoch fencing. No schema change is necessary.

Provisioning needs both a runtime deadline race (releases the lock even if an injected dependency ignores abort) and cooperative cancellation in the real effect path. Services can wrap its per-attempt fetch implementation with the supplied signal, combining any existing helper timeout signal. This confines changes to voice wiring rather than changing shared Discord helpers. The reducer must check cancellation before claim, before each step and after awaited effects, including catch paths, to avoid turning an aborted attempt into a terminal failure or committing a late result. Existing epoch/nonce/retry policies remain authoritative for recovery.

Poll status rate control belongs before reportPollFailure, keyed by session and failure reason. Keep one current failure record per session, send first occurrence immediately, then wait 30s, 60s, 120s, 240s, and cap at 300s. Successful polling clears that session's record; a changed reason starts a fresh sequence. Remove records for sessions no longer actively leased. Reserve the next deadline before invoking the reporter so a rejected send also backs off. Rate control is process-local and resets on restart; no durable notification guarantee is implied.

Existing tests use temporary StateStores and injected effects, allowing executable recovery/replay/negative tests without contacting Discord or copying production databases. Runtime fixtures cover basic recovery, active lease selection and single poll failure; provisioner fixtures already cover restart, cancellation and epoch ownership.
