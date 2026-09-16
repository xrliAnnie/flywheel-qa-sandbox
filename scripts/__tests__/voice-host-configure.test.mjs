import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const repo = resolve(import.meta.dirname, "../..");
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "voice-configure-"));
	roots.push(root);
	const checkout = join(root, "repo"),
		home = join(root, "home"),
		state = join(home, ".flywheel"),
		out = join(root, "receipt");
	for (const dir of [
		"scripts",
		"packages/teamlead/dist/bin",
		"packages/flywheel-comm/dist/bin",
	])
		mkdirSync(join(checkout, dir), { recursive: true });
	mkdirSync(join(state, "state/summary-registry"), { recursive: true });
	for (const name of [
		"flywheel-config-lock.sh",
		"flywheel-config-lock.py",
		"voice-host-configure.mjs",
	])
		if (existsSync(join(repo, "scripts", name)))
			cpSync(join(repo, "scripts", name), join(checkout, "scripts", name));
	cpSync(
		join(repo, "packages/teamlead/dist/voice-host-config.js"),
		join(checkout, "packages/teamlead/dist/voice-host-config.js"),
	);
	writeFileSync(join(checkout, "package.json"), '{"type":"module"}');
	writeFileSync(
		join(checkout, "packages/teamlead/dist/bin/validate-projects.js"),
		`import {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync(process.argv[2],'utf8')); if(!Array.isArray(p)||p.some(x=>!Array.isArray(x.leads))) process.exit(1);`,
	);
	writeFileSync(
		join(checkout, "packages/flywheel-comm/dist/bin/summary-registry.js"),
		`import {existsSync,readFileSync} from 'node:fs'; if(process.argv[2]!=='verify-activation') process.exit(2); const receipt=process.argv[process.argv.indexOf('--receipt-file')+1]; if(readFileSync(receipt,'utf8')!=='summary-authority\\n'||existsSync(process.env.HOME+'/.flywheel/reject-summary')) process.exit(1);`,
	);
	const projects = join(state, "projects.json"),
		host = join(state, "voice-host.json"),
		summary = join(state, "state/summary-registry/migration-receipt.json");
	const original = `${JSON.stringify(
		[
			{
				projectName: "flywheel",
				projectRoot: "/repo/flywheel",
				leads: [
					{
						agentId: "flywheel-eng-lead",
						botTokenEnv: "FLYWHEEL_TOKEN",
						realtimeVoice: "cedar",
						summary: { keep: "same" },
					},
				],
			},
			{
				projectName: "raya",
				projectRoot: "/repo/raya",
				leads: [
					{ agentId: "raya", botTokenEnv: "RAYA_TOKEN" },
					{ agentId: "other", voiceModes: { meeting: false, rg: true } },
				],
			},
		],
		null,
		2,
	)}\n`;
	writeFileSync(projects, original, { mode: 0o644 });
	writeFileSync(summary, "summary-authority\n", { mode: 0o600 });
	const run = (action, extraEnv = {}) =>
		spawnSync(
			process.execPath,
			[
				join(checkout, "scripts/voice-host-configure.mjs"),
				action,
				action === "prepare" ? "--out" : "--receipt",
				action === "prepare" ? out : join(out, "receipt.json"),
			],
			{
				encoding: "utf8",
				timeout: 15000,
				env: { HOME: home, PATH: process.env.PATH, ...extraEnv },
			},
		);
	return { root, checkout, state, out, projects, host, summary, original, run };
}
test("prepare is non-mutating; apply changes only approved voice fields; restore preserves exact before bytes", () => {
	const f = fixture();
	let r = f.run("prepare");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(f.projects, "utf8"), f.original);
	assert.equal(existsSync(f.host), false);
	assert.equal(statSync(f.out).mode & 0o777, 0o700);
	assert.equal(statSync(join(f.out, "receipt.json")).mode & 0o777, 0o600);
	r = f.run("apply");
	assert.equal(r.status, 0, r.stderr);
	const p = JSON.parse(readFileSync(f.projects, "utf8"));
	assert.deepEqual(
		p.map((x) => x.voiceRoom),
		Array(2).fill({
			guildId: "1485787271192907816",
			voiceChannelId: "1485787273193853170",
		}),
	);
	assert.deepEqual(
		p.flatMap((x) => x.leads.map((l) => l.voiceModes)),
		[
			{ meeting: true, rg: false },
			{ meeting: true, rg: true },
			{ meeting: true, rg: false },
		],
	);
	assert.equal(p[0].leads[0].realtimeVoice, "cedar");
	assert.equal(p[1].leads[0].realtimeVoice, "marin");
	assert.deepEqual(p[0].leads[0].summary, { keep: "same" });
	assert.deepEqual(JSON.parse(readFileSync(f.host, "utf8")), {
		schemaVersion: 1,
	});
	assert.equal(readFileSync(f.summary, "utf8"), "summary-authority\n");
	assert.equal(f.run("apply").status, 0);
	r = f.run("restore");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(f.projects, "utf8"), f.original);
	assert.equal(statSync(f.projects).mode & 0o777, 0o644);
	assert.equal(existsSync(f.host), false);
	assert.equal(readFileSync(f.summary, "utf8"), "summary-authority\n");
});
for (const kind of [
	"project-conflict",
	"summary-conflict",
	"candidate-conflict",
	"intent",
	"summary-rejection",
])
	test(`refuses ${kind} before publishing`, () => {
		const f = fixture();
		assert.equal(f.run("prepare").status, 0);
		if (kind === "project-conflict") writeFileSync(f.projects, "[]\n");
		if (kind === "summary-conflict")
			writeFileSync(f.summary, "other-authority");
		if (kind === "candidate-conflict")
			writeFileSync(join(f.out, "projects.after.json"), "[]");
		if (kind === "intent")
			writeFileSync(`${f.summary}.lead-registry-intent.json`, "{}");
		if (kind === "summary-rejection")
			writeFileSync(join(f.state, "reject-summary"), "1");
		const before = readFileSync(f.projects, "utf8");
		assert.notEqual(f.run("apply").status, 0);
		assert.equal(readFileSync(f.projects, "utf8"), before);
		assert.equal(existsSync(f.host), false);
	});

// Fault injection changes only the isolated copy, never a production env switch.
function crashAt(f, point) {
	const path = join(f.checkout, "scripts/voice-host-configure.mjs");
	let text = readFileSync(path, "utf8");
	const needle = 'atomic(join(out, "receipt.json"), encode(receipt));';
	assert.equal(text.split(needle).length, 2);
	text = text.replace(
		needle,
		`${needle}\n if(status==='applying' && step===${JSON.stringify(point)}) process.exit(77);`,
	);
	writeFileSync(path, text);
}
for (const point of [
	"begin",
	"before_projects",
	"after_projects",
	"before_host",
	"after_host",
])
	test(`resumes known images after crash at ${point}`, () => {
		const f = fixture();
		assert.equal(f.run("prepare").status, 0);
		crashAt(f, point);
		assert.notEqual(f.run("apply").status, 0);
		cpSync(
			join(repo, "scripts/voice-host-configure.mjs"),
			join(f.checkout, "scripts/voice-host-configure.mjs"),
		);
		const result = f.run("apply");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			JSON.parse(readFileSync(join(f.out, "receipt.json"), "utf8")).status,
			"applied",
		);
		assert.equal(f.run("restore").status, 0);
		assert.equal(readFileSync(f.projects, "utf8"), f.original);
		assert.equal(existsSync(f.host), false);
		assert.equal(readFileSync(f.summary, "utf8"), "summary-authority\n");
	});
test("crash recovery cannot overwrite a third-party edit", () => {
	const f = fixture();
	assert.equal(f.run("prepare").status, 0);
	crashAt(f, "after_projects");
	assert.notEqual(f.run("apply").status, 0);
	cpSync(
		join(repo, "scripts/voice-host-configure.mjs"),
		join(f.checkout, "scripts/voice-host-configure.mjs"),
	);
	writeFileSync(f.projects, "[]\n");
	assert.notEqual(f.run("apply").status, 0);
	assert.notEqual(f.run("restore").status, 0);
	assert.equal(readFileSync(f.projects, "utf8"), "[]\n");
	assert.equal(existsSync(f.host), false);
});
test("preserves an existing voice-host file verbatim", () => {
	const f = fixture();
	const before =
		'{ "schemaVersion": 1, "qaAllowUserIds": ["123456789012345678"] }\n';
	writeFileSync(f.host, before, { mode: 0o600 });
	assert.equal(f.run("prepare").status, 0);
	assert.equal(f.run("apply").status, 0);
	assert.equal(readFileSync(f.host, "utf8"), before);
	assert.equal(f.run("restore").status, 0);
	assert.equal(readFileSync(f.host, "utf8"), before);
});
test("rejects legacy huddle before writing a candidate", () => {
	const f = fixture();
	const p = JSON.parse(f.original);
	p[0].huddle = {};
	writeFileSync(f.projects, JSON.stringify(p));
	assert.notEqual(f.run("prepare").status, 0);
	assert.equal(existsSync(f.out), false);
});

test("post-publication validation failure restores both before images", () => {
	const f = fixture();
	assert.equal(f.run("prepare").status, 0);
	writeFileSync(
		join(f.checkout, "packages/teamlead/dist/bin/validate-projects.js"),
		`import {readFileSync} from 'node:fs'; const path=process.argv[2]; const p=JSON.parse(readFileSync(path,'utf8')); if(path===${JSON.stringify(f.projects)} && p[0].voiceRoom) process.exit(1);`,
	);
	const result = f.run("apply");
	assert.notEqual(result.status, 0);
	assert.equal(readFileSync(f.projects, "utf8"), f.original);
	assert.equal(existsSync(f.host), false);
	assert.equal(
		JSON.parse(readFileSync(join(f.out, "receipt.json"), "utf8")).status,
		"restored",
	);
	assert.equal(readFileSync(f.summary, "utf8"), "summary-authority\n");
});

test("real registry and summary authorities accept the scoped round trip without changing the summary receipt", async () => {
	const f = fixture();
	const { createHash } = await import("node:crypto");
	const { pathToFileURL } = await import("node:url");
	const { migrateSummaryRegistry } = await import(
		pathToFileURL(
			join(repo, "packages/flywheel-comm/dist/summary-registry-migration.js"),
		).href
	);
	const { parseAndValidateProjects } = await import(
		pathToFileURL(join(repo, "packages/teamlead/dist/ProjectConfig.js")).href
	);
	const original = JSON.stringify([
		{
			projectName: "raya",
			projectRoot: f.root,
			leads: [
				{
					agentId: "raya",
					chatChannel: "123456789012345678",
					summaryRole: "producer",
					botTokenEnv: "RAYA_TOKEN",
					botUserId: "223456789012345678",
					match: { labels: ["Engineering"] },
				},
			],
		},
	]);
	writeFileSync(f.projects, original);
	writeFileSync(
		join(f.state, "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-09-15T00:00:00Z",
		}),
		{ mode: 0o600 },
	);
	const assignments = join(f.root, "assignments.json");
	writeFileSync(
		assignments,
		JSON.stringify({
			assignments: [
				{ projectName: "raya", leadId: "raya", summaryRole: "producer" },
			],
		}),
	);
	migrateSummaryRegistry(
		{
			projectsPath: f.projects,
			assignmentsPath: assignments,
			receiptPath: f.summary,
			expectedSha256: createHash("sha256").update(original).digest("hex"),
			homeDir: join(f.root, "home"),
		},
		{
			validateTeamleadCandidate: (path) =>
				parseAndValidateProjects(JSON.parse(readFileSync(path, "utf8"))),
		},
	);
	const before = readFileSync(f.projects),
		authority = readFileSync(f.summary);
	const validator = pathToFileURL(
		join(repo, "packages/teamlead/dist/bin/validate-projects.js"),
	).href;
	const verifier = pathToFileURL(
		join(repo, "packages/flywheel-comm/dist/commands/summary-registry.js"),
	).href;
	writeFileSync(
		join(f.checkout, "packages/teamlead/dist/bin/validate-projects.js"),
		`import {runCli} from ${JSON.stringify(validator)}; process.exitCode=runCli(process.argv);`,
	);
	writeFileSync(
		join(f.checkout, "packages/flywheel-comm/dist/bin/summary-registry.js"),
		`import {runSummaryRegistryCommand} from ${JSON.stringify(verifier)}; process.exitCode=runSummaryRegistryCommand(process.argv.slice(2));`,
	);
	for (const action of ["prepare", "apply", "restore"]) {
		const r = f.run(action);
		assert.equal(r.status, 0, `${action}: ${r.stderr}`);
		assert.deepEqual(readFileSync(f.summary), authority);
	}
	assert.deepEqual(readFileSync(f.projects), before);
});

test("a forged lock-held env flag cannot bypass the kernel lock", async () => {
	const f = fixture();
	const holder = spawn(
		"python3",
		[
			"-c",
			`import fcntl,json,sys,time
with open(sys.argv[1]+'.cfglock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 print('held',flush=True)
 time.sleep(1)
 rows=json.load(open(sys.argv[1])); rows[0]['lockMarker']='from-holder'
 with open(sys.argv[1],'w') as out: json.dump(rows,out)
`,
			f.projects,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	await new Promise((resolveReady, reject) => {
		holder.stdout.once("data", resolveReady);
		holder.once("error", reject);
	});
	const result = f.run("prepare", { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		JSON.parse(readFileSync(join(f.out, "projects.before.json"), "utf8"))[0]
			.lockMarker,
		"from-holder",
	);
});
test("invalid receipt identity is rejected before publication", () => {
	const f = fixture();
	assert.equal(f.run("prepare").status, 0);
	const path = join(f.out, "receipt.json");
	const r = JSON.parse(readFileSync(path, "utf8"));
	r.id = "private-value";
	writeFileSync(path, JSON.stringify(r));
	assert.notEqual(f.run("apply").status, 0);
	assert.equal(readFileSync(f.projects, "utf8"), f.original);
});

test("preserves recorded project permissions under a restrictive caller umask", () => {
	const f = fixture();
	assert.equal(f.run("prepare").status, 0);
	const result = spawnSync(
		"bash",
		[
			"-c",
			'umask 077; exec "$@"',
			"voice-umask",
			process.execPath,
			join(f.checkout, "scripts/voice-host-configure.mjs"),
			"apply",
			"--receipt",
			join(f.out, "receipt.json"),
		],
		{
			encoding: "utf8",
			timeout: 15000,
			env: { HOME: join(f.root, "home"), PATH: process.env.PATH },
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(statSync(f.projects).mode & 0o777, 0o644);
	assert.equal(f.run("restore").status, 0);
});

test("a symlinked output parent cannot put private backups inside the repository", async () => {
	const f = fixture();
	const { symlinkSync } = await import("node:fs");
	const alias = join(f.root, "alias");
	symlinkSync(f.checkout, alias);
	const result = spawnSync(
		process.execPath,
		[
			join(f.checkout, "scripts/voice-host-configure.mjs"),
			"prepare",
			"--out",
			join(alias, "private"),
		],
		{
			encoding: "utf8",
			timeout: 15000,
			env: { HOME: join(f.root, "home"), PATH: process.env.PATH },
		},
	);
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(join(f.checkout, "private")), false);
});

for (const target of ["projects", "host"])
	test(`recovers a crash after ${target} rename but before the after receipt`, () => {
		const f = fixture();
		assert.equal(f.run("prepare").status, 0);
		const path = join(f.checkout, "scripts/voice-host-configure.mjs");
		const needle = "renameSync(temporary, path);";
		const text = readFileSync(path, "utf8");
		assert.equal(text.split(needle).length, 2);
		writeFileSync(
			path,
			text.replace(
				needle,
				`${needle}\n if(path === paths.${target}) process.exit(77);`,
			),
		);
		assert.notEqual(f.run("apply").status, 0);
		const r = JSON.parse(readFileSync(join(f.out, "receipt.json"), "utf8"));
		assert.equal(r.step, `before_${target}`);
		cpSync(join(repo, "scripts/voice-host-configure.mjs"), path);
		assert.equal(f.run("apply").status, 0);
		assert.equal(f.run("restore").status, 0);
		assert.equal(readFileSync(f.projects, "utf8"), f.original);
		assert.equal(existsSync(f.host), false);
	});
test("resumes a partial restore without rebinding the saved images", () => {
	const f = fixture();
	assert.equal(f.run("prepare").status, 0);
	assert.equal(f.run("apply").status, 0);
	const path = join(f.checkout, "scripts/voice-host-configure.mjs");
	const needle = 'atomic(join(out, "receipt.json"), encode(receipt));';
	const text = readFileSync(path, "utf8");
	assert.equal(text.split(needle).length, 2);
	writeFileSync(
		path,
		text.replace(
			needle,
			`${needle}\n if(status === 'restoring' && step === 'after_projects') process.exit(77);`,
		),
	);
	assert.notEqual(f.run("restore").status, 0);
	assert.equal(readFileSync(f.projects, "utf8"), f.original);
	assert.equal(existsSync(f.host), true);
	cpSync(join(repo, "scripts/voice-host-configure.mjs"), path);
	assert.equal(f.run("restore").status, 0);
	assert.equal(existsSync(f.host), false);
	assert.equal(readFileSync(f.summary, "utf8"), "summary-authority\n");
});
