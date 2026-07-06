/**
 * FLY-871 R2/C8 — runner login-expired scan: confirmed login_expired emits a
 * severe runner_login_expired; quota/healthy/coding-error panes don't; auth-
 * adjacent unrecognized anomalies surface (fail-suspicious); only the recent
 * region is classified.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerAuthScan } from "../bridge/runner-auth-scan.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import type { Session } from "../StateStore.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		project_name: "flywheel",
		issue_id: "FLY-999",
		issue_identifier: "FLY-999",
		status: "running",
		...overrides,
	} as Session;
}

describe("makeRunnerAuthScan", () => {
	let dir: string;
	let storePath: string;
	let alert: ReturnType<typeof vi.fn>;

	function scan(extra: { aiClassify?: (t: string) => Promise<never> } = {}) {
		return makeRunnerAuthScan({
			alert,
			resolveLeadId: () => "flywheel-eng-lead",
			storePath, // empty temp file → readStore returns the default store
			...extra,
		});
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly871-authscan-"));
		storePath = join(dir, "accounts.json"); // does not exist → default store
		alert = vi.fn(async () => ({ sent: true }));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("confirmed login_expired → severe runner_login_expired with runner identity", async () => {
		await scan()(
			makeSession(),
			"Invalid API key · Please run /login to continue.",
		);
		expect(alert).toHaveBeenCalledOnce();
		const p = alert.mock.calls[0][0] as AlertPayload;
		expect(p.eventType).toBe("runner_login_expired");
		expect(p.severity).toBe("severe");
		expect(p.sessionKey).toBe("exec-1");
		expect(p.eventId).toBe("runner-login-expired:exec-1:login_expired");
		expect(p.metadata?.authLimit?.evidence).toBe("runner-pane:login_expired");
		expect(p.metadata?.authLimit?.executionId).toBe("exec-1");
	});

	it("healthy pane → no alert", async () => {
		await scan()(
			makeSession(),
			"⏵⏵ bypass permissions · Editing foo.ts · ctx 30%",
		);
		expect(alert).not.toHaveBeenCalled();
	});

	it("a usage cap is the quota scan's job → no runner_login_expired here", async () => {
		await scan()(makeSession(), "You've hit your usage limit, resets in 2h");
		expect(alert).not.toHaveBeenCalled();
	});

	it("auth-adjacent unrecognized anomaly → surfaced as warning (fail-suspicious)", async () => {
		await scan()(
			makeSession(),
			"Auth handshake failed unexpectedly with an unrecognized status",
		);
		expect(alert).toHaveBeenCalledOnce();
		const p = alert.mock.calls[0][0] as AlertPayload;
		expect(p.eventType).toBe("runner_login_expired");
		expect(p.severity).toBe("warning");
		expect(p.metadata?.authLimit?.evidence).toBe("runner-pane:suspicious");
	});

	it("a NON-auth coding error is NOT flagged (no auth vocab)", async () => {
		await scan()(
			makeSession(),
			"Compilation error: unexpected token in src/foo.ts",
		);
		expect(alert).not.toHaveBeenCalled();
	});

	it("unresolvable owning Lead → skip (cannot route)", async () => {
		const s = makeRunnerAuthScan({
			alert,
			resolveLeadId: () => null,
			storePath,
		});
		await s(makeSession(), "Invalid API key · Please run /login");
		expect(alert).not.toHaveBeenCalled();
	});

	it("only the RECENT region is classified (old logout scrolled away → no alert)", async () => {
		const pane = [
			"Invalid API key · Please run /login", // line 1 — scrolled far up
			...Array.from({ length: 24 }, (_, i) => `line ${i} · editing foo.ts`),
		].join("\n");
		await scan()(makeSession(), pane);
		expect(alert).not.toHaveBeenCalled();
	});
});
