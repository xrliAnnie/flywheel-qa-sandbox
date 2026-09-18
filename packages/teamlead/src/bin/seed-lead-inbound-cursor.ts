#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { FileInboundCursorStore } from "../lead-backends/codex/InboundCursorStore.js";

const SNOWFLAKE = /^\d{17,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface CursorSeed {
	schemaVersion: 1;
	migrationId: string;
	expectedBeforeSha256: string | null;
	writerStopped: boolean;
	unresolved: string[];
	channels: Array<{ channelId: string; lastConfirmedMessageId: string }>;
	/** Explicit REST-confirmed empty channels resume with after=0, never baseline to latest. */
	emptyChannels?: string[];
}

export type CursorSeedResult = {
	status: "seeded" | "already_seeded" | "already_advanced";
	migrationId: string;
	sha256: string;
	channels: number;
};

export type PreexistingCursorResult = {
	status: "preexisting";
	migrationId: string;
	sha256: string;
	seedSha256: string;
	channels: number;
};

function sha256(bytes: string): string {
	return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function canonicalMap(
	seed: CursorSeed,
	writerStopped = true,
): Record<string, string> {
	if (seed.schemaVersion !== 1 || !seed.migrationId.trim()) {
		throw new Error("cursor seed migration identity is invalid");
	}
	if (
		seed.expectedBeforeSha256 !== null &&
		!SHA256.test(seed.expectedBeforeSha256)
	) {
		throw new Error("cursor seed before digest is invalid");
	}
	if (seed.writerStopped !== writerStopped)
		throw new Error("cursor seed writer state is invalid");
	if (!Array.isArray(seed.unresolved) || seed.unresolved.length !== 0) {
		throw new Error("cursor seed has unresolved side effects");
	}
	const emptyChannels = seed.emptyChannels ?? [];
	if (
		!Array.isArray(emptyChannels) ||
		emptyChannels.some((id) => typeof id !== "string" || !SNOWFLAKE.test(id))
	)
		throw new Error("invalid empty seed channel");
	if (
		!Array.isArray(seed.channels) ||
		seed.channels.length + emptyChannels.length === 0
	) {
		throw new Error("cursor seed channels are missing");
	}
	const entries = seed.channels.map(({ channelId, lastConfirmedMessageId }) => {
		if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(lastConfirmedMessageId)) {
			throw new Error("cursor seed channel or message is not a snowflake");
		}
		return [channelId, lastConfirmedMessageId] as const;
	});
	entries.push(...emptyChannels.map((id) => [id, "0"] as const));
	entries.sort(([left], [right]) =>
		BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
	);
	if (
		new Set(entries.map(([channelId]) => channelId)).size !== entries.length
	) {
		throw new Error("cursor seed channel is duplicated");
	}
	return Object.fromEntries(entries);
}

function readCursorFile(path: string): {
	bytes: string;
	map: Record<string, string>;
} {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink())
		throw new Error("cursor target must not be a symlink");
	if (!stat.isFile()) throw new Error("cursor target must be a regular file");
	if ((stat.mode & 0o077) !== 0)
		throw new Error("cursor target must be owner-only");
	const bytes = readFileSync(path, "utf8");
	const value: unknown = JSON.parse(bytes);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("existing cursor is invalid");
	}
	const map = value as Record<string, unknown>;
	if (
		Object.entries(map).some(
			([channelId, messageId]) =>
				!SNOWFLAKE.test(channelId) ||
				typeof messageId !== "string" ||
				(messageId !== "0" && !SNOWFLAKE.test(messageId)),
		)
	) {
		throw new Error("existing cursor is invalid");
	}
	return { bytes, map: map as Record<string, string> };
}

export function readLeadInboundCursor(path: string): Record<string, string> {
	return readCursorFile(path).map;
}

function relation(
	current: Record<string, string>,
	seeded: Record<string, string>,
	exactKeys = true,
): "equal" | "advanced" | "conflict" {
	const currentKeys = Object.keys(current).sort();
	const seedKeys = Object.keys(seeded).sort();
	if (exactKeys && JSON.stringify(currentKeys) !== JSON.stringify(seedKeys))
		return "conflict";
	let advanced = false;
	for (const key of seedKeys) {
		const currentValue = current[key];
		const seedValue = seeded[key];
		if (
			!currentValue ||
			!seedValue ||
			BigInt(currentValue) < BigInt(seedValue)
		) {
			return "conflict";
		}
		if (BigInt(currentValue) > BigInt(seedValue)) advanced = true;
	}
	return advanced ? "advanced" : "equal";
}

export function seedLeadInboundCursor(input: {
	path: string;
	seed: CursorSeed;
}): CursorSeedResult {
	if (!isAbsolute(input.path))
		throw new Error("cursor target must be absolute");
	const parent = dirname(input.path);
	if (lstatSync(parent).isSymbolicLink()) {
		throw new Error("cursor target parent must not traverse a symlink");
	}
	const map = canonicalMap(input.seed);
	const bytes = `${JSON.stringify(map)}\n`;
	const digest = sha256(bytes);
	if (existsSync(input.path)) {
		const { bytes: currentBytes, map: current } = readCursorFile(input.path);
		const state = relation(current, map);
		if (state === "equal") {
			return {
				status: "already_seeded",
				migrationId: input.seed.migrationId,
				sha256: sha256(currentBytes),
				channels: Object.keys(map).length,
			};
		}
		if (state === "advanced") {
			return {
				status: "already_advanced",
				migrationId: input.seed.migrationId,
				sha256: sha256(currentBytes),
				channels: Object.keys(map).length,
			};
		}
		throw new Error("existing cursor conflicts with the migration seed");
	}
	if (input.seed.expectedBeforeSha256 !== null) {
		throw new Error(
			"cursor before digest expected a file, but the target is missing",
		);
	}
	const temporary = `${input.path}.seed-${process.pid}-${randomUUID()}`;
	let file: number | undefined;
	try {
		file = openSync(temporary, "wx", 0o600);
		writeFileSync(file, bytes, "utf8");
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		renameSync(temporary, input.path);
		chmodSync(input.path, 0o600);
		const directory = openSync(parent, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch (error) {
		if (file !== undefined) closeSync(file);
		if (existsSync(temporary)) unlinkSync(temporary);
		throw error;
	}
	const store = new FileInboundCursorStore(input.path);
	for (const [channelId, messageId] of Object.entries(map)) {
		if (store.load(channelId) !== messageId) {
			throw new Error("cursor seed read-back verification failed");
		}
	}
	return {
		status: "seeded",
		migrationId: input.seed.migrationId,
		sha256: digest,
		channels: Object.keys(map).length,
	};
}

export function verifyPreexistingLeadInboundCursor(input: {
	path: string;
	seed: CursorSeed;
}): PreexistingCursorResult {
	if (!isAbsolute(input.path))
		throw new Error("cursor target must be absolute");
	const map = canonicalMap(input.seed, false);
	const { bytes, map: current } = readCursorFile(input.path);
	if (relation(current, map, false) === "conflict")
		throw new Error("existing cursor conflicts with the migration seed");
	return {
		status: "preexisting",
		migrationId: input.seed.migrationId,
		sha256: sha256(bytes),
		seedSha256: sha256(`${JSON.stringify(map)}\n`),
		channels: Object.keys(map).length,
	};
}

function inputFile(path: string): CursorSeed {
	if (!isAbsolute(path)) throw new Error("cursor seed input must be absolute");
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error("cursor seed input must be a regular non-symlink file");
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new Error("cursor seed input must be owner-only");
	}
	return JSON.parse(readFileSync(path, "utf8")) as CursorSeed;
}

function flag(argv: readonly string[], name: string): string {
	const index = argv.indexOf(name);
	if (index < 0 || !argv[index + 1] || argv.indexOf(name, index + 1) >= 0) {
		throw new Error(`missing or duplicate ${name}`);
	}
	return argv[index + 1] as string;
}

export function main(argv = process.argv.slice(2)): number {
	const input = {
		path: flag(argv, "--path"),
		seed: inputFile(flag(argv, "--input")),
	};
	const preexisting = argv.filter((arg) => arg === "--preexisting").length;
	if (preexisting > 1) throw new Error("duplicate --preexisting");
	const result = preexisting
		? verifyPreexistingLeadInboundCursor(input)
		: seedLeadInboundCursor(input);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return 0;
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
	try {
		process.exitCode = main();
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
