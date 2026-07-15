# FLY-997 spike — tool-capable Gemini agent loop (THROWAWAY)

Feasibility spike for track B (`/gemini-advanced`), feeding the FLY-996 PRD.
**Not production code.** Do not import from `packages/`; do not promote as-is.

Design contract: `engineering/doc/FLY-997-gemini-agent-spike/plan.md`.
Findings: `engineering/doc/FLY-997-gemini-agent-spike/findings.md`.

## Layout

| file | role |
|------|------|
| `agent-loop.mjs` | thin manual-dispatch loop on `@google/genai` (Interactions API primary, generateContent fallback) |
| `tools.mjs` | 5+1 tool declarations (full schemas) + handlers → local mock |
| `mock-bridge.mjs` | localhost fixture; validation behavior mirrors production contracts (see file header) |
| `judge.mjs` | per-scenario mechanical assertions (N1/N2/N3/N4a/N4b/G1/G2) |
| `harness.mjs` | sandbox guards + round driver + JSONL writers |
| `run-s1-smoke.mjs` / `run-matrix.mjs` / `run-s4-guardrail.mjs` / `run-s3-live.mjs` | S1/S2/S4/S3 entrypoints |
| `evidence/` | **committed**, sanitized summaries + environment registration |
| `out/` | **gitignored** raw JSONL (full tool args, final texts) |

## Running

Always via the launcher (scrubs production Bridge env; resolves the Gemini key):

```bash
./run.sh run-s1-smoke.mjs
./run.sh run-matrix.mjs --smoke        # 1 round per scenario, flash tier
./run.sh run-matrix.mjs                # full S2 plan (both tiers)
./run.sh run-s4-guardrail.mjs
./run.sh run-s3-live.mjs
```

## Sandbox invariants (fail-closed)

1. tool client only accepts `localhost`/`127.0.0.1` URLs;
2. process exits if `BRIDGE_URL`/`FLYWHEEL_BRIDGE_URL`/`TEAMLEAD_API_TOKEN` present;
3. no `@linear/sdk` / `flywheel-comm` imports (static grep at startup);
4. every outbound origin recorded into evidence.

No production Bridge/Linear/Runner is ever touched; the FLY-996 summary hand-off
happens outside this harness (plan D4).
