import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LocalQaRoomRuntime,
	minimalRoomEnvironment,
	parseRoomOutput,
} from "../qa-room-runtime.js";
import type { QaRoom, QaRoomOperation } from "../qa-room-store.js";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "fly2405-runtime-"));
	roots.push(root);
	return root;
};
const room = (root: string): QaRoom => ({
	room_id: "room",
	slot: 1,
	head: "a".repeat(40),
	claim_token: "private-token",
	status: "preparing",
	status_reason: null,
	owner_actor_key: "runner:x",
	owner_issue: "FLY-2405",
	physically_claimed: 1,
	release_state: "held",
	src_dir: join(root, "src"),
	deploy_json: null,
	evidence_dir: null,
	request_json: JSON.stringify({
		generalized: true,
		extra_leads: [{ slot: 2, label: "ops" }],
	}),
	created_at: "now",
	updated_at: "now",
});
const op = (root: string): QaRoomOperation => ({
	operation_id: "op",
	room_id: "room",
	kind: "deploy",
	actor_key: "runner:x",
	request_id: "q",
	request_digest: "digest",
	attempt: 1,
	status: "running",
	operation_dir: join(root, "ops/op"),
	pid: 1234,
	residue_check: null,
	request_json: "{}",
	queued_at: "now",
	created_at: "now",
	started_at: "now",
	finished_at: null,
});
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("QA room host boundary", () => {
	it("strips production and ambient credentials while admitting only declared test controls", () => {
		const env = minimalRoomEnvironment(
			{
				HOME: "/fixture",
				USER: "user",
				PATH: "/opt/node/bin:/usr/bin",
				TEAMLEAD_API_TOKEN: "secret",
				FLYWHEEL_INGEST_TOKEN: "secret",
				CODEX_HOME: "/production",
				TMPDIR: "/sandbox",
				LANG: "C",
			},
			["/opt/node/bin", "/usr/bin"],
			room("/fixture"),
			{ TEST_REPLY_BY_ISSUE: "1", TEAMLEAD_API_TOKEN: "attack" },
		);
		expect(env).toMatchObject({
			HOME: "/fixture",
			TMPDIR: "/tmp/",
			LANG: "en_US.UTF-8",
			TEST_REPLY_BY_ISSUE: "1",
			FLYWHEEL_QA_ROOM_CLAIM: "private-token",
		});
		for (const key of [
			"TEAMLEAD_API_TOKEN",
			"FLYWHEEL_INGEST_TOKEN",
			"CODEX_HOME",
		])
			expect(env).not.toHaveProperty(key);
	});
	it("adopts token-owned partial claims after restart and refuses foreign locks", () => {
		const root = fixture();
		const runtime = new LocalQaRoomRuntime({ repoRoot: root, lockRoot: root });
		const r = room(root);
		// The full set is written before deploy; a crash may leave only a prefix
		// of its physical directories, never a different requested set.
		expect(runtime.claim(r, [1, 2])).toBe(true);
		rmSync(join(root, "flywheel-test-slot-2.lock"), { recursive: true });
		expect(runtime.claim(r, [1, 2])).toBe(true);
		const claim = JSON.parse(
			readFileSync(
				join(root, "flywheel-test-slot-2.lock/service-claim"),
				"utf8",
			),
		);
		expect(claim).toMatchObject({
			room_id: "room",
			claim_token: "private-token",
			slots: [1, 2],
		});
		writeFileSync(
			join(root, "flywheel-test-slot-2.lock/service-claim"),
			JSON.stringify({ ...claim, claim_token: "foreign" }),
		);
		expect(runtime.claim(r, [1, 2])).toBe(false);
		expect(existsSync(join(root, "flywheel-test-slot-1.lock"))).toBe(false);
		expect(existsSync(join(root, "flywheel-test-slot-2.lock"))).toBe(true);
	});
	it("never removes a foreign release claim, and missing released locks are idempotent", () => {
		const root = fixture();
		const runtime = new LocalQaRoomRuntime({ repoRoot: root, lockRoot: root });
		const r = room(root);
		runtime.claim(r, [1, 2]);
		writeFileSync(
			join(root, "flywheel-test-slot-2.lock/service-claim"),
			JSON.stringify({ room_id: "other", claim_token: "foreign", slots: [2] }),
		);
		expect(runtime.release(r, [1, 2])).toEqual([2]);
		expect(runtime.release(r, [1, 2])).toEqual([2]);
		expect(existsSync(join(root, "flywheel-test-slot-1.lock"))).toBe(false);
		expect(existsSync(join(root, "flywheel-test-slot-2.lock"))).toBe(true);
	});
	it("parses noisy JSON but rejects wrong or missing room coordinates", () => {
		const value = {
			slot: 1,
			port: 1981,
			bridgeUrl: "http://127.0.0.1:1981",
			slotDir: "/tmp/flywheel-test-slot-1",
			projectName: "test-slot-1",
			apiTokenPath: "/tmp/token-path",
		};
		expect(
			parseRoomOutput(`build noise\n${JSON.stringify(value, null, 2)}\n`, 1),
		).toEqual(value);
		for (const invalid of [
			{ ...value, slot: 2 },
			{ ...value, bridgeUrl: "https://outside/" },
			{ ...value, slotDir: "/production" },
			{},
		])
			expect(() => parseRoomOutput(JSON.stringify(invalid), 1)).toThrow(
				"invalid_room_json",
			);
	});
	it("verifies health against source and built artifact sha", async () => {
		const root = fixture();
		const r = room(root);
		const o = op(root);
		mkdirSync(o.operation_dir, { recursive: true });
		writeFileSync(
			join(o.operation_dir, "stdout"),
			JSON.stringify({
				slot: 1,
				port: 1981,
				bridgeUrl: "http://127.0.0.1:1981",
				slotDir: "/tmp/flywheel-test-slot-1",
				projectName: "test-slot-1",
			}),
		);
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						buildSha: r.head,
						buildMode: "built",
						artifactBuildSha: "wrong",
					}),
				),
		);
		const runtime = new LocalQaRoomRuntime({ repoRoot: root, fetch: fetcher });
		await expect(runtime.verifyDeploy(r, o)).rejects.toThrow(
			"build_sha_mismatch",
		);
		fetcher.mockResolvedValue(
			new Response(
				JSON.stringify({
					buildSha: r.head,
					buildMode: "built",
					artifactBuildSha: r.head,
				}),
			),
		);
		await expect(runtime.verifyDeploy(r, o)).resolves.toHaveProperty("slot", 1);
	});
	it("uses outside process and launchd observations and holds all claims until inspected", async () => {
		const root = fixture();
		const r = room(root);
		const exec = vi.fn(async (command: string) =>
			command === "launchctl"
				? "123 0 com.flywheel.qa.lead.slot-2.ops\n"
				: "44 node /tmp/flywheel-test-slot-1/bridge.js\n45 node /tmp/flywheel-test-slot-10/other.js\n",
		);
		const runtime = new LocalQaRoomRuntime({
			repoRoot: root,
			lockRoot: root,
			exec,
		});
		runtime.claim(r, [1, 2]);
		for (const slot of [1, 2])
			writeFileSync(
				join(root, `flywheel-test-slot-${slot}.lock/pid`),
				"service-cleaned\n",
			);
		const result = await runtime.residue(r, [1, 2]);
		expect(result.ok).toBe(false);
		expect(result.details.join(" ")).toContain("slot-2");
		expect(result.details.join(" ")).not.toContain("slot-10");
		expect(existsSync(join(root, "flywheel-test-slot-1.lock"))).toBe(true);
	});
	it("respects matching owner lstart and observes operation argv if owner publication is pending", async () => {
		const root = fixture();
		const o = op(root);
		mkdirSync(o.operation_dir, { recursive: true });
		writeFileSync(
			join(o.operation_dir, "owner.json"),
			JSON.stringify({ operation_id: "op", pid: 1234, lstart: "start" }),
		);
		const exec = vi.fn(async () => "1234 1234 Sat Sep 26 10:00:00 2026 bash");
		writeFileSync(
			join(o.operation_dir, "owner.json"),
			JSON.stringify({
				operation_id: "op",
				pid: 1234,
				lstart: "Sat Sep 26 10:00:00 2026",
			}),
		);
		const runtime = new LocalQaRoomRuntime({ repoRoot: root, exec });
		expect((await runtime.observe(o)).alive).toBe(true);
		exec.mockResolvedValue("1234 1234 Sat Sep 26 11:00:00 2026 unrelated");
		expect((await runtime.observe(o)).alive).toBe(false);
		rmSync(join(o.operation_dir, "owner.json"));
		exec.mockResolvedValue(
			`1234 1234 Sat Sep 26 10:00:00 2026 bash /repo/scripts/lib/qa-room-job.sh deploy ${o.operation_dir} abc`,
		);
		expect((await runtime.observe({ ...o, pid: null })).alive).toBe(true);
	});
	it("terminates the detached process group with a grace period then escalates", async () => {
		const root = fixture();
		const o = op(root);
		const signal = vi.fn();
		const sleep = vi.fn(async () => {});
		const exec = vi.fn(
			async () =>
				`1234 1234 Sat Sep 26 10:00:00 2026 bash /repo/scripts/lib/qa-room-job.sh deploy ${o.operation_dir} abc\n1235 1234 Sat Sep 26 10:00:01 2026 pnpm build`,
		);
		exec.mockResolvedValueOnce(
			`1234 1234 Sat Sep 26 10:00:00 2026 bash /repo/scripts/lib/qa-room-job.sh deploy ${o.operation_dir} abc\n1235 1234 Sat Sep 26 10:00:01 2026 pnpm build`,
		);
		exec.mockResolvedValue("1235 1234 Sat Sep 26 10:00:01 2026 pnpm build");
		const runtime = new LocalQaRoomRuntime({
			repoRoot: root,
			signal,
			sleep,
			exec,
		});
		await runtime.terminate(o);
		expect(signal.mock.calls).toEqual([
			[-1234, "SIGTERM"],
			[-1234, "SIGKILL"],
		]);
		expect(sleep).toHaveBeenCalledWith(10000);
	});
	it("keeps observation errors distinct from a dead owner and refuses reused process identities", async () => {
		const root = fixture();
		const o = op(root);
		mkdirSync(o.operation_dir, { recursive: true });
		writeFileSync(
			join(o.operation_dir, "owner.json"),
			JSON.stringify({
				operation_id: "op",
				pid: 1234,
				lstart: "Sat Sep 26 10:00:00 2026",
			}),
		);
		const exec = vi.fn(async (): Promise<string> => {
			throw new Error("ps timed out");
		});
		const signal = vi.fn();
		const runtime = new LocalQaRoomRuntime({ repoRoot: root, exec, signal });
		await expect(runtime.observe(o)).rejects.toThrow("ps timed out");
		await expect(runtime.terminate(o)).rejects.toThrow("ps timed out");
		exec.mockResolvedValue("1234 1234 Sat Sep 26 11:00:00 2026 unrelated");
		await expect(runtime.terminate(o)).rejects.toThrow("job_owner_changed");
		expect(signal).not.toHaveBeenCalled();
		exec.mockResolvedValue("");
		expect((await runtime.observe(o)).alive).toBe(false);
	});
	it("does not escalate into a reused process group after the grace period", async () => {
		const root = fixture();
		const o = op(root);
		const exec = vi.fn(
			async () => "1234 1234 Sat Sep 26 11:00:00 2026 unrelated",
		);
		exec.mockResolvedValueOnce(
			`1234 1234 Sat Sep 26 10:00:00 2026 bash /repo/scripts/lib/qa-room-job.sh deploy ${o.operation_dir} abc`,
		);
		const signal = vi.fn();
		const runtime = new LocalQaRoomRuntime({
			repoRoot: root,
			exec,
			signal,
			sleep: async () => {},
		});
		await runtime.terminate(o);
		expect(signal.mock.calls).toEqual([[-1234, "SIGTERM"]]);
	});
});
