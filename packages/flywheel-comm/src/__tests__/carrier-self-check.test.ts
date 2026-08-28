import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLeadLeaseCommand } from "../commands/lead-lease.js";
import { resolveLeadIdentity } from "../lead-identity.js";
import {
	evaluateCarrierReceipt,
	hashCarrierInstanceId,
	publishCarrierRuntimeAssertion,
	READINESS_SELF_CHECK_MAX_AGE_MS,
	readCarrierReceipt,
	readCarrierRuntimeAssertion,
} from "../lead-lease.js";

const LEAD_ID = "eng-lead";
const LEAD_KEY = "flywheel-eng-lead";
const RAW_CLAIM = "raw-carrier-capability";
const CHECKED_AT = "2026-07-16T12:00:00.000Z";

describe("FLY-1309 carrier-local self-check", () => {
	let dir: string;
	let env: Record<string, string>;
	let stdout: string[];
	let stderr: string[];
	let fetchImpl: ReturnType<typeof vi.fn>;
	let identityDigest: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-self-check-"));
		mkdirSync(join(dir, ".flywheel"), { recursive: true });
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "test",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		env = {
			FLYWHEEL_STATE_DIR: join(dir, ".flywheel"),
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "carrier-evidence.json"),
			FLYWHEEL_LEAD_RECEIPT_DIR: join(dir, "receipts"),
			FLYWHEEL_LEAD_ID: LEAD_ID,
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: RAW_CLAIM,
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			TEAMLEAD_API_TOKEN: "token",
		};
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: LEAD_ID,
							summaryRole: "producer",
							backend: "codex-app-server",
							discordStateDir: join(dir, "discord-eng"),
						},
					],
				},
			]),
		);
		identityDigest = resolveLeadIdentity({
			projectsPath: env.FLYWHEEL_PROJECTS_FILE,
			projectName: "flywheel",
			leadId: LEAD_ID,
			homeDir: dir,
		}).identityDigest;
		env.FLYWHEEL_LEAD_IDENTITY_DIGEST = identityDigest;
		writeFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE,
			JSON.stringify({
				schemaVersion: 1,
				collectedAt: CHECKED_AT,
				leads: {
					[LEAD_KEY]: {
						leadKey: LEAD_KEY,
						backend: "codex-app-server",
						identityDigest,
						pid: 777,
						lstart: "carrier-start",
						instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
					},
				},
			}),
		);
		stdout = [];
		stderr = [];
		fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						disposition: "carrier_passthrough",
						leadKey: LEAD_KEY,
						carrier: {
							identityDigest,
							pid: 777,
							lstart: "carrier-start",
							instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function run(): Promise<number> {
		return runLeadLeaseCommand(["carrier-self-check", "--json"], {
			env,
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
			fetchImpl: fetchImpl as typeof fetch,
			now: () => Date.parse(CHECKED_AT),
			leadWriteAuthorizationDeps: {
				now: () => Date.parse(CHECKED_AT),
				processAliveWithStart: (pid, start) =>
					pid === 777 && start === "carrier-start",
				processStart: () => "self-check-cli-start",
			},
		});
	}

	it("completes the first check without a receipt and atomically stores only attestation data", async () => {
		expect(
			readCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR, LEAD_KEY),
		).toBeNull();
		expect(await run()).toBe(0);

		const receipt = readCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR, LEAD_KEY);
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			contractVersion: 1,
			leadKey: LEAD_KEY,
			identityDigest,
			instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
			pid: 777,
			lstart: "carrier-start",
			checkedAt: CHECKED_AT,
			cliDisposition: "carrier_passthrough",
			bridgeDisposition: "carrier_passthrough",
		});
		const receiptPath = join(env.FLYWHEEL_LEAD_RECEIPT_DIR, `${LEAD_KEY}.json`);
		expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(receiptPath, "utf8")).not.toContain(RAW_CLAIM);
		expect(stdout.join("\n")).not.toContain(RAW_CLAIM);
		expect(stderr.join("\n")).not.toContain(RAW_CLAIM);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [, init] = fetchImpl.mock.calls[0]!;
		expect(init).toMatchObject({ redirect: "error" });
		expect(JSON.parse(String(init?.body))).toMatchObject({
			leadId: LEAD_ID,
			projectName: "flywheel",
			identityDigest,
			carrierClaim: RAW_CLAIM,
		});
	});

	it("rejects a live carrier after its canonical registry row changes", async () => {
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: LEAD_ID,
							summaryRole: "producer",
							backend: "codex-app-server",
							discordStateDir: join(dir, "discord-eng-reassigned"),
						},
					],
				},
			]),
		);

		expect(await run()).not.toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(stderr.join("\n")).toContain("identity_digest_mismatch");
	});

	it("fences a carrier when the global summary-assignment projection changes", async () => {
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: LEAD_ID,
							summaryRole: "producer",
							backend: "codex-app-server",
							discordStateDir: join(dir, "discord-eng"),
						},
						{
							agentId: "product-lead",
							summaryRole: "producer",
							backend: "claude-code",
							discordStateDir: join(dir, "discord-product"),
						},
					],
				},
			]),
		);
		expect(
			resolveLeadIdentity({
				projectsPath: env.FLYWHEEL_PROJECTS_FILE,
				projectName: "flywheel",
				leadId: LEAD_ID,
				homeDir: dir,
			}).identityDigest,
		).not.toBe(identityDigest);

		expect(await run()).not.toBe(0);
		expect(stderr.join("\n")).toContain("identity_digest_mismatch");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		["Bridge unreachable", () => Promise.reject(new Error("ECONNREFUSED"))],
		[
			"Bridge rejects",
			() =>
				Promise.resolve(
					new Response(JSON.stringify({ ok: false, reason: "claim_wrong" }), {
						status: 409,
					}),
				),
		],
	] as const)("does not write a receipt when %s", async (_label, behavior) => {
		fetchImpl.mockImplementation(behavior);
		expect(await run()).not.toBe(0);
		expect(
			readCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR, LEAD_KEY),
		).toBeNull();
	});

	it("does not write a receipt when Bridge attests a different carrier generation", async () => {
		fetchImpl.mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					disposition: "carrier_passthrough",
					leadKey: LEAD_KEY,
					carrier: {
						identityDigest,
						pid: 888,
						lstart: "replacement-start",
						instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
					},
				}),
				{ status: 200 },
			),
		);
		expect(await run()).not.toBe(0);
		expect(
			readCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR, LEAD_KEY),
		).toBeNull();
	});

	it("refuses to replace a symlink receipt", async () => {
		mkdirSync(env.FLYWHEEL_LEAD_RECEIPT_DIR, { recursive: true });
		const target = join(dir, "outside.json");
		writeFileSync(target, "untouched");
		symlinkSync(
			target,
			join(env.FLYWHEEL_LEAD_RECEIPT_DIR, `${LEAD_KEY}.json`),
		);

		expect(await run()).not.toBe(0);
		expect(readFileSync(target, "utf8")).toBe("untouched");
	});

	it("uses the persistent carrier pid, never the short-lived self-check CLI pid", async () => {
		expect(await run()).toBe(0);
		const receipt = readCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR, LEAD_KEY);
		expect(receipt?.pid).toBe(777);
		expect(receipt?.pid).not.toBe(process.pid);
	});

	it("reports exact readiness freshness boundaries and rejects future timestamps", () => {
		const receipt = {
			schemaVersion: 1 as const,
			contractVersion: 1 as const,
			leadKey: LEAD_KEY,
			identityDigest,
			instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
			pid: 777,
			lstart: "carrier-start",
			checkedAt: CHECKED_AT,
			cliDisposition: "carrier_passthrough" as const,
			bridgeDisposition: "carrier_passthrough" as const,
		};
		const evidence = {
			leadKey: LEAD_KEY,
			backend: "codex-app-server" as const,
			identityDigest,
			pid: 777,
			lstart: "carrier-start",
			instanceDigest: receipt.instanceDigest,
		};
		const checked = Date.parse(CHECKED_AT);
		expect(
			evaluateCarrierReceipt(
				receipt,
				evidence,
				checked + READINESS_SELF_CHECK_MAX_AGE_MS - 1,
			),
		).toMatchObject({ ready: true, receiptAgeMs: 3_599_999 });
		expect(
			evaluateCarrierReceipt(
				receipt,
				evidence,
				checked + READINESS_SELF_CHECK_MAX_AGE_MS,
			),
		).toMatchObject({ ready: false, expiryReason: "receipt_expired" });
		expect(
			evaluateCarrierReceipt(receipt, evidence, checked - 5_001),
		).toMatchObject({ ready: false, expiryReason: "receipt_from_future" });
	});

	it.each([
		["pid reuse", { pid: 888 }],
		["lstart replacement", { lstart: "replacement-start" }],
		[
			"generation digest change",
			{ instanceDigest: hashCarrierInstanceId("new") },
		],
	] as const)("invalidates readiness on %s", (_label, change) => {
		const receipt = {
			schemaVersion: 1 as const,
			contractVersion: 1 as const,
			leadKey: LEAD_KEY,
			identityDigest,
			instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
			pid: 777,
			lstart: "carrier-start",
			checkedAt: CHECKED_AT,
			cliDisposition: "carrier_passthrough" as const,
			bridgeDisposition: "carrier_passthrough" as const,
		};
		const evidence = {
			leadKey: LEAD_KEY,
			backend: "codex-app-server" as const,
			identityDigest,
			pid: 777,
			lstart: "carrier-start",
			instanceDigest: receipt.instanceDigest,
			...change,
		};
		expect(
			evaluateCarrierReceipt(receipt, evidence, Date.parse(CHECKED_AT)),
		).toMatchObject({
			ready: false,
			expiryReason: "carrier_generation_mismatch",
		});
	});

	it("never creates a receipt when local carrier validation fails", async () => {
		writeFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE, "{broken");
		expect(await run()).not.toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(existsSync(env.FLYWHEEL_LEAD_RECEIPT_DIR)).toBe(false);
	});

	it("publishes only a secret-free per-lead runtime assertion", () => {
		env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR = join(dir, "assertions");
		const evidenceBefore = readFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE,
			"utf8",
		);
		const result = publishCarrierRuntimeAssertion({
			env,
			leadKey: LEAD_KEY,
			identityDigest,
			rawCarrierInstanceId: RAW_CLAIM,
			pid: 777,
			lstart: "carrier-start",
			now: CHECKED_AT,
		});
		expect(result.instanceDigest).toBe(hashCarrierInstanceId(RAW_CLAIM));
		const assertionPath = join(
			env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR,
			`${encodeURIComponent(LEAD_KEY)}.json`,
		);
		const raw = readFileSync(assertionPath, "utf8");
		expect(raw).not.toContain(RAW_CLAIM);
		expect(lstatSync(assertionPath).mode & 0o777).toBe(0o600);
		expect(readCarrierRuntimeAssertion(env, LEAD_KEY)).toMatchObject({
			schemaVersion: 1,
			leadKey: LEAD_KEY,
			identityDigest,
			pid: 777,
			lstart: "carrier-start",
			publishedAt: CHECKED_AT,
		});
		expect(readFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE, "utf8")).toBe(
			evidenceBefore,
		);
	});
});
