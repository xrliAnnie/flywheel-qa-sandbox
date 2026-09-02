#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;

function assertNonEmptyString(value, field, maxLength = 512) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value.trim() !== value
	) {
		throw new Error(`invalid ${field}`);
	}
	return value;
}

function assertModelArgument(value) {
	const model = assertNonEmptyString(value, "model", 256);
	const hasUnsafeCharacter = [...model].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
	});
	if (model.startsWith("-") || hasUnsafeCharacter) {
		throw new Error("invalid model");
	}
	return model;
}

function validateReceipt(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid authority receipt object");
	}
	const keys = Object.keys(value).sort();
	const expected = [
		"configRevision",
		"contextWindowTokens",
		"model",
		"resolvedAt",
		"schemaVersion",
	].sort();
	if (
		keys.length !== expected.length ||
		keys.some((key, i) => key !== expected[i])
	) {
		throw new Error("invalid authority receipt schema");
	}
	if (value.schemaVersion !== SCHEMA_VERSION) {
		throw new Error("unsupported authority receipt schema");
	}
	const model = assertModelArgument(value.model);
	const contextWindowTokens = value.contextWindowTokens;
	if (
		contextWindowTokens !== null &&
		(!Number.isSafeInteger(contextWindowTokens) ||
			contextWindowTokens <= 0 ||
			contextWindowTokens > MAX_CONTEXT_WINDOW_TOKENS)
	) {
		throw new Error("invalid contextWindowTokens");
	}
	const configRevision = assertNonEmptyString(
		value.configRevision,
		"configRevision",
	);
	const resolvedAt = assertNonEmptyString(value.resolvedAt, "resolvedAt", 64);
	const parsedTime = Date.parse(resolvedAt);
	if (!Number.isFinite(parsedTime) || !resolvedAt.endsWith("Z")) {
		throw new Error("invalid resolvedAt");
	}
	return Object.freeze({
		schemaVersion: SCHEMA_VERSION,
		model,
		contextWindowTokens,
		configRevision,
		resolvedAt,
	});
}

function assertSafeReceiptFile(stat) {
	if (!stat.isFile()) {
		throw new Error("authority receipt must be a regular file");
	}
	if ((stat.mode & 0o777) !== 0o600) {
		throw new Error("authority receipt must have mode 0600");
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error("authority receipt owner mismatch");
	}
}

export function readLeadModelAuthorityReceipt(file) {
	const target = resolve(assertNonEmptyString(file, "receipt path", 4096));
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const fd = openSync(target, constants.O_RDONLY | noFollow);
	let bytes;
	try {
		assertSafeReceiptFile(fstatSync(fd));
		bytes = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	if (Buffer.byteLength(bytes, "utf8") > 16_384) {
		throw new Error("authority receipt is too large");
	}
	let parsed;
	try {
		parsed = JSON.parse(bytes);
	} catch {
		throw new Error("authority receipt is not valid JSON");
	}
	return validateReceipt(parsed);
}

export function writeLeadModelAuthorityReceipt(file, decision) {
	const target = resolve(assertNonEmptyString(file, "receipt path", 4096));
	const directory = dirname(target);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const receipt = validateReceipt({
		schemaVersion: SCHEMA_VERSION,
		model: decision.model,
		contextWindowTokens: decision.contextWindowTokens ?? null,
		configRevision: decision.configRevision,
		resolvedAt: new Date().toISOString(),
	});
	const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
	let fd;
	try {
		fd = openSync(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, target);
		const directoryFd = openSync(directory, constants.O_RDONLY);
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
		return receipt;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
		throw error;
	}
}

function argumentValue(args, name) {
	const index = args.indexOf(name);
	if (index === -1 || index + 1 >= args.length) {
		throw new Error(`missing ${name}`);
	}
	return args[index + 1];
}

function parseContextWindow(value) {
	if (value === "null") return null;
	if (!/^[1-9][0-9]*$/.test(value)) {
		throw new Error("invalid --context-window");
	}
	return Number(value);
}

function runCli(args) {
	const [command, ...rest] = args;
	const file = argumentValue(rest, "--file");
	let receipt;
	if (command === "read") {
		receipt = readLeadModelAuthorityReceipt(file);
	} else if (command === "write") {
		receipt = writeLeadModelAuthorityReceipt(file, {
			model: argumentValue(rest, "--model"),
			contextWindowTokens: parseContextWindow(
				argumentValue(rest, "--context-window"),
			),
			configRevision: argumentValue(rest, "--revision"),
		});
	} else {
		throw new Error(
			"usage: lead-model-authority-receipt.mjs read|write --file PATH",
		);
	}
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

let isMain = false;
try {
	isMain =
		Boolean(process.argv[1]) &&
		realpathSync(resolve(process.argv[1])) ===
			realpathSync(fileURLToPath(import.meta.url));
} catch {
	isMain = false;
}

if (isMain) {
	try {
		runCli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(
			`lead model authority receipt: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
