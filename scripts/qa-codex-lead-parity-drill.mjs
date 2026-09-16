#!/usr/bin/env node
// Explicit fixture execution and evidence consistency checking. Neither mode
// activates a Lead or certifies native browser / Honey Lemon acceptance.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LEAD_CAPABILITY_CATALOG } from "../packages/teamlead/dist/lead-capabilities/catalog.js";

const bindingKeys = [
	"project",
	"lead",
	"identityDigest",
	"activationId",
	"threadId",
	"sourceSha",
	"deployedSha",
	"manifestDigest",
	"issueId",
	"runId",
	"executionId",
];
const fail = (code) => {
	throw new Error(code);
};
const object = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) =>
	typeof value === "string" && value.length > 0 && value.length <= 512;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maxBytes = 4 * 1024 * 1024;

// Representative broker coverage, not every operation or a model/native tool audit.
export function summarizeFixtureCoverage(fixture) {
	const groups = [
		["start_runner"],
		["discord.thread.resolve"],
		["discord.thread.read"],
		["discord.message.attachments.get", "discord.message.attachments.send"],
		["linear.comment.create"],
		["github.pr.view", "github.pr.comment"],
		["bridge.read"],
		["terminal.status"],
		["inbox.batch.ack"],
		["patrol.snapshot", "patrol.judgment.record"],
		[
			"artifact.text.create",
			"report.publish",
			"report.verify",
			"report.deliver",
		],
		["browser.list_pages"],
		[],
		[],
		["knowledge.search"],
		["xiaohongshu.list_feeds", "xiaohongshu.get_feed_detail"],
		["docs.lookup"],
	];
	const prefixes = [
		"start_runner",
		"discord.thread.resolve",
		"discord.thread.read",
		"discord.message.attachments.",
		"linear.",
		"github.",
		"bridge.",
		"terminal.",
		"inbox.",
		"patrol.",
		"report.",
		"browser.",
		"rules.",
		"skills.",
		"knowledge.",
		"xiaohongshu.",
		"docs.",
	];
	if (!Array.isArray(fixture.trace) || fixture.trace.length > 10000)
		fail("parity_trace_incomplete");
	for (const entry of fixture.trace) {
		if (
			!object(entry.request) ||
			!object(entry.result) ||
			!nonempty(entry.request.operationId) ||
			!nonempty(entry.request.requestId) ||
			entry.request.requestId !== entry.result.requestId
		)
			fail("parity_trace_request_mismatch");
		if (/claude/i.test(entry.request.operationId))
			fail("parity_forbidden_call");
	}
	return groups.map((required, index) => {
		const positiveRefs = [],
			negativeRefs = [],
			succeeded = new Set();
		fixture.trace.forEach((entry, traceIndex) => {
			const id = entry.request.operationId;
			if (!id.startsWith(prefixes[index]) && !required.includes(id)) return;
			const ref = `fixture.json#/trace/${traceIndex}`;
			if (entry.result.status === "succeeded") {
				positiveRefs.push(ref);
				succeeded.add(id);
			} else if (["rejected", "unknown"].includes(entry.result.status))
				negativeRefs.push(ref);
		});
		const sourceKind = index === 12 ? "rules" : index === 13 ? "skills" : null;
		const source = sourceKind && fixture.sourceChecks?.[sourceKind];
		const sourceExercised = Boolean(
			source &&
				nonempty(fixture.activationId) &&
				nonempty(fixture.issueId) &&
				fixture.sourceChecks.activationId === fixture.activationId &&
				fixture.sourceChecks.issueId === fixture.issueId &&
				/^[a-f0-9]{64}$/.test(source.sha256) &&
				source.wrongDigestRejected === true &&
				(index === 12
					? source.loaded === true
					: source.installed === true &&
						source.scope === "single_fixture_adapter"),
		);
		if (sourceExercised) {
			positiveRefs.push(`fixture.json#/sourceChecks/${sourceKind}`);
			negativeRefs.push(`fixture.json#/sourceChecks/${sourceKind}`);
		}
		const exercised =
			required.length > 0 && required.every((id) => succeeded.has(id));
		return {
			id: `P${String(index + 1).padStart(2, "0")}`,
			status:
				exercised || sourceExercised
					? index === 11
						? "provider_fixture_only"
						: "representative_fixture_exercised"
					: "unverified",
			scope: "fixture",
			requiredRepresentativeOperations: required,
			positiveRefs,
			negativeRefs,
			missingRepresentativeOperations: required.filter(
				(id) => !succeeded.has(id),
			),
			...(index === 12 || index === 13
				? {
						compositionRef: "fixture.json#/defaultFactory",
						limitation:
							"fixture_rule_and_single_adapter_not_full_persona_or_native_discovery",
					}
				: {}),
			parityVerified: false,
		};
	});
}

export function collectIsolatedParityFixture({ outputRoot }) {
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const requestedOutput = resolve(outputRoot);
	const output = join(
		realpathSync(dirname(requestedOutput)),
		basename(requestedOutput),
	);
	// Never reuse an existing directory or replace a prior receipt.
	if (realpathSync(dirname(output)) !== dirname(output))
		fail("parity_output_invalid");
	mkdirSync(output, { mode: 0o700 });
	const home = realpathSync(mkdtempSync(join(tmpdir(), "parity-home-")));
	const env = {
		HOME: home,
		PATH: "/usr/bin:/bin",
		LANG: "en_US.UTF-8",
		NO_COLOR: "1",
		CI: "1",
	};
	const git = (args) =>
		execFileSync("/usr/bin/git", args, {
			cwd: repo,
			env,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	try {
		const sourceSha = git(["rev-parse", "HEAD"]);
		const workingTree = git(["status", "--porcelain"]);
		const startedAt = new Date().toISOString();
		// Threads keep the bounded test worker in this owned child process. The
		// fixture never starts native executors or production provider processes.
		const stdout = execFileSync(
			process.execPath,
			[
				join(repo, "packages/teamlead/node_modules/vitest/vitest.mjs"),
				"run",
				"src/lead-capabilities/__tests__/parity-drill.test.ts",
				"src/lead-capabilities/__tests__/default-parent-integration.test.ts",
				"--pool=threads",
				"--maxWorkers=1",
				"--no-file-parallelism",
			],
			{
				cwd: join(repo, "packages/teamlead"),
				env,
				encoding: "utf8",
				timeout: 30000,
				maxBuffer: 2 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const lines = stdout
			.split("\n")
			.filter((line) => line.startsWith("FLY2519_PARITY_FIXTURE="));
		if (
			lines.length !== 1 ||
			git(["rev-parse", "HEAD"]) !== sourceSha ||
			git(["status", "--porcelain"]) !== workingTree
		)
			fail("parity_fixture_changed");
		const fixture = JSON.parse(
			lines[0].slice("FLY2519_PARITY_FIXTURE=".length),
		);
		if (
			fixture.scope !== "fixture" ||
			fixture.hostVerified !== false ||
			fixture.parityVerified !== false ||
			!Array.isArray(fixture.trace) ||
			fixture.cleanup?.brokerSocketRemoved !== true ||
			fixture.cleanup?.journalClosed !== true
		)
			fail("parity_fixture_invalid");
		const factoryLines = stdout
			.split("\n")
			.filter((line) => line.startsWith("FLY2519_DEFAULT_FACTORY="));
		if (factoryLines.length !== 1) fail("parity_factory_evidence_missing");
		const defaultFactory = JSON.parse(
			factoryLines[0].slice("FLY2519_DEFAULT_FACTORY=".length),
		);
		if (
			defaultFactory.scope !== "fixture" ||
			defaultFactory.hostVerified !== false ||
			defaultFactory.result?.status !== "succeeded" ||
			defaultFactory.cleanup?.socketRemoved !== true ||
			defaultFactory.cleanup?.artifactsRemoved !== true ||
			defaultFactory.tuiGeneration?.sameWindowPreserved !== true ||
			defaultFactory.tuiGeneration?.wrongConfigRejected !== true ||
			!defaultFactory.tuiGeneration?.methods?.includes("thread/start") ||
			!defaultFactory.tuiGeneration?.methods?.includes("thread/resume")
		)
			fail("parity_factory_evidence_invalid");
		fixture.defaultFactory = defaultFactory;
		const rows = summarizeFixtureCoverage(fixture);
		const coverageBytes = `${JSON.stringify({ schemaVersion: 1, scope: "fixture", sourceSha, traceScope: "recorded_broker_requests_only", rows, hostVerified: false, parityVerified: false }, null, 2)}\n`;
		writeFileSync(join(output, "coverage.json"), coverageBytes, {
			mode: 0o600,
			flag: "wx",
		});
		const bytes = `${JSON.stringify(fixture, null, 2)}\n`;
		writeFileSync(join(output, "fixture.json"), bytes, {
			mode: 0o600,
			flag: "wx",
		});
		writeFileSync(join(output, "test.log"), stdout, {
			mode: 0o600,
			flag: "wx",
		});
		const receipt = {
			schemaVersion: 1,
			mode: "fixture",
			sourceSha,
			workingTreeDirty: workingTree.length > 0,
			startedAt,
			finishedAt: new Date().toISOString(),
			fixtureExecutionPassed: true,
			versions: {
				node: process.versions.node,
				platform: process.platform,
				architecture: process.arch,
			},
			coverageRef: "coverage.json",
			hostVerified: false,
			parityVerified: false,
			files: {
				"fixture.json": hash(bytes),
				"test.log": hash(stdout),
				"coverage.json": hash(coverageBytes),
			},
			missing: [
				"complete_P01_P17_drill",
				"native_browser_host_evidence",
				"honey_lemon_business_acceptance",
			],
		};
		writeFileSync(
			join(output, "receipt.json"),
			`${JSON.stringify(receipt, null, 2)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		return receipt;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function readBounded(path) {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes)
			fail("parity_reference_invalid");
		// Bound the read even if the file grows after fstat.
		const bytes = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		if (offset > maxBytes) fail("parity_reference_invalid");
		return bytes.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}

export function verifyParityEvidence({ evidence, evidenceRoot, expectedHead }) {
	if (
		!object(evidence) ||
		evidence.schemaVersion !== 1 ||
		evidence.mode !== "isolated-drill" ||
		evidence.scope !== "fixture" ||
		!bindingKeys.every((key) => nonempty(evidence[key])) ||
		!nonempty(evidence.cliVersion) ||
		!nonempty(evidence.browserVersion) ||
		!Array.isArray(evidence.rows) ||
		!object(evidence.files)
	)
		fail("parity_evidence_invalid");
	if (
		!/^[a-f0-9]{40}$/.test(expectedHead) ||
		evidence.sourceSha !== expectedHead
	)
		fail("parity_head_mismatch");
	if (
		!["sourceSha", "deployedSha"].every((key) =>
			/^[a-f0-9]{40}$/.test(evidence[key]),
		) ||
		!["identityDigest", "manifestDigest"].every((key) =>
			/^[a-f0-9]{64}$/.test(evidence[key]),
		)
	)
		fail("parity_evidence_invalid");
	const start = Date.parse(evidence.startedAt),
		end = Date.parse(evidence.finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		fail("parity_evidence_invalid");
	const root = realpathSync(evidenceRoot),
		cache = new Map();
	let total = 0;
	const read = (name) => {
		if (
			!nonempty(name) ||
			!/^[A-Za-z0-9_-]+\.json$/.test(name) ||
			!Object.hasOwn(evidence.files, name) ||
			!/^[a-f0-9]{64}$/.test(evidence.files[name])
		)
			fail("parity_reference_invalid");
		if (cache.has(name)) return cache.get(name);
		let bytes;
		try {
			bytes = readBounded(join(root, name));
		} catch {
			fail("parity_reference_invalid");
		}
		total += bytes.length;
		if (bytes.length > maxBytes || total > 32 * 1024 * 1024)
			fail("parity_reference_invalid");
		if (hash(bytes) !== evidence.files[name]) fail("parity_reference_changed");
		let receipt;
		try {
			receipt = JSON.parse(bytes);
		} catch {
			fail("parity_reference_invalid");
		}
		if (
			!object(receipt) ||
			!object(receipt.binding) ||
			!bindingKeys.every((key) => receipt.binding[key] === evidence[key])
		)
			fail("parity_binding_mismatch");
		if (receipt.schemaVersion !== 1 || receipt.scope !== "fixture")
			fail("parity_reference_invalid");
		cache.set(name, receipt);
		return receipt;
	};
	const ids = Array.from(
		{ length: 17 },
		(_, index) => `P${String(index + 1).padStart(2, "0")}`,
	);
	if (
		evidence.rows.length !== 17 ||
		!ids.every(
			(id) => evidence.rows.filter((row) => row?.id === id).length === 1,
		)
	)
		fail("parity_missing_rows");
	const trace = read(evidence.traceRef);
	if (
		trace.kind !== "complete-tool-trace" ||
		!Array.isArray(trace.events) ||
		trace.events.length < 2 ||
		trace.events.length > 10000
	)
		fail("parity_trace_incomplete");
	if (trace.events.some((event) => /claude/i.test(JSON.stringify(event))))
		fail("parity_forbidden_call");
	if (
		evidence.forbiddenCallsObserved !== 0 ||
		trace.events[0]?.type !== "begin" ||
		trace.events.at(-1)?.type !== "end" ||
		!trace.events.every(
			(event, index) =>
				event.sequence === index + 1 &&
				(index === 0 ||
					index === trace.events.length - 1 ||
					(event.type === "tool" &&
						nonempty(event.toolName) &&
						nonempty(event.operationId))),
		)
	)
		fail("parity_trace_incomplete");
	for (const row of evidence.rows) {
		const allowed =
			row.id === "P13"
				? ["rules.load"]
				: row.id === "P14"
					? ["skills.load"]
					: LEAD_CAPABILITY_CATALOG.filter(
							(op) =>
								op.parityId === row.id && op.classification !== "reserved",
						).map((op) => op.operationId);
		const time = Date.parse(row.observedAt);
		if (
			!allowed.includes(row.operationId) ||
			row.status !== "passed" ||
			!Number.isFinite(time) ||
			time < start ||
			time > end ||
			!Array.isArray(row.evidenceRefs) ||
			row.evidenceRefs.length < 1 ||
			row.evidenceRefs.length > 16
		)
			fail("parity_row_invalid");
		if (
			!trace.events.some(
				(event) =>
					event.type === "tool" && event.operationId === row.operationId,
			)
		)
			fail("parity_trace_incomplete");
		for (const name of row.evidenceRefs) {
			const receipt = read(name);
			if (
				receipt.kind !== "operation-check" ||
				receipt.operationId !== row.operationId ||
				receipt.positive?.passed !== true ||
				receipt.negative?.passed !== true
			)
				fail("parity_row_invalid");
		}
	}
	return {
		fixtureEvidenceConsistent: true,
		hostVerified: false,
		parityVerified: false,
		missing: [
			"isolated_execution_attestation",
			"native_browser_host_evidence",
			"honey_lemon_business_acceptance",
		],
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const { values } = parseArgs({
			options: {
				mode: { type: "string" },
				output: { type: "string" },
				evidence: { type: "string" },
				"expected-head": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		});
		if (values.mode === "fixture") {
			if (!values.output || values.evidence || values["expected-head"])
				fail("usage: --mode fixture --output NEW_DIRECTORY");
			console.log(
				JSON.stringify(
					collectIsolatedParityFixture({ outputRoot: values.output }),
				),
			);
			process.exitCode = 2;
		} else {
			if (
				values.mode !== "verify" ||
				!values.evidence ||
				!values["expected-head"]
			)
				fail("usage: --mode verify --evidence FILE --expected-head SHA");
			const path = resolve(values.evidence);
			const evidence = JSON.parse(readBounded(path));
			console.log(
				JSON.stringify(
					verifyParityEvidence({
						evidence,
						evidenceRoot: dirname(path),
						expectedHead: values["expected-head"],
					}),
				),
			);
			process.exitCode = 2; // Consistent fixture evidence is still incomplete acceptance.
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
