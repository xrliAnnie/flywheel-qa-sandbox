#!/usr/bin/env node
/**
 * FLY-2654 QA2 rework: the operator path to the standing-authority activation
 * store. QA2 proved `stageStandingAuthorityCandidate` had no non-test caller,
 * so no operator could ever stage a pending manifest and both carve-outs were
 * inert. This CLI is that shipped path:
 *
 *   stage    — the deployment/handoff producer (Engineering Lead) stages the
 *              pending candidate (manifest + contract bytes + evidence). This
 *              never activates anything.
 *   confirm  — the independent confirmer (flywheel-cos-lead, never the author
 *              or implementer) posts its authenticated confirmation to the
 *              Bridge ingress. The Bridge, not this process, validates the
 *              confirmer's live carrier and writes the authoritative row.
 *   status   — consumer-side readback through the same verifier the updater
 *              and restart producer use. It reads the Bridge ledger back; it
 *              is a readback, not self-attestation.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { postCarrierClaim } from "flywheel-comm/lead-lease";
import {
	STANDING_AUTHORITY_ENTRY_IDS,
	type StandingAuthorityEntryId,
	standingAuthorityManifestDigest,
} from "./standing-authority.js";
import {
	loadVerifiedStandingAuthority,
	type StandingAuthorityCandidate,
	stageStandingAuthorityCandidate,
} from "./standing-authority-activation-store.js";
import { resolveStandingAuthorityLedgerPath } from "./standing-authority-confirmation-ledger.js";

const CANDIDATE_KEYS = [
	"manifest",
	"contractCommit",
	"deployment",
	"verificationReceipt",
	"liveBundleReceipt",
] as const;
const MAX_CANDIDATE_BYTES = 256 * 1024;
const MAX_CONTRACT_BYTES = 512 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;

export interface StandingAuthorityActivationCliIo {
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

function entryId(value: string | undefined): StandingAuthorityEntryId {
	if (
		!value ||
		!(STANDING_AUTHORITY_ENTRY_IDS as readonly string[]).includes(value)
	)
		throw new Error("--entry-id must be one of the two standing entries");
	return value as StandingAuthorityEntryId;
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function readCandidateFile(path: string): StandingAuthorityCandidate {
	const bytes = readFileSync(resolve(path));
	if (bytes.length > MAX_CANDIDATE_BYTES)
		throw new Error("candidate file exceeds the size limit");
	const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).some(
			(key) => !(CANDIDATE_KEYS as readonly string[]).includes(key),
		) ||
		CANDIDATE_KEYS.some((key) => parsed[key] === undefined)
	)
		throw new Error(
			`candidate file must contain exactly ${CANDIDATE_KEYS.join(", ")}`,
		);
	return parsed as unknown as StandingAuthorityCandidate;
}

export async function runStandingAuthorityActivationCli(
	argv: string[],
	io: Partial<StandingAuthorityActivationCliIo> = {},
): Promise<number> {
	const env = io.env ?? process.env;
	const fetchImpl = io.fetch ?? fetch;
	const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
	const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
	try {
		const parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				root: { type: "string" },
				candidate: { type: "string" },
				contract: { type: "string" },
				"bridge-url": { type: "string" },
				"entry-id": { type: "string" },
				revision: { type: "string" },
				"pending-manifest-digest": { type: "string" },
				home: { type: "string" },
			},
		});
		const command = parsed.positionals[0];
		const values = parsed.values;
		if (command === "stage") {
			const root = resolve(required(values.root, "--root"));
			const candidate = readCandidateFile(
				required(values.candidate, "--candidate"),
			);
			const contractBytes = readFileSync(
				resolve(required(values.contract, "--contract")),
			);
			if (contractBytes.length > MAX_CONTRACT_BYTES)
				throw new Error("contract file exceeds the size limit");
			stageStandingAuthorityCandidate(root, { ...candidate, contractBytes });
			stdout(
				JSON.stringify({
					status: "staged",
					entryId: candidate.manifest.entryId,
					revision: candidate.manifest.revision,
					pendingManifestDigest: standingAuthorityManifestDigest(
						candidate.manifest,
					),
					activation: "not-activated-by-staging",
				}),
			);
			return 0;
		}
		if (command === "confirm") {
			const bridgeUrl = required(
				values["bridge-url"] ?? env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL,
				"--bridge-url or FLYWHEEL_BRIDGE_URL",
			);
			const token = required(
				env.FLYWHEEL_API_TOKEN ?? env.TEAMLEAD_API_TOKEN,
				"FLYWHEEL_API_TOKEN or TEAMLEAD_API_TOKEN",
			);
			const projectName = required(
				env.FLYWHEEL_PROJECT_NAME,
				"FLYWHEEL_PROJECT_NAME",
			);
			const identityDigest = required(
				env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
				"FLYWHEEL_LEAD_IDENTITY_DIGEST",
			);
			if (!DIGEST.test(identityDigest))
				throw new Error("FLYWHEEL_LEAD_IDENTITY_DIGEST is not a sha256");
			const revision = Number(required(values.revision, "--revision"));
			if (!Number.isSafeInteger(revision) || revision < 1)
				throw new Error("--revision must be a positive integer");
			const pendingManifestDigest = required(
				values["pending-manifest-digest"],
				"--pending-manifest-digest",
			);
			if (!DIGEST.test(pendingManifestDigest))
				throw new Error("--pending-manifest-digest is not a sha256");
			// The claim is backend-shaped: a Claude Lead proves its bound lease
			// generation; a Codex Lead proves its carrier instance. The Bridge
			// validates either against live state, never this process's word.
			const backend = env.FLYWHEEL_LEAD_BACKEND;
			let carrierClaim: string;
			if (backend === "claude-code") {
				const generation = required(
					env.FLYWHEEL_LEAD_GENERATION,
					"FLYWHEEL_LEAD_GENERATION",
				);
				if (!/^[1-9][0-9]{0,9}$/.test(generation))
					throw new Error("FLYWHEEL_LEAD_GENERATION is not a lease generation");
				carrierClaim = `claude-lease:g${generation}`;
			} else if (backend === "codex-app-server") {
				carrierClaim = required(
					env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
					"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID",
				);
			} else {
				throw new Error(
					"FLYWHEEL_LEAD_BACKEND must be claude-code or codex-app-server",
				);
			}
			const response = await postCarrierClaim({
				url: `${bridgeUrl.replace(/\/+$/, "")}/api/standing-authority/confirm`,
				carrierClaim,
				headers: { authorization: `Bearer ${token}` },
				body: {
					schemaVersion: 1,
					projectName,
					identityDigest,
					entryId: entryId(values["entry-id"]),
					revision,
					pendingManifestDigest,
				},
				fetchImpl,
			});
			const text = await response.text();
			let result: unknown;
			try {
				result = JSON.parse(text);
			} catch {
				throw new Error(
					`Bridge confirm ingress returned a non-JSON ${response.status} response`,
				);
			}
			stdout(JSON.stringify({ httpStatus: response.status, result }));
			return response.ok && (result as { status?: unknown }).status === "active"
				? 0
				: 3;
		}
		if (command === "status") {
			const root = resolve(required(values.root, "--root"));
			const home = resolve(values.home ?? homedir());
			const verified = loadVerifiedStandingAuthority(
				root,
				entryId(values["entry-id"]),
				{ ledgerPath: resolveStandingAuthorityLedgerPath(home) },
			);
			stdout(
				JSON.stringify({
					status: "active",
					source: "bridge-ledger-readback",
					entryId: verified.verification.entryId,
					revision: verified.verification.revision,
					manifestDigest: verified.verification.manifestDigest,
					packageDigest: verified.verification.packageDigest,
					confirmerIdentity: verified.record.confirmerIdentity,
					confirmedAt: verified.record.confirmedAt,
					receiptId: verified.record.receiptId,
				}),
			);
			return 0;
		}
		throw new Error("command must be stage, confirm, or status");
	} catch (error) {
		stderr((error as Error).message.slice(0, 500));
		return 2;
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	runStandingAuthorityActivationCli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
