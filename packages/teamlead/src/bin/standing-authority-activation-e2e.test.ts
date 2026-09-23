/**
 * FLY-2654 QA2 rework (hard-red 1): one end-to-end activation through the
 * shipped operator path and the Bridge ingress, with the production
 * confirmer carrier (flywheel-cos-lead on backend claude-code) and an
 * independent confirmer who is neither the author nor the implementer.
 *
 * Nothing here is self-attestation: the Engineering Lead only stages; the
 * activation row is written by the Bridge route after it validates the
 * confirmer's live lease; the consumer reads that row back through the same
 * verifier the updater and the restart producer use.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";
import { getProcessStart, LeadLeaseStore } from "flywheel-comm/lead-lease";
import { afterEach, expect, it } from "vitest";
import { createStandingAuthorityConfirmationRouter } from "../bridge/standing-authority-confirmation-route.js";
import {
	extractStandingAuthorityEntry,
	type StandingAuthorityManifest,
	standingAuthorityManifestDigest,
} from "./standing-authority.js";
import { runStandingAuthorityActivationCli } from "./standing-authority-activation-cli.js";
import {
	confirmStandingAuthorityCandidate,
	loadVerifiedStandingAuthority,
} from "./standing-authority-activation-store.js";
import {
	readStandingAuthorityConfirmationRecord,
	STANDING_AUTHORITY_CONFIRMATION_DDL,
	STANDING_AUTHORITY_CONFIRMATION_TRIGGERS,
	type StandingAuthorityConfirmationRecord,
} from "./standing-authority-confirmation-ledger.js";
import { buildStandingAuthorityPackageManifest } from "./standing-authority-package.js";

const dirs: string[] = [];
const sha = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Stand-in for the Bridge StateStore ledger the confirm route writes. */
function ledgerFixture(path: string) {
	const db = new Database(path);
	db.exec(STANDING_AUTHORITY_CONFIRMATION_DDL);
	for (const trigger of STANDING_AUTHORITY_CONFIRMATION_TRIGGERS)
		db.exec(trigger);
	db.close();
	return {
		path,
		record(row: StandingAuthorityConfirmationRecord) {
			const open = new Database(path);
			open
				.prepare(
					`INSERT INTO standing_authority_confirmation
					 (receipt_id, entry_id, revision, manifest_digest, evidence_body_digest,
					  package_digest, confirmer_identity, confirmer_identity_digest,
					  carrier_claim, confirmed_at, recorded_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					row.receiptId,
					row.entryId,
					row.revision,
					row.manifestDigest,
					row.evidenceBodyDigest,
					row.packageDigest,
					row.confirmerIdentity,
					row.confirmerIdentityDigest,
					row.carrierClaim,
					row.confirmedAt,
					row.recordedAt,
				);
			open.close();
		},
	};
}

function cliIo(env: NodeJS.ProcessEnv) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: {
			env,
			stdout: (line: string) => {
				out.push(line);
			},
			stderr: (line: string) => {
				err.push(line);
			},
		},
		out,
		err,
	};
}

it("activates one entry end to end: Lead stages, the claude-code CoS confirms through the Bridge, consumers read the row back", async () => {
	const home = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2654-activation-e2e-")),
	);
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"), { recursive: true });
	writeFileSync(
		join(home, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-20T00:00:00Z",
		}),
	);
	const projectsPath = join(home, ".flywheel", "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "flywheel",
				projectRoot: home,
				generalChannel: "11111111111111111",
				leads: [
					{
						agentId: "flywheel-cos-lead",
						summaryRole: "aggregator",
						chatChannel: "11111111111111111",
						match: { labels: ["CoS"] },
						role: "cos",
						// The live production row: the confirmer is a Claude Lead.
						backend: "claude-code",
					},
					{
						agentId: "flywheel-eng-lead",
						summaryRole: "producer",
						chatChannel: "21111111111111111",
						match: { labels: ["Eng"] },
						role: "dept",
						backend: "claude-code",
					},
				],
			},
		]),
	);
	const cos = resolveLeadIdentity({
		projectsPath,
		projectName: "flywheel",
		leadId: "flywheel-cos-lead",
		homeDir: home,
	});
	const eng = resolveLeadIdentity({
		projectsPath,
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		homeDir: home,
	});
	expect(cos.backend).toBe("claude-code");

	// The CoS Lead holds a bound, live Claude lease (this process is the pane).
	const leaseDb = join(home, ".flywheel", "lead-lease.db");
	const lease = new LeadLeaseStore(leaseDb, {
		processAliveWithStart: () => false,
	});
	const acquired = lease.acquire({
		leadKey: cos.leadKey,
		project: "flywheel",
		leadId: "flywheel-cos-lead",
		identityDigest: cos.identityDigest,
		supervisorPid: 111,
		supervisorStart: "supervisor-start",
		acquiredBy: "test",
	});
	expect(acquired.generation).toBe(1);
	expect(
		lease.bind({
			leadKey: cos.leadKey,
			generation: 1,
			expectedSupervisorPid: 111,
			expectedSupervisorStart: "supervisor-start",
			identityDigest: cos.identityDigest,
			panePid: process.pid,
			paneStart: getProcessStart(process.pid),
		}).status,
	).toBe("bound");
	lease.close();

	// Deployed immutable execution package.
	const packageRoot = join(home, "release");
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	writeFileSync(
		join(packageRoot, "scripts", "update-flywheel.sh"),
		"runtime\n",
	);
	chmodSync(join(packageRoot, "scripts", "update-flywheel.sh"), 0o444);
	const packageManifest = buildStandingAuthorityPackageManifest({
		root: packageRoot,
		sourceCommit: "c".repeat(40),
	});
	writeFileSync(
		join(packageRoot, "standing-authority-package.json"),
		`${JSON.stringify(packageManifest)}\n`,
	);

	const contractBytes = readFileSync(
		new URL("../../lead-rules-base/founder-only-authority.md", import.meta.url),
	);
	const entryId = "raya-carrier-follow-main/v1" as const;
	const entryDigest = sha(
		extractStandingAuthorityEntry(contractBytes, entryId),
	);
	const manifest: StandingAuthorityManifest = {
		schemaVersion: 1,
		entryId,
		entryDigest,
		extractionVersion: "entry-extraction/v1",
		mechanismVersion: "standing-authority/v1",
		scope: {
			repository: "xrliAnnie/raya",
			project: "raya",
			leadClass: "engineering-lead",
			action: "follow-approved-main",
			transport: "com.flywheel.updater",
		},
		revision: 1,
		status: "pending",
		founderApproval: {
			receiptId: "approval",
			channelId: "12345678901234567",
			messageId: "22345678901234567",
			authorId: "32345678901234567",
			approvedAt: "2026-09-20T00:00:00.000Z",
			contentDigest: sha("approval"),
			approvedPrHead: "a".repeat(40),
			entryDigest,
			confirmerIdentity: "flywheel-cos-lead",
		},
		contractLandedCommit: "b".repeat(40),
		enforcementDeployment: {
			commit: "c".repeat(40),
			packageDigest: packageManifest.packageDigest,
			immutableRoot: packageRoot,
			deploymentReceiptId: "deployment",
		},
		verificationReceipt: {
			receiptId: "verification",
			entryId,
			mechanismVersion: "standing-authority/v1",
			executionPackageDigest: packageManifest.packageDigest,
			positiveDigest: sha("positive"),
			negativeDigest: sha("negative"),
			attributionDigest: sha("attribution"),
			sourceDigest: sha("source"),
			authorIdentity: "flywheel-eng-lead",
			implementationIdentity: "implement:FLY-2654",
		},
		liveBundleReceipt: {
			leadIdentity: "flywheel-eng-lead",
			backend: "claude-code",
			instanceId: "instance",
			threadId: "thread",
			turnId: "turn",
			rulesDigest: sha(contractBytes),
			entryDigest,
			observedAt: "2026-09-20T00:05:00.000Z",
			sourceReceiptId: "loaded",
		},
		independentConfirmation: null,
		revocation: null,
	};
	const pendingManifestDigest = standingAuthorityManifestDigest(manifest);

	// 1. Operator path: the Engineering Lead stages the pending candidate.
	const stateRoot = join(home, ".flywheel", "state", "standing-authority");
	const candidateFile = join(home, "candidate.json");
	const contractFile = join(home, "contract.bin");
	writeFileSync(
		candidateFile,
		JSON.stringify({
			manifest,
			contractCommit: manifest.contractLandedCommit,
			deployment: {
				commit: manifest.enforcementDeployment.commit,
				packageDigest: manifest.enforcementDeployment.packageDigest,
				immutableRoot: packageRoot,
				receiptId: manifest.enforcementDeployment.deploymentReceiptId,
			},
			verificationReceipt: manifest.verificationReceipt,
			liveBundleReceipt: manifest.liveBundleReceipt,
		}),
	);
	writeFileSync(contractFile, contractBytes);
	const stage = cliIo({});
	expect(
		await runStandingAuthorityActivationCli(
			[
				"stage",
				"--root",
				stateRoot,
				"--candidate",
				candidateFile,
				"--contract",
				contractFile,
			],
			stage.io,
		),
	).toBe(0);
	expect(JSON.parse(stage.out[0]!)).toMatchObject({
		status: "staged",
		entryId,
		revision: 1,
		pendingManifestDigest,
		activation: "not-activated-by-staging",
	});
	// Staging is idempotent for identical bytes and never activates.
	expect(
		await runStandingAuthorityActivationCli(
			[
				"stage",
				"--root",
				stateRoot,
				"--candidate",
				candidateFile,
				"--contract",
				contractFile,
			],
			cliIo({}).io,
		),
	).toBe(0);
	const ledger = ledgerFixture(join(home, ".flywheel", "teamlead.db"));
	expect(() =>
		loadVerifiedStandingAuthority(stateRoot, entryId, {
			ledgerPath: ledger.path,
		}),
	).toThrow("standing-authority-activation-");

	// 2. Bridge ingress with the real store and the real claude-code lease check.
	const app = express();
	app.use(express.json());
	app.use(
		"/api/standing-authority/confirm",
		createStandingAuthorityConfirmationRouter({
			apiToken: "SECRET",
			homeDir: home,
			projectsPath,
			env: { HOME: home, FLYWHEEL_LEAD_LEASE_DB: leaseDb },
			confirm: (input) =>
				confirmStandingAuthorityCandidate({
					root: stateRoot,
					entryId: input.entryId,
					revision: input.revision,
					pendingManifestDigest: input.pendingManifestDigest,
					authenticatedIdentity: input.authenticatedIdentity.leadId,
					authenticatedIdentityDigest: input.authenticatedIdentityDigest,
					carrierClaim: input.carrierClaim,
					confirmedAt: "2026-09-21T00:10:00.000Z",
					authority: ledger,
				}),
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const bridgeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const confirmArgs = [
		"confirm",
		"--bridge-url",
		bridgeUrl,
		"--entry-id",
		entryId,
		"--revision",
		"1",
		"--pending-manifest-digest",
		pendingManifestDigest,
	];
	const cosEnv = {
		TEAMLEAD_API_TOKEN: "SECRET",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_LEAD_ID: "flywheel-cos-lead",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: cos.identityDigest,
		FLYWHEEL_LEAD_BACKEND: "claude-code",
		FLYWHEEL_LEAD_GENERATION: "1",
	};
	try {
		// Negative: the author/implementer Lead cannot confirm its own entry.
		const author = cliIo({
			...cosEnv,
			FLYWHEEL_LEAD_ID: "flywheel-eng-lead",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: eng.identityDigest,
		});
		expect(
			await runStandingAuthorityActivationCli(confirmArgs, author.io),
		).toBe(3);
		expect(JSON.parse(author.out[0]!)).toMatchObject({
			httpStatus: 403,
			result: { errorCode: "standing_authority_confirmer_denied" },
		});
		// Negative: a lease generation the CoS does not hold.
		const staleLease = cliIo({ ...cosEnv, FLYWHEEL_LEAD_GENERATION: "2" });
		expect(
			await runStandingAuthorityActivationCli(confirmArgs, staleLease.io),
		).toBe(3);
		expect(JSON.parse(staleLease.out[0]!).httpStatus).toBe(403);
		// Negative: a Codex-shaped carrier claim on the claude-code row.
		const wrongCarrier = cliIo({
			...cosEnv,
			FLYWHEEL_LEAD_BACKEND: "codex-app-server",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier-instance-raw",
		});
		expect(
			await runStandingAuthorityActivationCli(confirmArgs, wrongCarrier.io),
		).toBe(3);
		expect(JSON.parse(wrongCarrier.out[0]!).httpStatus).toBe(403);
		expect(() =>
			loadVerifiedStandingAuthority(stateRoot, entryId, {
				ledgerPath: ledger.path,
			}),
		).toThrow("standing-authority-activation-");

		// Positive: the independent confirmer's live claude-code lease.
		const confirm = cliIo(cosEnv);
		expect(
			await runStandingAuthorityActivationCli(confirmArgs, confirm.io),
		).toBe(0);
		const confirmed = JSON.parse(confirm.out[0]!);
		expect(confirmed).toMatchObject({
			httpStatus: 200,
			result: { status: "active", entryId, revision: 1 },
		});
		// Re-confirming the same revision is idempotent.
		const again = cliIo(cosEnv);
		expect(await runStandingAuthorityActivationCli(confirmArgs, again.io)).toBe(
			0,
		);
		expect(JSON.parse(again.out[0]!).result).toEqual(confirmed.result);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}

	// 3. Consumer readback: the same verifier the updater and producer use.
	const verified = loadVerifiedStandingAuthority(stateRoot, entryId, {
		ledgerPath: ledger.path,
	});
	expect(verified.verification).toMatchObject({
		entryId,
		revision: 1,
		packageDigest: packageManifest.packageDigest,
	});
	const record = readStandingAuthorityConfirmationRecord(
		ledger.path,
		verified.record.receiptId,
	);
	expect(record).toMatchObject({
		confirmerIdentity: "flywheel-cos-lead",
		confirmerIdentityDigest: cos.identityDigest,
		carrierClaim: "claude-lease:g1",
	});
	expect(record!.confirmerIdentity).not.toBe(
		manifest.verificationReceipt.authorIdentity,
	);
	expect(record!.confirmerIdentity).not.toBe(
		manifest.verificationReceipt.implementationIdentity,
	);
	const status = cliIo({});
	expect(
		await runStandingAuthorityActivationCli(
			["status", "--root", stateRoot, "--entry-id", entryId, "--home", home],
			status.io,
		),
	).toBe(0);
	expect(JSON.parse(status.out[0]!)).toMatchObject({
		status: "active",
		source: "bridge-ledger-readback",
		entryId,
		revision: 1,
		confirmerIdentity: "flywheel-cos-lead",
		receiptId: verified.record.receiptId,
	});
});

it("refuses to stage a malformed candidate and never touches the store", async () => {
	const home = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2654-activation-cli-")),
	);
	dirs.push(home);
	const root = join(home, "state");
	const candidate = join(home, "candidate.json");
	const contract = join(home, "contract.bin");
	writeFileSync(contract, "not a contract\n");
	writeFileSync(candidate, JSON.stringify({ manifest: {}, extra: true }));
	const extra = cliIo({});
	expect(
		await runStandingAuthorityActivationCli(
			[
				"stage",
				"--root",
				root,
				"--candidate",
				candidate,
				"--contract",
				contract,
			],
			extra.io,
		),
	).toBe(2);
	expect(extra.err[0]).toContain("candidate file must contain exactly");
	writeFileSync(
		candidate,
		JSON.stringify({
			manifest: { status: "active" },
			contractCommit: "b".repeat(40),
			deployment: {},
			verificationReceipt: {},
			liveBundleReceipt: {},
		}),
	);
	const active = cliIo({});
	expect(
		await runStandingAuthorityActivationCli(
			[
				"stage",
				"--root",
				root,
				"--candidate",
				candidate,
				"--contract",
				contract,
			],
			active.io,
		),
	).toBe(2);
	expect(active.err[0]).toBe("standing-authority-activation-candidate-state");
	expect(() => readFileSync(join(root, "pending"))).toThrow();
	const usage = cliIo({});
	expect(await runStandingAuthorityActivationCli(["activate"], usage.io)).toBe(
		2,
	);
	expect(usage.err[0]).toBe("command must be stage, confirm, or status");
});
