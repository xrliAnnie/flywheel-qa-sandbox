# FLY-2550 C0 — turns/list latency
Issue: FLY-2550
日期: 2026-09-15
基于: ../plan.md C0 / E0

## Result: PASS

Mufasa standalone `codex-cli 0.154.0`, legacy thread
`019eaf5d-a5b7-7a72-b73f-cd1063892aa1`, rollout **7,096,220 bytes**.

| Consecutive request | wallMs | returned status | count |
|---|---:|---|---:|
| 1 | 590.55 | completed | 1 |
| 2 | 865.26 | completed | 1 |

Both successful responses are below 10,000 ms. Observed status vocabulary:
`completed` (other terminal/busy values require unit coverage).

## Isolation and protocol

- SQLite online backup from a read-only `state_5.sqlite` connection into a
  fresh temporary home; copied only the target rollout, rewrote database
  rollout paths to the isolated home. No production database writes.
- Auth was symlinked to the source home's credential file without reading or
  copying its contents. No production config, sockets, or daemon state copied.
- Started the production standalone binary with `CODEX_HOME` pointing to the
  copy, over stdio `app-server`; initialized with `experimentalApi: true`.
- Issued exactly two `thread/turns/list` requests with
  `{threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded"}`.
  Responses had `data`, `nextCursor`, `backwardsCursor`; no RPC errors.
- No thread resume/start, model turn, TUI, or service restart. The isolated
  child process was terminated and waited for; database handles closed.
- Raw result: temporary directory `fly2550-c0-dsd2qmen/result.json`.

## Scheduling receipt

Question `98fab9f8-af97-4f9b-b1e2-a4e8ad20d6d8`: Lead explicitly authorized
C0–C8 under approved v4; the old scheduling hold is stale. No host full package
suites; exact-head CI is authoritative. Freeze HEAD while review is running.
