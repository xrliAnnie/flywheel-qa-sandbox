import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOperationalDagPorts,
	DEFAULT_SHIP_TIMEOUT_MS,
} from "../dag-ports.js";

const HEAD = "a".repeat(40);

/**
 * FLY-1545 ①: the readCiState matrix runs against a REAL fake-gh subprocess,
 * not a return-value mock -- `gh pr checks` reports "checks pending" through
 * exit code 8 (even with valid --json output), and only a real child process
 * exercises that path (the v1 ship-ci-guard bug a pure mock cannot catch).
 */
interface FakeGhSpec {
	view?: { stdout?: string; stderr?: string; status?: number };
	checks?: { stdout?: string; stderr?: string; status?: number };
}

function makeRig(
	options: { hang?: boolean; observationTimeoutMs?: number } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-fake-gh-"));
	const controlPath = join(dir, "control.json");
	const ghPath = join(dir, "gh");
	writeFileSync(
		ghPath,
		options.hang
			? `#!/usr/bin/env node
setTimeout(() => process.exit(0), 60_000);
`
			: `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const control = JSON.parse(readFileSync(process.env.FAKE_GH_CONTROL, "utf8"));
const spec = control[process.argv[3]] ?? { stdout: "", stderr: "no spec", status: 1 };
process.stdout.write(spec.stdout ?? "");
process.stderr.write(spec.stderr ?? "");
process.exit(spec.status ?? 0);
`,
	);
	chmodSync(ghPath, 0o755);
	const ports = createOperationalDagPorts({
		ghBin: ghPath,
		hostEpoch: "test-epoch",
		lockRoot: join(dir, "locks"),
		...(options.observationTimeoutMs
			? { observationTimeoutMs: options.observationTimeoutMs }
			: {}),
	});
	return {
		dir,
		ports,
		async readCiState(spec: FakeGhSpec) {
			writeFileSync(controlPath, JSON.stringify(spec));
			process.env.FAKE_GH_CONTROL = controlPath;
			if (!ports.githubObservation) throw new Error("ports incomplete");
			return await ports.githubObservation.readCiState({
				repo: "owner/repo",
				pr: 31,
				head: HEAD,
			});
		},
		cleanup() {
			delete process.env.FAKE_GH_CONTROL;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function viewJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		headRefOid: HEAD,
		mergeStateStatus: "CLEAN",
		...overrides,
	});
}

function checksJson(buckets: string[]): string {
	return JSON.stringify(
		buckets.map((bucket, index) => ({
			bucket,
			name: `check-${index}`,
			state: "COMPLETED",
		})),
	);
}

describe("FLY-1545 ① readCiState fail-closed matrix (real fake-gh subprocess)", () => {
	const rigs: ReturnType<typeof makeRig>[] = [];
	afterEach(() => {
		for (const rig of rigs.splice(0)) rig.cleanup();
	});

	function rig(options?: Parameters<typeof makeRig>[0]) {
		const created = makeRig(options);
		rigs.push(created);
		return created;
	}

	it("pins the merge-poll default to the ship workflow budget", () => {
		// 35min = ship-on-comment.yml timeout-minutes:30 + 5min propagation.
		expect(DEFAULT_SHIP_TIMEOUT_MS).toBe(2_100_000);
	});

	it("all pass is green", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: checksJson(["pass", "pass"]) },
			}),
		).toEqual({ state: "green" });
	});

	it("pass plus skipping is green", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: checksJson(["pass", "skipping"]) },
			}),
		).toEqual({ state: "green" });
	});

	it("any fail is red with the failing name", async () => {
		const result = await rig().readCiState({
			view: { stdout: viewJson() },
			checks: { stdout: checksJson(["pass", "fail"]) },
		});
		expect(result).toMatchObject({ state: "red" });
		expect((result as { detail: string }).detail).toContain("check-1");
	});

	it("any cancel is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: checksJson(["cancel", "pass"]) },
			}),
		).toMatchObject({ state: "red" });
	});

	it("exit 8 with valid JSON and a pending bucket is pending", async () => {
		const result = await rig().readCiState({
			view: { stdout: viewJson() },
			checks: { stdout: checksJson(["pass", "pending"]), status: 8 },
		});
		expect(result).toMatchObject({ state: "pending" });
		expect((result as { detail: string }).detail).toContain("check-1");
	});

	it("exit 8 with invalid JSON is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: "not json", status: 8 },
			}),
		).toMatchObject({ state: "red" });
	});

	it("exit 8 without a pending bucket is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: checksJson(["pass", "pass"]), status: 8 },
			}),
		).toMatchObject({
			state: "red",
			detail: "gh pr checks exited 8 without a pending bucket",
		});
	});

	it("an empty check list is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: "[]" },
			}),
		).toMatchObject({ state: "red", detail: "PR reports an empty check list" });
	});

	it("an out-of-domain bucket is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson() },
				checks: { stdout: checksJson(["pass", "mystery"]) },
			}),
		).toMatchObject({ state: "red" });
	});

	it("undecided mergeStateStatus values are red", async () => {
		for (const status of ["", "UNKNOWN", "UNSTABLE", "DIRTY"]) {
			expect(
				await rig().readCiState({
					view: { stdout: viewJson({ mergeStateStatus: status }) },
					checks: { stdout: checksJson(["pass"]) },
				}),
			).toMatchObject({ state: "red" });
		}
	});

	it("a drifted head is red even when checks are green", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson({ headRefOid: "b".repeat(40) }) },
				checks: { stdout: checksJson(["pass"]) },
			}),
		).toMatchObject({ state: "red" });
	});

	it("a non-zero non-8 checks exit (auth/network) is red with detail", async () => {
		const result = await rig().readCiState({
			view: { stdout: viewJson() },
			checks: { stdout: "", stderr: "HTTP 401 bad credentials", status: 1 },
		});
		expect(result).toMatchObject({ state: "red" });
		expect((result as { detail: string }).detail).toContain("bad credentials");
	});

	it("an unparseable view payload is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: "garbage" },
				checks: { stdout: checksJson(["pass"]) },
			}),
		).toMatchObject({ state: "red" });
	});

	it("a failing view subprocess is red", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: "", stderr: "could not resolve PR", status: 1 },
				checks: { stdout: checksJson(["pass"]) },
			}),
		).toMatchObject({ state: "red" });
	});

	it("an out-of-domain mergeStateStatus is red (codex R1 LOW-3)", async () => {
		expect(
			await rig().readCiState({
				view: { stdout: viewJson({ mergeStateStatus: "BOGUS" }) },
				checks: { stdout: checksJson(["pass"]) },
			}),
		).toMatchObject({
			state: "red",
			detail: "mergeStateStatus is undecided: BOGUS",
		});
	});

	it("a hung gh subprocess is bounded and red (codex R1 MEDIUM-2)", async () => {
		const result = await rig({
			hang: true,
			observationTimeoutMs: 500,
		}).readCiState({
			view: { stdout: viewJson() },
			checks: { stdout: checksJson(["pass"]) },
		});
		expect(result).toMatchObject({ state: "red" });
		expect((result as { detail: string }).detail).toContain("timed out");
	});

	it("a hung gh head probe is bounded and throws (codex R2)", async () => {
		const created = rig({ hang: true, observationTimeoutMs: 500 });
		if (!created.ports.githubObservation) throw new Error("ports incomplete");
		const started = Date.now();
		await expect(
			created.ports.githubObservation.readPrHead({
				repo: "owner/repo",
				pr: 31,
			}),
		).rejects.toThrow("timed out");
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
