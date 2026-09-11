# FLY-1942 通信层防线三件套 — C7 客户端实施证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

Implemented only fork `external_plugins/discord/reply-guard-client.ts` and its dedicated test file. Parent owns server integration and version change.

## Contract

`createReplyGuardClient({fetchImpl, now, sleep, env, audit}).evaluate(chatId, text, {roundtableThread})` returns the pinned kind/probe/local/deny structure. `formatGuardDeny(outcome)` renders an actual denial with its probe and omits empty Issues text. Server must decide denial by presence of `outcome.deny`; unavailable and unauthorized outcomes can carry local allow decisions.

- Missing Bridge binding retains disabled fail-open behavior. Healthy Bridge decisions remain authoritative, including core/roundtable destinations. HTTP404 returns not_deployed and never audits.
- Existing parseIntInRange(raw,4000,500,10000) supplies timeout configuration; malformed or out-of-range values fall back, matching the unchanged helper.
- Abort/network failures retry once with250ms injected sleep. HTTP statuses do not retry.401/403 classify unauthorized; other failed HTTP responses classify unavailable.
- Local decision preserves the old issue-token regex and configured prefix semantics. Core/known roundtable thread exemptions precede own-channel classification. Own-channel issue text denies; other channels allow and audit; missing/empty OWN retains legacy broad issue denial.
- Audit uses1MB bounded JSONL with a single `.1` rotation, best-effort writes and restrictive initial modes. Request body and credentials are not included. Thrown diagnostic error text and probe URL redact the configured API token.

## TDD and verification

Initial test module failed expected module-not-found before implementation. After implementation,12 policy tests passed. A separate secret-diagnostic regression failed because raw fetch error text included the synthetic API token; adding redaction made it green.

Final dedicated command, from isolated fork:

`bun test ./external_plugins/discord/reply-guard-client.test.ts`

Result:16 passed,0 failed,69 assertions. Covers all nine research acceptance cases plus prefix boundaries, strict timeout parsing, no HTTP retry, actual timer-driven abort and retry (~1005ms for two500ms deadlines), bounded audit rotation, audit write exception, disabled bindings and exact POST binding/auth payload. Code and tests subsequently formatted without behavior changes. Parent separately owns full fork suite, server bundle and rollback checks.

No live Bridge/Discord replay, deployment, service restart, commit or push occurred in this worker. Unit probe timings are injected except the explicitly timer-driven timeout test and are not production measurements.
