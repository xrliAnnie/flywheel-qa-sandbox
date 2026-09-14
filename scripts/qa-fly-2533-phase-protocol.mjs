#!/usr/bin/env node
// FLY-2533: slot-only real runner evidence. This driver never submits a claim.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneralizedStartResponse } from "./lib/qa-generalized-e2e-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOW = 600_000;
const POLL = 30_000;
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
function requireThat(ok, message) {
	if (!ok) throw new Error(message);
}
function inside(path, root) {
	return (
		typeof path === "string" &&
		path.startsWith(`${root}/`) &&
		!path.split("/").includes("..")
	);
}
function slotPath(path, root) {
	requireThat(inside(path, root), `path must be beneath ${root}`);
	let existing = path;
	while (!existsSync(existing)) existing = dirname(existing);
	requireThat(
		realpathSync(existing) === realpathSync(root) ||
			inside(realpathSync(existing), realpathSync(root)),
		"slot path symlink escapes isolation",
	);
	return path;
}
function command(file, args, extra = {}) {
	return execFileSync(file, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...extra,
	}).trim();
}
function write(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export function validateDeployment(room, slot) {
	requireThat(
		Number.isInteger(room.slot) && room.slot > 0 && room.mode === "slot",
		"ordinary slot deployment required",
	);
	const base = `/tmp/flywheel-test-slot-${room.slot}`;
	requireThat(
		room.slotDir === base && room.projectName === `test-slot-${room.slot}`,
		"production project or invalid slot directory",
	);
	requireThat(
		room.generalized !== true && room.runnerMode !== "stub" && !room.noLead,
		"ordinary real-runner deploy required; do not use --generalized or --stub-runner",
	);
	const url = new URL(room.bridgeUrl);
	requireThat(
		url.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
			Number(url.port) === slot.bridgePort &&
			url.pathname === "/" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash,
		"Bridge must use loopback and exact slot port",
	);
	requireThat(
		room.port === slot.bridgePort &&
			room.agentId === slot.botName &&
			room.chatChannelId === slot.channelId &&
			room.botTokenEnv === slot.tokenEnvVar,
		"slot registry Lead/channel/port mismatch",
	);
	requireThat(
		room.leadCarrier === "launchd-v2",
		"Claude launchd topology required",
	);
	for (const key of [
		"hostRepo",
		"dbPath",
		"leadSocket",
		"flywheelProjectsFile",
		"bridgeLaunchSpec",
		"launchdRegistry",
	])
		requireThat(inside(room[key], base), `${key} must be slot-local`);
	return room;
}
export function classifyClaim(claim, activation) {
	if (
		!claim ||
		claim.family !== "qa_verdict" ||
		!claim.claim_id ||
		!claim.server_seq ||
		!claim.consumed_at ||
		claim.issuer_vendor !== "claude" ||
		!claim.subject_digest
	)
		return null;
	for (const field of [
		"run_id",
		"node_id",
		"attempt",
		"activation_id",
		"execution_id",
	])
		if (claim[field] !== activation[field]) return null;
	if (claim.issuer_execution_id !== activation.execution_id) return null;
	return claim.predicate === "qa_passed"
		? "PASS"
		: claim.predicate === "qa_failed"
			? "FAIL"
			: null;
}
export function compareArms(baseline, candidate) {
	requireThat(
		baseline.arm === "baseline" &&
			candidate.arm === "candidate" &&
			baseline.runId !== candidate.runId,
		"independent paired arms required",
	);
	for (const key of [
		"fixtureDigest",
		"model",
		"effort",
		"initialHead",
		"windowMs",
		"issueId",
	])
		requireThat(
			baseline[key] === candidate[key] && baseline[key] != null,
			`paired ${key} mismatch`,
		);
	requireThat(
		JSON.stringify(baseline.template) === JSON.stringify(candidate.template),
		"paired template mismatch",
	);
	requireThat(candidate.windowMs === WINDOW, "full ten-minute window required");
	return {
		criterionB:
			candidate.outcome !== "PASS"
				? "FAIL_CANDIDATE_NO_ACCEPTED_PASS"
				: baseline.outcome !== "NO_CLAIM_IN_WINDOW"
					? "UNPROVEN_BASELINE_ALSO_CLAIMED"
					: "PASS",
		baseline,
		candidate,
	};
}
async function context(config) {
	const room = read(config.deployJson);
	const slots = read(join(homedir(), ".flywheel/test-slots.json"));
	validateDeployment(room, slots.slots[room.slot - 1]);
	const base = room.slotDir;
	for (const key of [
		"hostRepo",
		"dbPath",
		"leadSocket",
		"flywheelProjectsFile",
		"bridgeLaunchSpec",
		"launchdRegistry",
	])
		slotPath(room[key], base);
	requireThat(
		inside(realpathSync(config.codeRepo), "/tmp") ||
			inside(realpathSync(config.codeRepo), "/private/tmp"),
		"isolated /tmp code checkout required",
	);
	requireThat(/^[0-9a-f]{40}$/.test(config.expectedSha), "pin full code SHA");
	requireThat(
		command("git", ["-C", config.codeRepo, "rev-parse", "HEAD"]) ===
			config.expectedSha,
		"code checkout HEAD drift",
	);
	requireThat(
		["baseline", "candidate"].includes(config.arm),
		"arm must be baseline or candidate",
	);
	if (config.arm === "baseline")
		requireThat(
			config.expectedSha.startsWith("26ebc4931"),
			"baseline must be 26ebc4931",
		);
	requireThat(
		config.model?.startsWith("claude-") &&
			config.modelAlias &&
			config.effort &&
			/^[A-Z]+-\d+$/.test(config.issueId),
		"pin full Claude model, supported modelAlias, effort, and fixture issueId",
	);
	requireThat(
		!existsSync(join(room.hostRepo, ".flywheel/agents/registry.yaml")),
		"fixture must never have a project agent registry",
	);
	const registry = read(room.launchdRegistry);
	const lead = registry.find((row) => row.label === room.leadLaunchdLabel);
	requireThat(
		lead && slotPath(lead.manifest, base),
		"Lead manifest absent from slot registry",
	);
	const topology = command(
		"bash",
		[
			"-c",
			'source "$1"; qa_launchd_lead_verify "$2" "$3"',
			"fly2533-topology",
			join(ROOT, "scripts/lib/qa-launchd-lead.sh"),
			room.leadLaunchdLabel,
			lead.manifest,
		],
		{ env: { ...process.env, FLYWHEEL_QA_LEAD_VERIFY_POLLS: "1" } },
	);
	requireThat(
		topology.split("\t")[1] === room.leadSocket,
		"private tmux socket mismatch",
	);
	const lease = read(
		join(base, "state/comm", room.projectName, `.inbox-ready-${room.agentId}`),
	);
	requireThat(
		Number.isInteger(lease.pid) && lease.pid > 0,
		"missing inbox-ready PID",
	);
	process.kill(lease.pid, 0);
	const health = await fetch(`${room.bridgeUrl}/health`, { redirect: "error" });
	const body = await health.json();
	requireThat(
		health.ok && body.buildSha === config.expectedSha,
		"live slot Bridge buildSha mismatch",
	);
	const tokenPath = slotPath(config.apiTokenPath, base);
	requireThat(
		(statSync(tokenPath).mode & 0o077) === 0,
		"slot master credential requires private file",
	);
	const deliverySecretPath = slotPath(
		join(base, "state/delivery-secret"),
		base,
	);
	requireThat(existsSync(deliverySecretPath), "slot delivery secret absent");
	const requireTeamlead = createRequire(
		join(config.codeRepo, "packages/teamlead/package.json"),
	);
	const Database = requireTeamlead("better-sqlite3");
	const db = new Database(room.dbPath, {
		readonly: true,
		fileMustExist: true,
		timeout: 5000,
	});
	return {
		config,
		room,
		base,
		db,
		token: readFileSync(tokenPath, "utf8").trim(),
		evidence: join(base, `fly2533-${config.arm}`),
		topology,
		deliverySecretPath,
	};
}
const DOMAIN = {
	implement:
		"# Tiny fixture implementation\nRead FLY-2533-fixture-task.txt. Implement the requested deterministic change, test it, commit and open its sandbox PR.\n",
	qa: "# Tiny fixture quality check\nRead FLY-2533-fixture-task.txt. Inspect the proposed change and independently run its test. Explain whether it satisfies the task.\n",
};
const TASK =
	"In this isolated sandbox add fly2533-fixture.mjs exporting add(a, b) as a + b. Add a Node assertion proving add(2, 3) is 5. Change no other product code. The quality check should pass for that implementation.\n";
function fixture(c, create) {
	const { room } = c;
	const paths = {
		task: join(room.hostRepo, "FLY-2533-fixture-task.txt"),
		implement: join(room.hostRepo, ".flywheel/agents/fly2533-implement.md"),
		qa: join(room.hostRepo, ".flywheel/agents/fly2533-qa.md"),
	};
	const contents = { task: TASK, ...DOMAIN };
	for (const [key, path] of Object.entries(paths)) {
		slotPath(path, c.base);
		if (create) {
			requireThat(
				!existsSync(path) || readFileSync(path, "utf8") === contents[key],
				`refusing to overwrite ${key}`,
			);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, contents[key]);
		}
		requireThat(
			readFileSync(path, "utf8") === contents[key],
			`fixture ${key} drift`,
		);
	}
	if (create) {
		const menu = join(room.hostRepo, ".flywheel/menus");
		mkdirSync(menu, { recursive: true });
		for (const [name, content] of Object.entries({
			"adoption.yaml": `${room.agentId}: [simple_code]\n`,
			"ic-roster.yaml":
				"implement: .flywheel/agents/fly2533-implement.md\nqa: .flywheel/agents/fly2533-qa.md\n",
		})) {
			const path = slotPath(join(menu, name), c.base);
			requireThat(
				!existsSync(path) || readFileSync(path, "utf8") === content,
				"refusing to replace existing menu fixture",
			);
			writeFileSync(path, content);
		}
	}
	return { contents, digest: hash(JSON.stringify(contents)) };
}
async function prepare(c) {
	requireThat(
		!existsSync(join(c.evidence, "prepared.json")),
		"arm already prepared; do not replace its baseline cursor",
	);
	const initialHead = command("git", [
		"-C",
		c.room.hostRepo,
		"rev-parse",
		"HEAD",
	]);
	const evidence = fixture(c, true);
	// These existing helpers only seed the already isolated slot database.
	for (const subcommand of ["seed-bindings", "seed-project-flags"])
		command(process.execPath, [
			join(c.config.codeRepo, "scripts/lib/qa-generalized.mjs"),
			subcommand,
			"--db",
			c.room.dbPath,
			"--project",
			c.room.projectName,
		]);
	write(join(c.evidence, "prepared.json"), {
		initialHead,
		fixtureDigest: evidence.digest,
		...evidence,
		buildSha: c.config.expectedSha,
		credential: { presence: Boolean(c.token), class: "slot-master" },
		deliverySecretPath: c.deliverySecretPath,
	});
}
async function run(c) {
	const prepared = read(join(c.evidence, "prepared.json"));
	requireThat(
		fixture(c, false).digest === prepared.fixtureDigest,
		"prepared fixture drift",
	);
	for (const [file, expected] of Object.entries({
		"FLY-2533-fixture-task.txt": TASK,
		".flywheel/agents/fly2533-implement.md": DOMAIN.implement,
		".flywheel/agents/fly2533-qa.md": DOMAIN.qa,
	})) {
		requireThat(
			command("git", ["-C", c.room.hostRepo, "show", `HEAD:${file}`]) ===
				expected.trim(),
			"fixture must be committed before dispatch",
		);
	}
	const path = join(c.evidence, "start.json");
	requireThat(
		!existsSync(path),
		"arm already started; use observe, never reuse old snapshot",
	);
	requireThat(c.token.length > 0, "empty slot master credential");
	const request = {
		issueId: c.config.issueId,
		projectName: c.room.projectName,
		leadId: c.room.agentId,
		taskCategory: "simple_code",
		sessionRole: "main",
		idempotencyKey: `fly2533-${c.config.arm}-${randomUUID()}`,
		overrides: {
			implement: { model: c.config.modelAlias, effort: c.config.effort },
			qa: { model: c.config.modelAlias, effort: c.config.effort },
		},
	};
	write(path, { state: "requested", request });
	const response = await fetch(`${c.room.bridgeUrl}/api/runs/start`, {
		method: "POST",
		redirect: "error",
		headers: {
			authorization: `Bearer ${c.token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(request),
	});
	const result = await response.json();
	write(path, { state: "responded", request, status: response.status, result });
	requireThat(response.ok, `slot start rejected with HTTP ${response.status}`);
	validateGeneralizedStartResponse(result);
	await observe(c);
}
async function observe(c) {
	const start = read(join(c.evidence, "start.json"));
	const runId = validateGeneralizedStartResponse(start.result).workflowRunId;
	const prepared = read(join(c.evidence, "prepared.json"));
	const run = c.db
		.prepare("SELECT snapshot, status FROM workflow_run WHERE run_id = ?")
		.get(runId);
	requireThat(run, "missing immutable run snapshot");
	const snapshot = JSON.parse(run.snapshot);
	const qa = snapshot.resolved.nodes.find((node) => node.type === "qa");
	requireThat(
		qa?.dispatch?.vendor === "claude" &&
			qa.dispatch.model === c.config.model &&
			qa.dispatch.effort === c.config.effort,
		"effective snapshot QA vendor/model/effort mismatch",
	);
	write(join(c.evidence, "snapshot.json"), snapshot);
	const windowPath = join(c.evidence, "window.json");
	let window = existsSync(windowPath) ? read(windowPath) : null;
	const deadline = Date.now() + 60 * 60_000;
	while (!window) {
		const activation = c.db
			.prepare(
				"SELECT run_id, node_id, attempt, activation_id, execution_id, bound_at FROM workflow_execution_binding WHERE run_id = ? AND node_id = ? ORDER BY attempt, bound_at LIMIT 1",
			)
			.get(runId, qa.id);
		if (activation) {
			const activatedAt = Date.parse(
				activation.bound_at.endsWith("Z")
					? activation.bound_at
					: `${activation.bound_at.replace(" ", "T")}Z`,
			);
			requireThat(
				Number.isFinite(activatedAt) && Date.now() - activatedAt < POLL * 2,
				"QA activation observation began late; fresh arm required",
			);
			window = {
				activation,
				startedAt: activatedAt,
				deadline: activatedAt + WINDOW,
			};
			write(windowPath, window);
		} else {
			requireThat(
				Date.now() < deadline,
				"QA never activated within one hour; B unproven",
			);
			process.stdout.write(
				"Waiting for real QA activation; no claim manufactured.\n",
			);
			await new Promise((resolveWait) => setTimeout(resolveWait, POLL));
		}
	}
	const observationPath = join(c.evidence, "observations.json");
	const observations = existsSync(observationPath) ? read(observationPath) : [];
	requireThat(
		observations.length || Date.now() - window.startedAt < POLL * 2,
		"observation started late; B unproven",
	);
	requireThat(
		!observations.length ||
			Date.now() - Date.parse(observations.at(-1).observedAt) < POLL * 2,
		"observation gap; B unproven, fresh paired run required",
	);
	let accepted = null;
	for (;;) {
		const rows = c.db
			.prepare(
				`SELECT k.family, k.claim_id, k.consumed_at, k.activation_id, k.run_id, k.node_id, k.attempt, k.execution_id, c.server_seq, c.issuer_execution_id, c.issuer_vendor, c.issuer_model, c.predicate, c.subject_kind, c.subject_digest FROM workflow_submission_credential k JOIN workflow_claims c ON c.id = k.claim_id WHERE k.run_id = ? AND k.activation_id = ? AND k.family = 'qa_verdict' AND julianday(k.consumed_at) <= julianday(?)`,
			)
			.all(
				runId,
				window.activation.activation_id,
				new Date(window.deadline).toISOString(),
			);
		for (const row of rows) {
			const outcome = classifyClaim(row, window.activation);
			if (outcome) accepted = { outcome, ...row };
		}
		const workflow = c.db
			.prepare(
				"SELECT status, current_node_id FROM workflow_run WHERE run_id = ?",
			)
			.get(runId);
		observations.push({
			observedAt: new Date().toISOString(),
			workflow,
			claims: rows,
		});
		write(observationPath, observations);
		process.stdout.write(
			`QA ${runId}: ${accepted?.outcome ?? "no accepted claim observed"}\n`,
		);
		if (Date.now() >= window.deadline) break;
		await new Promise((resolveWait) =>
			setTimeout(resolveWait, Math.min(POLL, window.deadline - Date.now())),
		);
	}
	write(join(c.evidence, "result.json"), {
		arm: c.config.arm,
		issueId: c.config.issueId,
		buildSha: c.config.expectedSha,
		initialHead: prepared.initialHead,
		fixtureDigest: prepared.fixtureDigest,
		model: qa.dispatch.model,
		effort: qa.dispatch.effort,
		windowMs: WINDOW,
		runId,
		snapshotDigest: snapshot.snapshot_digest,
		template: snapshot.template,
		activation: window.activation,
		outcome: accepted?.outcome ?? "NO_CLAIM_IN_WINDOW",
		accepted,
		observationCount: observations.length,
	});
}
async function main() {
	const [mode, input, other] = process.argv.slice(2);
	if (mode === "compare") {
		const report = compareArms(read(input), read(other));
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		if (report.criterionB !== "PASS") process.exitCode = 2;
		return;
	}
	requireThat(
		["prepare", "run", "observe"].includes(mode) && input && !other,
		"Usage: qa-fly-2533-phase-protocol.mjs prepare|run|observe arm.json; compare baseline/result.json candidate/result.json",
	);
	const c = await context(read(input));
	try {
		await { prepare, run, observe }[mode](c);
	} finally {
		c.db.close();
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main().catch((error) => {
		process.stderr.write(`FLY-2533 QA: ${error.message}\n`);
		process.exitCode = 1;
	});
