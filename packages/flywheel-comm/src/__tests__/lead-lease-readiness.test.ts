import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLeadLeaseCommand } from "../commands/lead-lease.js";
import {
	collectLeadLeaseDiagnostics,
	ensureLeaseEpisodeMaterialized,
	hashCarrierInstanceId,
	LeadLeaseEpisodeStore,
	LeadLeaseStore,
	recoverLeaseEpisode,
	writeCarrierAuthorizationEvidenceSnapshot,
	writeCarrierReceipt,
} from "../lead-lease.js";
import { LeadLeaseModeStore } from "../lead-lease-mode.js";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const CLAIM = "carrier-generation";
const IDENTITY_DIGEST = "c".repeat(64);

describe("FLY-1309 executable lease readiness", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	let stdout: string[];
	let stderr: string[];
	let overridePid: number | null;
	let carrierAlive: boolean;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-readiness-"));
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
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "lease.db"),
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(dir, "mode.json"),
			FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR: join(dir, "assertions"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "carrier.json"),
			FLYWHEEL_LEAD_RECEIPT_DIR: join(dir, "receipts"),
			FLYWHEEL_ALERT_QUEUE_DIR: join(dir, "queue"),
			FLYWHEEL_ALERT_DEADLETTER_DIR: join(dir, "dead"),
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "episodes.db"),
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			TEAMLEAD_API_TOKEN: "token",
		};
		stdout = [];
		stderr = [];
		overridePid = null;
		carrierAlive = true;
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE!,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: "claude-lead",
							summaryRole: "producer",
							backend: "claude-code",
						},
						{
							agentId: "codex-lead",
							summaryRole: "producer",
							backend: "codex-app-server",
						},
					],
				},
			]),
		);
		new LeadLeaseModeStore(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, env).set(
			"audit_only",
			"test",
		);
		const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!, {
			processAliveWithStart: () => false,
		});
		lease.acquire({
			leadKey: "flywheel-claude-lead",
			project: "flywheel",
			leadId: "claude-lead",
			supervisorPid: 100,
			supervisorStart: "supervisor",
			acquiredBy: "test",
		});
		lease.bind({
			leadKey: "flywheel-claude-lead",
			generation: 1,
			expectedSupervisorPid: 100,
			expectedSupervisorStart: "supervisor",
			panePid: 200,
			paneStart: "claude-pane",
		});
		lease.close();
		writeCarrierAuthorizationEvidenceSnapshot({
			env,
			collectedAt: new Date(NOW).toISOString(),
			leads: {
				"flywheel-codex-lead": {
					leadKey: "flywheel-codex-lead",
					backend: "codex-app-server",
					identityDigest: IDENTITY_DIGEST,
					pid: 300,
					lstart: "codex-carrier",
					instanceDigest: hashCarrierInstanceId(CLAIM),
				},
			},
		});
		writeCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR!, {
			schemaVersion: 1,
			contractVersion: 1,
			leadKey: "flywheel-codex-lead",
			identityDigest: IDENTITY_DIGEST,
			instanceDigest: hashCarrierInstanceId(CLAIM),
			pid: 300,
			lstart: "codex-carrier",
			checkedAt: new Date(NOW).toISOString(),
			cliDisposition: "carrier_passthrough",
			bridgeDisposition: "carrier_passthrough",
		});
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function diagnostics() {
		return collectLeadLeaseDiagnostics(env, {
			now: () => NOW,
			processAliveWithStart: (pid, start) =>
				(pid === 200 && start === "claude-pane") ||
				(carrierAlive && pid === 300 && start === "codex-carrier"),
			processEnvHas: (pid) => pid === overridePid,
		});
	}

	async function runReadiness(input?: {
		localOnly?: boolean;
		bridge?: ReturnType<typeof diagnostics>;
		status?: number;
	}) {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify(input?.bridge ?? diagnostics()), {
					status: input?.status ?? 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const code = await runLeadLeaseCommand(
			["readiness", "--json", ...(input?.localOnly ? ["--local-only"] : [])],
			{
				env,
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
				fetchImpl: fetchImpl as typeof fetch,
				leadWriteAuthorizationDeps: {
					now: () => NOW,
					processAliveWithStart: (pid, start) =>
						(pid === 200 && start === "claude-pane") ||
						(carrierAlive && pid === 300 && start === "codex-carrier"),
					processEnvHas: (pid) => pid === overridePid,
				},
			},
		);
		return { code, fetchImpl };
	}

	it("is green only when Claude lease and Codex carrier receipt are both live", () => {
		const result = diagnostics();
		expect(result.healthy).toBe(true);
		expect(result.modeOverridePresent).toBe(false);
		expect(result.resolver).toMatchObject({
			status: "ok",
			ambiguousLeadIds: [],
		});
		expect(result.leads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					leadKey: "flywheel-claude-lead",
					ready: true,
					processModeOverridePresent: false,
					backendDrift: expect.objectContaining({ drifted: false }),
					lease: expect.objectContaining({
						bound: true,
						holderAlive: true,
					}),
				}),
				expect.objectContaining({
					leadKey: "flywheel-codex-lead",
					ready: true,
					processModeOverridePresent: false,
					backendDrift: expect.objectContaining({
						drifted: false,
						evidenceSource: "fleet_poller",
					}),
					carrierInstanceReady: expect.objectContaining({
						ready: true,
						evidencePresent: true,
						evidenceFresh: true,
						evidencePidAlive: true,
						receiptAgeMs: 0,
						maxAgeMs: 3_600_000,
					}),
				}),
			]),
		);
		expect(JSON.stringify(result)).not.toContain(CLAIM);
	});

	it("fails on a stale carrier receipt without weakening runtime evidence", () => {
		writeCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR!, {
			schemaVersion: 1,
			contractVersion: 1,
			leadKey: "flywheel-codex-lead",
			identityDigest: IDENTITY_DIGEST,
			instanceDigest: hashCarrierInstanceId(CLAIM),
			pid: 300,
			lstart: "codex-carrier",
			checkedAt: new Date(NOW - 3_600_000).toISOString(),
			cliDisposition: "carrier_passthrough",
			bridgeDisposition: "carrier_passthrough",
		});
		const result = diagnostics();
		expect(result.healthy).toBe(false);
		expect(
			result.leads.find((lead) => lead.leadId === "codex-lead")
				?.carrierInstanceReady,
		).toMatchObject({ ready: false, expiryReason: "receipt_expired" });
	});

	it.each(["missing", "wrong digest", "wrong disposition", "dead pid"])(
		"fails carrierInstanceReady for a %s current-generation proof",
		(fault) => {
			const receiptPath = join(
				env.FLYWHEEL_LEAD_RECEIPT_DIR!,
				"flywheel-codex-lead.json",
			);
			if (fault === "missing") rmSync(receiptPath);
			if (fault === "wrong digest") {
				writeCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR!, {
					schemaVersion: 1,
					contractVersion: 1,
					leadKey: "flywheel-codex-lead",
					identityDigest: IDENTITY_DIGEST,
					instanceDigest: hashCarrierInstanceId("old-generation"),
					pid: 300,
					lstart: "codex-carrier",
					checkedAt: new Date(NOW).toISOString(),
					cliDisposition: "carrier_passthrough",
					bridgeDisposition: "carrier_passthrough",
				});
			}
			if (fault === "wrong disposition") {
				writeFileSync(
					receiptPath,
					JSON.stringify({
						schemaVersion: 1,
						contractVersion: 1,
						leadKey: "flywheel-codex-lead",
						identityDigest: IDENTITY_DIGEST,
						instanceDigest: hashCarrierInstanceId(CLAIM),
						pid: 300,
						lstart: "codex-carrier",
						checkedAt: new Date(NOW).toISOString(),
						cliDisposition: "audit_allowed",
						bridgeDisposition: "carrier_passthrough",
					}),
				);
			}
			if (fault === "dead pid") carrierAlive = false;
			const result = diagnostics();
			expect(result.healthy).toBe(false);
			expect(
				result.leads.find((lead) => lead.leadId === "codex-lead"),
			).toMatchObject({
				ready: false,
				carrierInstanceReady: { ready: false },
			});
		},
	);

	it("reports backend drift when desired Codex evidence disappears", () => {
		rmSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!);
		expect(diagnostics()).toMatchObject({
			healthy: false,
			leads: expect.arrayContaining([
				expect.objectContaining({
					leadId: "codex-lead",
					backendDrift: expect.objectContaining({
						drifted: true,
						reason: "carrier_evidence_missing",
					}),
				}),
			]),
		});
	});

	it("fails on lease-audit dead-letter and recovers when it is removed", () => {
		mkdirSync(env.FLYWHEEL_ALERT_DEADLETTER_DIR!, { recursive: true });
		const dead = join(env.FLYWHEEL_ALERT_DEADLETTER_DIR!, "lease-audit.json");
		writeFileSync(dead, JSON.stringify({ queueReason: "lease-audit" }));
		expect(diagnostics()).toMatchObject({
			healthy: false,
			audit: { deadLettered: 1 },
		});
		rmSync(dead);
		expect(diagnostics().healthy).toBe(true);
	});

	it("fails whenever a process-local mode override is present", () => {
		env.FLYWHEEL_LEAD_LEASE_MODE = "audit_only";
		expect(diagnostics()).toMatchObject({
			healthy: false,
			modeOverridePresent: true,
		});
	});

	it("fails while a recovered fault episode is still queued for delivery", () => {
		const episode = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: "lead_backend_drift:carrier:flywheel-codex-lead",
			kind: "lead_backend_drift",
			payload: {
				eventType: "lead_backend_drift",
				leadId: "codex-lead",
				projectName: "flywheel",
				title: "drift",
				body: "drift",
			},
		});
		expect(
			recoverLeaseEpisode({
				env,
				sourceFingerprint: "lead_backend_drift:carrier:flywheel-codex-lead",
			}),
		).toBe(true);
		expect(diagnostics()).toMatchObject({
			healthy: false,
			episodes: { active: 0, counts: { queued: 1 } },
		});

		const store = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		store.markDelivery(episode.episodeId, "delivered");
		store.close();
		expect(diagnostics().healthy).toBe(true);
	});

	it("fails when any live Lead holder has a process-local mode override", () => {
		overridePid = 200;
		expect(diagnostics()).toMatchObject({
			healthy: false,
			leads: expect.arrayContaining([
				expect.objectContaining({
					leadId: "claude-lead",
					ready: false,
					processModeOverridePresent: true,
				}),
			]),
		});
	});

	it("exits zero for a healthy local-only proof without contacting Bridge", async () => {
		const { code, fetchImpl } = await runReadiness({ localOnly: true });
		expect(code).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			local: { healthy: true },
		});
	});

	it("requires full local/Bridge parity and sends only bearer-authenticated GET", async () => {
		const { code, fetchImpl } = await runReadiness();
		expect(code).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, parity: true });
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/lead-lease/diagnostics",
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				headers: { Authorization: "Bearer token" },
			}),
		);
		expect(stdout.join("\n")).not.toContain(CLAIM);
		expect(stderr.join("\n")).not.toContain(CLAIM);
	});

	it.each(["mode path", "projects digest", "carrier verdict"])(
		"fails closed on Bridge parity drift: %s",
		async (fault) => {
			const bridge = structuredClone(diagnostics());
			if (fault === "mode path")
				bridge.paths.modeFile = join(dir, "other.json");
			if (fault === "projects digest" && bridge.resolver.status === "ok") {
				bridge.resolver.projectsDigest = "0".repeat(64);
			}
			if (fault === "carrier verdict") {
				bridge.healthy = false;
				const carrier = bridge.leads.find(
					(lead) => lead.leadId === "codex-lead",
				);
				if (carrier?.carrierInstanceReady) {
					carrier.ready = false;
					carrier.carrierInstanceReady.ready = false;
					carrier.carrierInstanceReady.expiryReason =
						"carrier_generation_mismatch";
				}
			}
			const { code } = await runReadiness({ bridge });
			expect(code).toBe(1);
			expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
				ok: false,
				parity: false,
			});
		},
	);

	it("fails closed when Bridge diagnostics are unavailable", async () => {
		const { code } = await runReadiness({ status: 503 });
		expect(code).toBe(1);
		expect(stderr).toContain(
			"lead-lease readiness: Bridge diagnostics HTTP 503",
		);
		expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
			ok: false,
			parity: false,
			bridgeStatus: 503,
		});
	});
});
