#!/usr/bin/env node
// FLY-2204: bounded, redacted OAuth scope/revocation probes.
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

function fail(message, code = 64) {
	process.stderr.write(`calendar OAuth probe: ${message}\n`);
	process.exit(code);
}

const [probe, ...rawArgs] = process.argv.slice(2);
const probes = new Set(["gog-scope", "gws-scope", "gog-revoked"]);
if (!probes.has(probe)) {
	fail(
		"usage: calendar-oauth-probe.mjs gog-scope|gws-scope|gog-revoked [options]",
	);
}

const allowed = new Set([
	"--executable",
	"--account",
	"--client",
	"--calendar-id",
	"--from",
	"--to",
	"--ack",
]);
const options = new Map();
for (let index = 0; index < rawArgs.length; index += 2) {
	const key = rawArgs[index];
	const value = rawArgs[index + 1];
	if (!allowed.has(key) || value === undefined || options.has(key)) {
		fail("options must be unique reviewed key/value pairs");
	}
	options.set(key, value);
}

function required(key) {
	const value = options.get(key);
	if (!value) fail(`${key} is required`);
	return value;
}

const expectedAck =
	probe === "gog-revoked" ? "FLY-2204-REVOKED-GRANT" : "FLY-2204-LIVE-CANARY";
if (required("--ack") !== expectedAck) {
	fail(`literal acknowledgement ${expectedAck} is required`);
}

const executable = required("--executable");
if (!isAbsolute(executable)) fail("--executable must be absolute");
try {
	const stat = lstatSync(executable);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
	accessSync(executable, constants.X_OK);
} catch {
	fail("--executable must be an executable regular file");
}

function selector(key, pattern, label) {
	const value = required(key);
	if (value.length > 255 || !pattern.test(value)) fail(`${label} is invalid`);
	return value;
}

const account = selector(
	"--account",
	/^[A-Za-z0-9][A-Za-z0-9@._+-]*$/u,
	"account",
);
const client = selector("--client", /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "client");
const calendarId = selector(
	"--calendar-id",
	/^[A-Za-z0-9][A-Za-z0-9@._-]*$/u,
	"calendar id",
);
if (calendarId === "primary") fail("calendar id must never be primary");

function canonicalTime(key) {
	const value = required(key);
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		fail(`${key} must be canonical RFC3339 UTC`);
	}
	return value;
}

const from = canonicalTime("--from");
const to = canonicalTime("--to");
const duration = Date.parse(to) - Date.parse(from);
if (duration < 60_000 || duration > 10 * 60_000) {
	fail("probe window must be between one and ten minutes");
}

const summary = "FLY-2204 OAuth scope canary";
const gwsParams = JSON.stringify({ calendarId });
const gwsBody = JSON.stringify({
	summary,
	start: { dateTime: from },
	end: { dateTime: to },
	extendedProperties: { private: { flywheelProbe: "FLY-2204" } },
});

function run(args) {
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 256 * 1024,
	});
	if (result.error) fail("probe executable failed to run", 70);
	return {
		status: typeof result.status === "number" ? result.status : 70,
		text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(0, 256 * 1024),
	};
}

function gogCreateArgs(dryRun) {
	return [
		"--account",
		account,
		"--client",
		client,
		"--json",
		...(dryRun ? ["--dry-run"] : []),
		"calendar",
		"create",
		calendarId,
		"--summary",
		summary,
		"--from",
		from,
		"--to",
		to,
		"--no-input",
	];
}

function gwsCreateArgs(dryRun) {
	return [
		...(dryRun ? ["--dry-run"] : []),
		"calendar",
		"events",
		"insert",
		"--params",
		gwsParams,
		"--json",
		gwsBody,
	];
}

function emit(result, grammar, status) {
	process.stdout.write(
		`${JSON.stringify({
			schemaVersion: 1,
			probe,
			grammar,
			result,
			exitCode: status,
		})}\n`,
	);
}

if (probe === "gog-revoked") {
	const result = run([
		"--account",
		account,
		"--client",
		client,
		"--json",
		"calendar",
		"events",
		calendarId,
		"--from",
		from,
		"--to",
		to,
		"--all-pages",
	]);
	if (
		result.status !== 0 &&
		/(?:invalid_grant|invalid credentials|\b401\b)/iu.test(result.text)
	) {
		emit("old_grant_revoked", "not_applicable", result.status);
		process.exit(0);
	}
	emit(
		result.status === 0 ? "old_grant_still_valid" : "unexpected_denial",
		"not_applicable",
		result.status,
	);
	process.exit(1);
}

const args = probe === "gog-scope" ? gogCreateArgs : gwsCreateArgs;
const grammar = run(args(true));
if (grammar.status !== 0) {
	emit("grammar_failed", "failed", grammar.status);
	process.exit(1);
}
const live = run(args(false));
if (live.status === 0) {
	emit("unexpected_write_success", "passed", live.status);
	process.exit(2);
}
if (
	/(?:ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions|insufficient_scope)/iu.test(
		live.text,
	)
) {
	emit("insufficient_scope", "passed", live.status);
	process.exit(0);
}
emit("unexpected_denial", "passed", live.status);
process.exit(1);
