#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveFounderId } from "flywheel-comm/founder-attribution";
import {
	assertMigrationOutsideWindow,
	commitMigrationVerification,
	loadMigrationReceipt,
	observeMigrationArtifact,
	observeMigrationRegistry,
	readCommittedMigrationIntent,
	readMigrationIntentRecord,
	readMigrationRegistry,
	renderMigrationArtifacts,
	resolveMigrationIdentities,
	retireCommittedMigrationIntent,
} from "flywheel-comm/lead-backend-migration-runtime";
import { matchesLead } from "../bridge/lead-scope.js";
import { parseAndValidateProjects } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { observeMigrationActivation } from "./backend-migration-activation.js";
import {
	type MigrationRunEvidence,
	verifyMigrationRunEvidence,
	verifyMigrationSource,
} from "./backend-migration-evidence.js";

interface Evidence extends MigrationRunEvidence {
	version: 1;
	channelId: string;
	messageId: string;
}
export function parseMigrationVerificationEvidence(value: unknown): Evidence {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid migration evidence");
	const v = value as Record<string, unknown>;
	const keys = [
		"version",
		"channelId",
		"messageId",
		"issueId",
		"runId",
		"nodeId",
		"executionId",
		"activationId",
		"eventUid",
	];
	if (
		Object.keys(v).length !== keys.length ||
		Object.keys(v).some((k) => !keys.includes(k)) ||
		v.version !== 1
	)
		throw Error("invalid migration evidence fields");
	for (const k of keys.filter((k) => k !== "version"))
		if (
			typeof v[k] !== "string" ||
			!v[k] ||
			String(v[k]).length > 256 ||
			!/^[A-Za-z0-9._:-]+$/.test(String(v[k]))
		)
			throw Error("invalid migration evidence ID");
	const uuid =
		/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
	if (
		!uuid.test(String(v.runId)) ||
		!uuid.test(String(v.executionId)) ||
		!(
			/^[A-Z][A-Z0-9]*-\d+$/.test(String(v.issueId)) ||
			uuid.test(String(v.issueId))
		) ||
		![v.channelId, v.messageId].every((id) =>
			/^[1-9][0-9]{16,19}$/.test(String(id)),
		)
	)
		throw Error("invalid migration evidence locator");
	return v as unknown as Evidence;
}
function readRegular(path: string, max: number): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = fstatSync(fd);
		if (!s.isFile() || s.nlink !== 1 || s.size > max)
			throw Error("invalid verification file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
export async function verifyBackendMigration(
	evidencePath: string,
	trusted = {
		home: homedir(),
		root: realpathSync(fileURLToPath(new URL("../../../../", import.meta.url))),
	},
) {
	const { home, root } = trusted;
	const evidence = parseMigrationVerificationEvidence(
		JSON.parse(readRegular(evidencePath, 65536)),
	);
	const evidenceSha = createHash("sha256")
		.update(JSON.stringify(evidence))
		.digest("hex");
	const activePath = join(
		home,
		".flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json",
	);
	let intent: ReturnType<typeof readMigrationIntentRecord>;
	try {
		intent = readMigrationIntentRecord(home, activePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		intent = readCommittedMigrationIntent(home);
	}
	const { plan, intentSha } = intent;
	const receipt = loadMigrationReceipt(home);
	if (!receipt || receipt.intentSha !== intentSha || !receipt.sourceCarrier)
		throw Error("migration deployment receipt missing");
	const oldCarrier = receipt.sourceCarrier;
	const restartLockExists = () => {
		try {
			lstatSync(join(home, ".flywheel/restart.lock.d"));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	};
	const assertOutside = () => {
		if (restartLockExists()) throw Error("restart window is open");
	};
	const fence = () =>
		assertMigrationOutsideWindow({
			restartLockExists,
			bridgeUrl: process.env.BRIDGE_URL ?? "",
			token:
				process.env.FLYWHEEL_API_TOKEN ?? process.env.TEAMLEAD_API_TOKEN ?? "",
		});
	const verify = async () => {
		await fence();
		if (
			readRegular(join(home, ".flywheel/deployed-sha"), 128).trim() !==
			plan.deploymentSha
		)
			throw Error("migration deployment SHA mismatch");
		const raw = readMigrationRegistry(home),
			identities = resolveMigrationIdentities(home, raw, plan);
		const projects = parseAndValidateProjects(raw);
		if (!identities.channelIds.includes(evidence.channelId))
			throw Error("migration source channel outside subscriptions");
		const target = renderMigrationArtifacts(home, raw, plan);
		const assertTarget = () => {
			assertOutside();
			if (observeMigrationRegistry(home, plan).state !== "post")
				throw Error("migration target configuration unproven");
			for (const kind of ["manifest", "plist"] as const)
				if (
					observeMigrationArtifact(
						home,
						plan.expected,
						kind,
						target[kind],
						() => {
							throw Error("migration artifact missing");
						},
					).state !== "post"
				)
					throw Error("migration target artifact unproven");
		};
		assertTarget();
		const founderId = resolveFounderId({
			processEnv: process.env,
			dotenvPath: join(home, ".flywheel/.env"),
		});
		if (!founderId) throw Error("migration founder identity unavailable");
		const source = await verifyMigrationSource({
			channelId: evidence.channelId,
			messageId: evidence.messageId,
			founderId,
			botUserId: identities.botUserId,
			botToken: process.env[identities.botTokenEnv] ?? "",
		});
		if (Date.parse(source.at) <= Date.parse(plan.createdAt))
			throw Error("migration source predates intent");
		const runProof = verifyMigrationRunEvidence({
			path: process.env.TEAMLEAD_DB_PATH ?? join(home, ".flywheel/teamlead.db"),
			evidence,
			source,
			belongsToLead: (s) => matchesLead(s as Session, plan.leadId, projects),
		});
		const uid = process.getuid?.();
		if (uid === undefined) throw Error("host uid unavailable");
		const activationProof = await observeMigrationActivation({
			home,
			root,
			uid,
			identityDigest: identities.target.identityDigest,
			oldCarrier,
			assertWindow: assertTarget,
		});
		await fence();
		assertTarget();
		return createHash("sha256")
			.update(
				JSON.stringify({ intentSha, evidenceSha, runProof, activationProof }),
			)
			.digest("hex");
	};
	const result = await commitMigrationVerification(
		home,
		intentSha,
		evidenceSha,
		verify,
	);
	await fence();
	await retireCommittedMigrationIntent(home, intentSha);
	return result;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
	if (
		args.length !== 4 ||
		args[0] !== "--migration" ||
		args[1] !== "FLY-2459-honey-lemon" ||
		args[2] !== "--evidence" ||
		!args[3] ||
		!isAbsolute(args[3])
	)
		return 64;
	try {
		const receipt = await verifyBackendMigration(args[3]);
		process.stdout.write(JSON.stringify(receipt) + "\n");
		return 0;
	} catch {
		process.stderr.write(
			"migration verification incomplete; receipt retained for reconciliation\n",
		);
		return 78;
	}
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	void main().then((code) => {
		process.exitCode = code;
	});
