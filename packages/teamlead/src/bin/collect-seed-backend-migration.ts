import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	loadMigrationOperator,
	loadOrCollectMigrationOperator,
} from "flywheel-comm/lead-backend-migration-operator";
import {
	collectMigrationCutoffs,
	type MigrationObservation,
} from "flywheel-comm/lead-backend-migration-runtime";
import { MailboxQueue, type MailboxRow } from "flywheel-comm/mailbox-queue";
import { seedBackendMigration } from "./seed-backend-migration.js";

/** Actual fixed-target seed action. stateDir comes from the existing launcher
 * resolver, never from the intent. No processing journal or mailbox ACK is invented.
 */
export async function collectAndSeedBackendMigration(input: {
	home: string;
	stateDir: string;
	intentSha: string;
	botToken: string;
	botUserId: string;
	channelIds: string[];
	assertWindowAndStopped(): void;
}) {
	input.assertWindowAndStopped();
	if (!isAbsolute(input.home) || !isAbsolute(input.stateDir))
		throw Error("invalid migration seed path");
	const dbPath = join(input.home, ".flywheel/comm/flywheel/comm.db");
	const dbStat = lstatSync(dbPath);
	if (!dbStat.isFile() || dbStat.isSymbolicLink())
		throw Error("migration CommDB unavailable");
	const artifact = await loadOrCollectMigrationOperator({
		home: input.home,
		intentSha: input.intentSha,
		botUserId: input.botUserId,
		channelIds: input.channelIds,
		collect: () =>
			collectMigrationCutoffs({
				botToken: input.botToken,
				botUserId: input.botUserId,
				channelIds: input.channelIds,
				assertStopped: input.assertWindowAndStopped,
			}),
	});
	input.assertWindowAndStopped();
	let ancestor = resolve(input.stateDir);
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	if (realpathSync(ancestor) !== ancestor)
		throw Error("migration cursor directory traverses a symlink");
	mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
	if (
		realpathSync(input.stateDir) !== resolve(input.stateDir) ||
		!lstatSync(input.stateDir).isDirectory()
	)
		throw Error("invalid migration cursor directory");
	input.assertWindowAndStopped();
	const queue = new MailboxQueue(dbPath);
	try {
		return seedBackendMigration({
			path: join(input.stateDir, "inbound-cursor.json"),
			expectedBeforeSha256: null,
			artifact,
			identity: { botUserId: input.botUserId, channelIds: input.channelIds },
			queue,
			assertWindowAndStopped: input.assertWindowAndStopped,
		});
	} finally {
		queue.close();
	}
}

/** Read-only observation also used after the new owner has started. Never calls
 * the seeder or enqueuer, and never claims a writer-stopped condition. */
export function observeBackendMigrationSeed(input: {
	home: string;
	stateDir: string;
	intentSha: string;
	botUserId: string;
	channelIds: string[];
}): MigrationObservation {
	const hash = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	const result = (
		state: MigrationObservation["state"],
		value: string,
	): MigrationObservation => ({ state, proofSha: hash(value) });
	if (!isAbsolute(input.home) || !isAbsolute(input.stateDir))
		throw Error("invalid migration seed observation path");
	const artifact = loadMigrationOperator(input);
	if (!artifact) return result("pre", `operator-missing:${input.intentSha}`);
	const artifactSha = hash(JSON.stringify(artifact));
	const path = join(input.stateDir, "inbound-cursor.json");
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return result("pre", artifactSha);
		throw error;
	}
	let bytes: string;
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > 1024 * 1024
		)
			throw Error("unsafe migration cursor observation");
		bytes = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	const map: unknown = JSON.parse(bytes);
	if (!map || typeof map !== "object" || Array.isArray(map))
		return result("conflict", bytes);
	const current = map as Record<string, unknown>;
	if (Object.keys(current).length !== artifact.cutoffs.channels.length)
		return result("conflict", bytes);
	for (const channel of artifact.cutoffs.channels) {
		const value = current[channel.channelId];
		if (
			typeof value !== "string" ||
			!/^(0|\d{17,20})$/.test(value) ||
			BigInt(value) < BigInt(channel.cutoffId ?? "0")
		)
			return result("conflict", bytes);
	}
	const dbPath = join(input.home, ".flywheel/comm/flywheel/comm.db");
	if (lstatSync(dbPath).isSymbolicLink())
		throw Error("unsafe migration CommDB observation");
	const queue = new MailboxQueue(dbPath, { readOnly: true });
	try {
		const ids: string[] = [];
		for (const channel of artifact.cutoffs.channels) {
			if (
				!channel.unresolvedMessageIds.length &&
				channel.unresolvedBefore === null
			)
				continue;
			const id = `migration:FLY-2459:${input.intentSha}:${channel.channelId}`;
			const matches = (row: Partial<MailboxRow>) =>
				row.id === id &&
				row.to_agent === "flywheel-product-lead" &&
				row.from_agent === "flywheel-backend-migration" &&
				row.source_ref === artifactSha;
			const row = queue.getById(id);
			if (row) {
				if (!matches(row) || row.state === "DEAD")
					return result("conflict", id);
			} else if (
				!queue.getArchivedFamilySnapshots(id).some((json) => {
					const archived = JSON.parse(json) as Partial<MailboxRow>;
					return matches(archived) && archived.state === "ACKED";
				})
			)
				return result("pre", id);
			ids.push(id);
		}
		return result(
			"post",
			JSON.stringify({ artifactSha, cursorSha: hash(bytes), ids }),
		);
	} finally {
		queue.close();
	}
}
