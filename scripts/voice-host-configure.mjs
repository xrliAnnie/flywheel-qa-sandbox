#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Only the parent-generated stdin module declares this lexical capability.
// No --internal command, exported mutation function, or lock-held env flag exists.
const lockedRequest =
	typeof voiceLockedRequest === "undefined" ? undefined : voiceLockedRequest;
const script = lockedRequest?.script ?? fileURLToPath(import.meta.url);
const repo = dirname(dirname(script));
const state = join(homedir(), ".flywheel");
const paths = {
	projects: join(state, "projects.json"),
	host: join(state, "voice-host.json"),
	summary: join(state, "state/summary-registry/migration-receipt.json"),
};
const voices = new Set([
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"sage",
	"shimmer",
	"verse",
	"marin",
	"cedar",
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function present(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
function read(path, optional = false, privateFile = false) {
	if (optional && !present(path))
		return {
			bytes: Buffer.alloc(0),
			meta: { exists: false, mode: null, sha256: null },
		};
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const st = fstatSync(fd);
		if (
			!st.isFile() ||
			st.uid !== process.getuid() ||
			st.size > 16 * 1024 * 1024 ||
			(privateFile && (st.mode & 0o777) !== 0o600)
		)
			throw Error("unsafe_file");
		const bytes = readFileSync(fd);
		return {
			bytes,
			meta: { exists: true, mode: st.mode & 0o777, sha256: hash(bytes) },
		};
	} finally {
		closeSync(fd);
	}
}
function same(a, b) {
	return a.exists === b.exists && a.mode === b.mode && a.sha256 === b.sha256;
}
function syncDirectory(path) {
	const fd = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function atomic(path, bytes, mode = 0o600) {
	const temporary = join(dirname(path), `.voice-config-${randomUUID()}.tmp`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		mode,
	);
	try {
		fchmodSync(fd, mode);
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temporary, path);
		syncDirectory(dirname(path));
	} finally {
		if (present(temporary)) unlinkSync(temporary);
	}
}
function privateDir(path) {
	const st = lstatSync(path);
	if (
		!st.isDirectory() ||
		st.isSymbolicLink() ||
		st.uid !== process.getuid() ||
		(st.mode & 0o777) !== 0o700
	)
		throw Error("unsafe_receipt_directory");
}
function noIntent() {
	if (present(`${paths.summary}.lead-registry-intent.json`))
		throw Error("registry_recovery_pending");
}
function runNode(args) {
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 15000,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			HOME: homedir(),
			PATH: process.env.PATH,
			FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR: join(
				repo,
				"packages/teamlead/dist/bin/validate-projects.js",
			),
		},
	});
	if (result.status !== 0) throw Error("configuration_validation_failed");
}
function verify(projects) {
	runNode([
		join(repo, "packages/teamlead/dist/bin/validate-projects.js"),
		projects,
	]);
	runNode([
		join(repo, "packages/flywheel-comm/dist/bin/summary-registry.js"),
		"verify-activation",
		"--projects-file",
		projects,
		"--receipt-file",
		paths.summary,
	]);
}
async function validateHost(path, projects) {
	const { loadVoiceHostConfig } = await import(
		pathToFileURL(join(repo, "packages/teamlead/dist/voice-host-config.js"))
			.href
	);
	loadVoiceHostConfig({ path, projects, homeDir: homedir() });
}
function projectCandidate(bytes) {
	const projects = JSON.parse(bytes);
	if (!Array.isArray(projects) || projects.length === 0)
		throw Error("invalid_projects");
	for (const project of projects) {
		if (
			!project ||
			typeof project !== "object" ||
			project.huddle != null ||
			!Array.isArray(project.leads)
		)
			throw Error("legacy_or_invalid_projects");
		project.voiceRoom = {
			guildId: "1485787271192907816",
			voiceChannelId: "1485787273193853170",
		};
		for (const lead of project.leads) {
			if (!lead || typeof lead.agentId !== "string")
				throw Error("invalid_lead");
			if (lead.realtimeVoice !== undefined && !voices.has(lead.realtimeVoice))
				throw Error("invalid_realtime_voice");
			lead.voiceModes = {
				meeting: true,
				rg: project.projectName === "raya" && lead.agentId === "raya",
			};
			lead.realtimeVoice ??= "marin";
		}
	}
	return encode(projects);
}
function snapshot() {
	return Object.fromEntries(
		Object.entries(paths).map(([name, path]) => [
			name,
			read(path, name === "host", name === "host"),
		]),
	);
}
function checkSummary(receipt) {
	noIntent();
	if (!same(read(paths.summary).meta, receipt.before.summary))
		throw Error("summary_receipt_conflict");
}
function checkpoint(out, receipt, status, step) {
	receipt.status = status;
	receipt.step = step;
	atomic(join(out, "receipt.json"), encode(receipt));
}
async function prepare(out) {
	if (present(out)) throw Error("receipt_directory_exists");
	const rel = relative(
		realpathSync(repo),
		join(realpathSync(dirname(out)), basename(out)),
	);
	if (!rel.startsWith("..") && !isAbsolute(rel))
		throw Error("backup_inside_repository");
	noIntent();
	const before = snapshot();
	verify(paths.projects);
	const afterProjects = projectCandidate(before.projects.bytes);
	mkdirSync(out, { mode: 0o700 });
	privateDir(out);
	for (const name of ["projects", "host", "summary"])
		atomic(join(out, `${name}.before.json`), before[name].bytes);
	atomic(join(out, "projects.after.json"), afterProjects);
	const afterHost = before.host.meta.exists
		? before.host.bytes
		: encode({ schemaVersion: 1 });
	atomic(join(out, "host.after.json"), afterHost);
	await validateHost(join(out, "host.after.json"), JSON.parse(afterProjects));
	verify(join(out, "projects.after.json"));
	const receipt = {
		schemaVersion: 1,
		id: randomUUID(),
		before: Object.fromEntries(
			Object.entries(before).map(([key, value]) => [key, value.meta]),
		),
		after: {
			projects: {
				exists: true,
				mode: before.projects.meta.mode,
				sha256: hash(afterProjects),
			},
			host: { exists: true, mode: 0o600, sha256: hash(afterHost) },
		},
	};
	checkSummary(receipt);
	checkpoint(out, receipt, "prepared", "ready");
	return receipt;
}
function loadReceipt(out) {
	privateDir(out);
	const receipt = JSON.parse(
		read(join(out, "receipt.json"), false, true).bytes,
	);
	if (
		receipt.schemaVersion !== 1 ||
		typeof receipt.id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			receipt.id,
		) ||
		![
			"prepared",
			"applying",
			"applied",
			"restoring",
			"restored",
			"rollback_failed",
		].includes(receipt.status)
	)
		throw Error("invalid_receipt");
	const images = {};
	for (const name of ["projects", "host", "summary"]) {
		const before = read(join(out, `${name}.before.json`), false, true).bytes;
		const meta = receipt.before?.[name];
		if (
			!meta ||
			typeof meta.exists !== "boolean" ||
			(meta.exists
				? hash(before) !== meta.sha256 ||
					!Number.isInteger(meta.mode) ||
					meta.mode < 0 ||
					meta.mode > 0o777
				: before.length !== 0 || meta.sha256 !== null || meta.mode !== null)
		)
			throw Error("backup_conflict");
		images[name] = { before };
	}
	for (const name of ["projects", "host"]) {
		const after = read(join(out, `${name}.after.json`), false, true).bytes;
		if (
			hash(after) !== receipt.after?.[name]?.sha256 ||
			receipt.after[name].exists !== true
		)
			throw Error("candidate_conflict");
		images[name].after = after;
	}
	if (
		!images.projects.after.equals(projectCandidate(images.projects.before)) ||
		receipt.after.projects.mode !== receipt.before.projects.mode
	)
		throw Error("candidate_scope_conflict");
	const expectedHost = receipt.before.host.exists
		? images.host.before
		: encode({ schemaVersion: 1 });
	if (
		!images.host.after.equals(expectedHost) ||
		receipt.after.host.mode !== 0o600
	)
		throw Error("candidate_scope_conflict");
	return { receipt, images };
}
function admit(receipt, allowMixed) {
	checkSummary(receipt);
	for (const name of ["projects", "host"]) {
		const current = read(paths[name], name === "host", name === "host").meta;
		if (
			!same(current, receipt.before[name]) &&
			!(allowMixed && same(current, receipt.after[name]))
		)
			throw Error("config_write_conflict");
	}
}
function publish(out, receipt, images, direction, status) {
	for (const name of ["projects", "host"]) {
		checkSummary(receipt);
		const current = read(paths[name], name === "host", name === "host").meta;
		if (
			!same(current, receipt.before[name]) &&
			!same(current, receipt.after[name])
		)
			throw Error("config_write_conflict");
		const wanted = receipt[direction][name];
		checkpoint(out, receipt, status, `before_${name}`);
		if (!same(current, wanted)) {
			if (wanted.exists)
				atomic(paths[name], images[name][direction], wanted.mode);
			else {
				unlinkSync(paths[name]);
				syncDirectory(dirname(paths[name]));
			}
		}
		checkpoint(out, receipt, status, `after_${name}`);
	}
}
function verifyImages(receipt, direction) {
	for (const name of ["projects", "host"]) {
		if (
			!same(
				read(paths[name], name === "host", name === "host").meta,
				receipt[direction][name],
			)
		)
			throw Error("config_write_conflict");
	}
}
async function change(out, action) {
	const { receipt, images } = loadReceipt(out);
	const allowMixed =
		action === "restore" ||
		["applying", "applied", "restoring", "rollback_failed"].includes(
			receipt.status,
		);
	admit(receipt, allowMixed);
	await validateHost(
		join(out, "host.after.json"),
		JSON.parse(images.projects.after),
	);
	verify(
		action === "apply"
			? join(out, "projects.after.json")
			: join(out, "projects.before.json"),
	);
	const direction = action === "apply" ? "after" : "before",
		status = action === "apply" ? "applying" : "restoring";
	try {
		checkpoint(out, receipt, status, "begin");
		publish(out, receipt, images, direction, status);
		checkSummary(receipt);
		verify(paths.projects);
		verifyImages(receipt, direction);
		checkpoint(
			out,
			receipt,
			action === "apply" ? "applied" : "restored",
			"complete",
		);
	} catch {
		try {
			// Restore only known before/after images; never overwrite a third-party edit.
			admit(receipt, true);
			publish(out, receipt, images, "before", "restoring");
			checkSummary(receipt);
			verify(paths.projects);
			verifyImages(receipt, "before");
			checkpoint(out, receipt, "restored", "rolled_back");
		} catch {
			checkpoint(
				out,
				receipt,
				"rollback_failed",
				"conflict_or_verification_failed",
			);
		}
		throw Error("transaction_failed");
	}
	return receipt;
}
async function main() {
	if (lockedRequest) {
		const { action, out } = lockedRequest;
		const receipt =
			action === "prepare" ? await prepare(out) : await change(out, action);
		console.log(
			JSON.stringify({
				id: receipt.id,
				status: receipt.status,
				receiptPath: join(out, "receipt.json"),
				scope: {
					guildId: "1485787271192907816",
					voiceChannelId: "1485787273193853170",
					meeting: "all-current-leads",
					rg: "raya/raya",
				},
				hash: {
					before: Object.fromEntries(
						Object.entries(receipt.before).map(([name, meta]) => [
							name,
							meta.sha256,
						]),
					),
					after: Object.fromEntries(
						Object.entries(receipt.after).map(([name, meta]) => [
							name,
							meta.sha256,
						]),
					),
				},
			}),
		);
		return;
	}
	const [action, flag, value, ...extra] = process.argv.slice(2);
	if (
		!["prepare", "apply", "restore"].includes(action) ||
		flag !== (action === "prepare" ? "--out" : "--receipt") ||
		!value ||
		extra.length
	)
		throw Error("usage");
	const out = action === "prepare" ? resolve(value) : dirname(resolve(value));
	if (action !== "prepare" && resolve(value) !== join(out, "receipt.json"))
		throw Error("invalid_receipt_path");
	if (
		present(`${paths.projects}.cfglock`) &&
		lstatSync(`${paths.projects}.cfglock`).isSymbolicLink()
	)
		throw Error("unsafe_lock");
	const request = { action, out, script };
	const input = `const voiceLockedRequest=${JSON.stringify(request)};\n${readFileSync(script, "utf8").replace(/^#![^\n]*\n/, "")}`;
	const env = {
		...process.env,
		FLYWHEEL_CONFIG_LOCK_PY: join(repo, "scripts/flywheel-config-lock.py"),
	};
	const result = spawnSync(
		"bash",
		[
			"-c",
			'source "$1"; config_write_locked "$2" 10 "$3" --input-type=module',
			"voice-config-lock",
			join(repo, "scripts/flywheel-config-lock.sh"),
			`${paths.projects}.cfglock`,
			process.execPath,
		],
		{ input, encoding: "utf8", env, maxBuffer: 1024 * 1024, timeout: 120000 },
	);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.status !== 0) throw Error("locked_transaction_failed");
}
main().catch(() => {
	console.error(
		"voice-host-configure: operation refused or transaction failed; inspect the private receipt",
	);
	process.exitCode = 1;
});
