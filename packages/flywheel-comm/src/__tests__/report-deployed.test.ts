/**
 * FLY-727: `report-deployed` CLI — validation, HTTP post, spool + drain.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportDeployed } from "../commands/report-deployed.js";

let home: string;
const env = () => ({
	FLYWHEEL_BRIDGE_URL: "http://bridge",
	TEAMLEAD_API_TOKEN: "t",
});
const spoolDir = () => join(home, ".flywheel", "deployment-events-pending.d");

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fly727-cli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function okFetch() {
	return vi.fn(async () => ({ ok: true }) as Response);
}
function failFetch() {
	return vi.fn(async () => ({ ok: false, status: 503 }) as Response);
}

describe("report-deployed validation", () => {
	it("2 without --project", async () => {
		const code = await reportDeployed(["--source", "self-ship"], {
			env: { ...env(), HOME: home },
			fetchImpl: okFetch(),
		});
		expect(code).toBe(2);
	});
	it("2 without --issue/--pr", async () => {
		const code = await reportDeployed(
			["--project", "flywheel", "--merge-sha", "a".repeat(40)],
			{ env: { ...env(), HOME: home }, fetchImpl: okFetch() },
		);
		expect(code).toBe(2);
	});
	it("2 without an identity field", async () => {
		const code = await reportDeployed(
			["--project", "flywheel", "--issue", "FLY-1"],
			{ env: { ...env(), HOME: home }, fetchImpl: okFetch() },
		);
		expect(code).toBe(2);
	});
});

// FLY-727 (QA FLY-739): the self-ship updater / restart-services contexts export no
// bridge URL. Rather than exit 2 (no POST, no spool → wedged marker), the CLI defaults
// to the local Bridge so the event still POSTs (or spools). An explicit env URL wins.
describe("report-deployed default bridge url (QA FLY-739 prod path)", () => {
	const reportArgs = [
		"--project",
		"flywheel",
		"--issue",
		"FLY-1",
		"--merge-sha",
		"a".repeat(40),
	];

	it("defaults to http://localhost:9876 when no bridge url env → POSTs, returns 0", async () => {
		const f = okFetch();
		const code = await reportDeployed(reportArgs, {
			env: { HOME: home },
			fetchImpl: f,
		});
		expect(code).toBe(0);
		const [url] = f.mock.calls.at(-1)!;
		expect(url).toBe("http://localhost:9876/api/deployments/report");
	});

	it("spools (returns 1, never exit 2) when no bridge url AND the local Bridge is down", async () => {
		const code = await reportDeployed(reportArgs, {
			env: { HOME: home },
			fetchImpl: failFetch(),
			nowMs: 456,
		});
		expect(code).toBe(1); // durable spool — a satisfied self-ship marker can still ack
		expect(
			readdirSync(spoolDir()).filter((x) => x.endsWith(".json")),
		).toHaveLength(1);
	});

	it("an explicit FLYWHEEL_BRIDGE_URL wins over the local default", async () => {
		const f = okFetch();
		const code = await reportDeployed(reportArgs, {
			env: { FLYWHEEL_BRIDGE_URL: "http://bridge", HOME: home },
			fetchImpl: f,
		});
		expect(code).toBe(0);
		const [url] = f.mock.calls.at(-1)!;
		expect(url).toBe("http://bridge/api/deployments/report");
	});

	it("treats an empty/whitespace bridge url as unset (falls back to the local default)", async () => {
		const f = okFetch();
		const code = await reportDeployed(reportArgs, {
			env: { FLYWHEEL_BRIDGE_URL: "   ", HOME: home },
			fetchImpl: f,
		});
		expect(code).toBe(0);
		const [url] = f.mock.calls.at(-1)!;
		expect(url).toBe("http://localhost:9876/api/deployments/report");
	});
});

describe("report-deployed post + spool/drain", () => {
	it("posts to the Bridge with Bearer + returns 0", async () => {
		const f = okFetch();
		const code = await reportDeployed(
			[
				"--project",
				"flywheel",
				"--issue",
				"FLY-1",
				"--merge-sha",
				"b".repeat(40),
				"--source",
				"self-ship",
			],
			{ env: { ...env(), HOME: home }, fetchImpl: f },
		);
		expect(code).toBe(0);
		const [url, init] = f.mock.calls.at(-1)!;
		expect(url).toBe("http://bridge/api/deployments/report");
		expect((init as RequestInit).method).toBe("POST");
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer t",
		});
		expect(existsSync(spoolDir())).toBe(false); // nothing spooled on success
	});

	it("spools on Bridge failure (never silently lost) + returns 1", async () => {
		const code = await reportDeployed(
			[
				"--project",
				"flywheel",
				"--issue",
				"FLY-1",
				"--merge-sha",
				"c".repeat(40),
			],
			{ env: { ...env(), HOME: home }, fetchImpl: failFetch(), nowMs: 123 },
		);
		expect(code).toBe(1);
		const files = readdirSync(spoolDir()).filter((f) => f.endsWith(".json"));
		expect(files).toHaveLength(1);
	});

	it("drains spooled events on the next successful invocation", async () => {
		// seed a spooled event
		mkdirSync(spoolDir(), { recursive: true });
		writeFileSync(
			join(spoolDir(), "dep-1.json"),
			JSON.stringify({
				projectName: "flywheel",
				issueIdentifier: "FLY-9",
				mergeSha: "d".repeat(40),
				source: "self-ship",
			}),
		);
		const f = okFetch();
		const code = await reportDeployed(
			[
				"--project",
				"flywheel",
				"--issue",
				"FLY-1",
				"--merge-sha",
				"e".repeat(40),
			],
			{ env: { ...env(), HOME: home }, fetchImpl: f },
		);
		expect(code).toBe(0);
		// both the drained + the new event were posted
		expect(f.mock.calls.length).toBe(2);
		expect(
			readdirSync(spoolDir()).filter((x) => x.endsWith(".json")),
		).toHaveLength(0);
	});

	it("--drain-only drains without requiring report args", async () => {
		mkdirSync(spoolDir(), { recursive: true });
		writeFileSync(
			join(spoolDir(), "dep-2.json"),
			JSON.stringify({
				projectName: "x",
				prNumber: 1,
				sourceEventId: "z",
				source: "manual",
			}),
		);
		const f = okFetch();
		const code = await reportDeployed(["--drain-only"], {
			env: { ...env(), HOME: home },
			fetchImpl: f,
		});
		expect(code).toBe(0);
		expect(f.mock.calls.length).toBe(1);
	});
});
