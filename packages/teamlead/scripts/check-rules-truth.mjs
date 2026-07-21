#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function usage(message) {
	if (message) process.stderr.write(`check-rules-truth: ${message}\n`);
	process.stderr.write(
		"Usage: check-rules-truth.sh --all [--expected <wave-inventory.json>] [--strict]\n" +
			"       check-rules-truth.sh --lead <id> --project <name> [--expect-role <role>] [--expect-mode <mode>] [--strict]\n" +
			"       check-rules-truth.sh --bundle-file <path> --expect-role <role> [--strict]\n",
	);
	process.exit(2);
}

function parseArgs(argv) {
	const out = { strict: false, all: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--strict") {
			out.strict = true;
		} else if (arg === "--all") {
			out.all = true;
		} else if (
			[
				"--bundle-file",
				"--expect-role",
				"--expect-mode",
				"--expected",
				"--lead",
				"--project",
			].includes(arg)
		) {
			if (i + 1 >= argv.length) usage(`${arg} requires a value`);
			out[arg.slice(2).replaceAll("-", "_")] = argv[i + 1];
			i += 1;
		} else if (arg === "-h" || arg === "--help") {
			usage();
		} else {
			usage(`unknown argument: ${arg}`);
		}
	}
	return out;
}

function fail(reason) {
	throw new Error(reason);
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${label} unreadable or invalid: ${path}: ${error.message}`);
	}
}

function runProbe(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

function verifyRole(role, basenames) {
	const has = (name) => basenames.includes(name);
	switch (role) {
		case "cos":
			if (!has("cos-lead-rules.md")) fail("cos role missing cos-lead-rules.md");
			if (has("department-lead-rules.md"))
				fail("cos role contains department-lead-rules.md");
			break;
		case "dept":
			if (!has("department-lead-rules.md"))
				fail("dept role missing department-lead-rules.md");
			if (has("cos-lead-rules.md"))
				fail("dept role contains cos-lead-rules.md");
			break;
		case "companion":
			if (!has("companion-safety-contract.md"))
				fail("companion role missing companion-safety-contract.md");
			if (has("founder-only-authority.md"))
				fail("companion role contains founder-only-authority.md");
			break;
		case "external":
			if (
				basenames.length !== 1 ||
				basenames[0] !== "external-agent-contract.md"
			)
				fail("external role must contain only external-agent-contract.md");
			break;
		default:
			fail(`unknown expected role: ${role}`);
	}
}

export function verifyBundle(bundlePath, expectedRole, expectedIdentity) {
	let bytes;
	try {
		bytes = readFileSync(bundlePath);
	} catch (error) {
		fail(`bundle unreadable: ${error.message}`);
	}
	const marker = Buffer.from("═══ RULE SOURCE [", "utf8");
	const bodyOffset = bytes.indexOf(marker);
	if (bodyOffset < 0) fail("no rule sections found");
	const header = bytes.subarray(0, bodyOffset).toString("utf8");
	const body = bytes.subarray(bodyOffset);
	if (!header.startsWith("# Flywheel Lead Rules Bundle (FLY-1402)\n"))
		fail("missing FLY-1402 bundle header");

	const sentinel = header.match(/^RULES_BUNDLE_SHA=([^ ]+) FILES=([0-9]+)$/m);
	if (!sentinel) fail("malformed RULES_BUNDLE_SHA/FILES sentinel");
	const declaredSha = sentinel[1];
	const declaredFiles = Number.parseInt(sentinel[2], 10);
	const degraded = declaredSha === "unavailable";
	if (!degraded) {
		if (!/^[a-f0-9]{64}$/.test(declaredSha)) fail("bundle SHA is malformed");
		const actualSha = createHash("sha256").update(body).digest("hex");
		if (declaredSha !== actualSha)
			fail(`bundle SHA mismatch: declared=${declaredSha} actual=${actualSha}`);
	}

	const metadata = header.match(
		/^ROLE=([^ ]+) LEAD_ID=([^ ]+) PROJECT=([^ ]+) GENERATED_AT=([^ ]+)$/m,
	);
	if (!metadata) fail("malformed role metadata");
	const role = metadata[1];
	const lead = metadata[2];
	const project = metadata[3];
	if (role !== expectedRole)
		fail(`role mismatch: header=${role} expected=${expectedRole}`);
	if (
		expectedIdentity &&
		(lead !== expectedIdentity.lead || project !== expectedIdentity.project)
	)
		fail(
			`bundle identity mismatch: header=${project}/${lead} expected=${expectedIdentity.project}/${expectedIdentity.lead}`,
		);

	const manifests = [
		...header.matchAll(/^ {2}([0-9]+)\. ([^/]+)\/(.+) — (.+)$/gm),
	].map((match) => ({
		index: Number.parseInt(match[1], 10),
		label: match[2],
		basename: match[3],
		path: match[4],
	}));
	const bodyText = body.toString("utf8");
	const sections = [
		...bodyText.matchAll(
			/^═══ RULE SOURCE \[([0-9]+)\/([0-9]+)\]: ([^/]+)\/(.+) ═══$/gm,
		),
	].map((match) => ({
		index: Number.parseInt(match[1], 10),
		total: Number.parseInt(match[2], 10),
		label: match[3],
		basename: match[4],
	}));

	if (declaredFiles !== manifests.length || declaredFiles !== sections.length)
		fail(
			`file count mismatch: FILES=${declaredFiles} manifest=${manifests.length} sections=${sections.length}`,
		);
	for (let i = 0; i < declaredFiles; i += 1) {
		const manifest = manifests[i];
		const section = sections[i];
		if (
			manifest.index !== i + 1 ||
			section.index !== i + 1 ||
			section.total !== declaredFiles ||
			manifest.label !== section.label ||
			manifest.basename !== section.basename
		)
			fail(`manifest/section mismatch at index ${i + 1}`);
	}

	let bodyCursor = 0;
	for (let i = 0; i < declaredFiles; i += 1) {
		const manifest = manifests[i];
		if (!manifest.path.startsWith("/"))
			fail(`manifest source path must be absolute at index ${i + 1}`);
		let source;
		try {
			source = readFileSync(manifest.path);
		} catch (error) {
			fail(`manifest source unreadable at index ${i + 1}: ${error.message}`);
		}
		const sectionHeader = Buffer.from(
			`═══ RULE SOURCE [${i + 1}/${declaredFiles}]: ${manifest.label}/${manifest.basename} ═══\n`,
			"utf8",
		);
		const separator = Buffer.from(source.at(-1) === 10 ? "\n" : "\n\n", "utf8");
		const expectedSection = Buffer.concat([sectionHeader, source, separator]);
		const actualSection = body.subarray(
			bodyCursor,
			bodyCursor + expectedSection.length,
		);
		if (!actualSection.equals(expectedSection))
			fail(`source content mismatch at index ${i + 1}`);
		bodyCursor += expectedSection.length;
	}
	if (bodyCursor !== body.length)
		fail(`source content mismatch after index ${declaredFiles}`);
	verifyRole(
		expectedRole,
		manifests.map((entry) => entry.basename),
	);
	return {
		role,
		lead,
		project,
		files: declaredFiles,
		sha: declaredSha,
		manifests,
		degraded,
	};
}

function verifyCarrier(project, lead) {
	const manifestDir =
		process.env.FLYWHEEL_RULES_TRUTH_MANIFEST_DIR ??
		join(process.env.HOME ?? "", ".flywheel", "manifests");
	const manifestPath = join(manifestDir, `${project}-${lead}.json`);
	const manifest = readJson(manifestPath, "lead manifest");
	const raw = manifest?.leadBackend?.backendId;
	if (raw === undefined || raw === null || raw === "")
		return { backend: "claude-code", label: "defaulted" };
	if (raw === "claude-code") return { backend: raw, label: raw };
	if (raw === "codex-app-server")
		return { backend: raw, label: raw, skip: true };
	fail(`unknown lead carrier: ${String(raw)}`);
}

function loadProjectsTruth() {
	if (process.env.FLYWHEEL_PROJECTS) {
		try {
			const projects = JSON.parse(process.env.FLYWHEEL_PROJECTS);
			if (!Array.isArray(projects)) fail("FLYWHEEL_PROJECTS must be an array");
			return projects;
		} catch (error) {
			fail(`FLYWHEEL_PROJECTS is invalid: ${error.message}`);
		}
	}
	const projectsPath = join(
		process.env.HOME ?? "",
		".flywheel",
		"projects.json",
	);
	const projects = readJson(projectsPath, "projects truth");
	if (!Array.isArray(projects)) fail("projects truth must be an array");
	return projects;
}

function allLeadTruth() {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const gateCli =
		process.env.FLYWHEEL_RULES_TRUTH_GATE_CLI ??
		join(scriptDir, "..", "dist", "core-room-gate-cli.js");
	const probe = runProbe(process.execPath, [gateCli, "--all-leads"]);
	if (probe.status !== 0)
		fail(
			`core-room-gate --all-leads failed: ${probe.stderr.trim() || String(probe.error ?? probe.status)}`,
		);
	try {
		return probe.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		fail(`core-room-gate --all-leads returned invalid JSONL: ${error.message}`);
	}
}

function deriveExpectedRole(projectName, leadId, gateEntries = allLeadTruth()) {
	const projects = loadProjectsTruth();
	const project = projects.find((entry) => entry?.projectName === projectName);
	const lead = project?.leads?.find((entry) => entry?.agentId === leadId);
	if (!project || !lead)
		fail(`projects truth has no such Lead: ${projectName}/${leadId}`);
	if (lead.external === true) return "external";
	if (lead.companion === true) return "companion";
	const gate = gateEntries.find(
		(entry) => entry?.projectName === projectName && entry?.leadId === leadId,
	);
	if (!gate) fail(`core-room truth has no such Lead: ${projectName}/${leadId}`);
	return gate.isCoS === true ? "cos" : "dept";
}

function deriveExpectedMode(args) {
	if (args.expect_mode !== undefined) return args.expect_mode;
	if (!args.expected) return "bundle";
	const inventory = readJson(args.expected, "wave inventory");
	if (!Array.isArray(inventory)) fail("wave inventory must be an array");
	for (const entry of inventory) {
		if (!entry || typeof entry !== "object")
			fail("wave inventory entries must be objects");
		if (entry.mode !== "bundle" && entry.mode !== "legacy")
			fail(`wave inventory has invalid mode: ${String(entry.mode)}`);
	}
	return (
		inventory.find(
			(entry) => entry.project === args.project && entry.leadId === args.lead,
		)?.mode ?? "bundle"
	);
}

function verifySelectedSources(receipt, expectedRole) {
	if (!Array.isArray(receipt.selectedSources))
		fail("receipt selectedSources must be an array");
	if (
		!Number.isInteger(receipt.files) ||
		receipt.files !== receipt.selectedSources.length
	)
		fail(
			`receipt files mismatch: files=${String(receipt.files)} selectedSources=${receipt.selectedSources.length}`,
		);
	for (const [index, source] of receipt.selectedSources.entries()) {
		if (
			!source ||
			typeof source.label !== "string" ||
			typeof source.basename !== "string" ||
			typeof source.path !== "string"
		)
			fail(`invalid selectedSources entry at index ${index + 1}`);
		if (!source.path.startsWith("/"))
			fail(`selectedSources path must be absolute at index ${index + 1}`);
		if (basename(source.path) !== source.basename)
			fail(`selectedSources basename/path mismatch at index ${index + 1}`);
	}
	verifyRole(
		expectedRole,
		receipt.selectedSources.map((source) => source.basename),
	);
}

function verifyBundleReceipt(receipt, expectedRole, expectedIdentity) {
	if (typeof receipt.bundlePath !== "string" || receipt.bundlePath.length === 0)
		fail("bundle receipt missing bundlePath");
	const bundle = verifyBundle(
		receipt.bundlePath,
		expectedRole,
		expectedIdentity,
	);
	if (receipt.sha !== bundle.sha)
		fail(
			`receipt SHA mismatch: receipt=${String(receipt.sha)} bundle=${bundle.sha}`,
		);
	if (receipt.files !== bundle.files)
		fail(
			`receipt/bundle file count mismatch: ${receipt.files}/${bundle.files}`,
		);
	for (let i = 0; i < bundle.files; i += 1) {
		const claimed = receipt.selectedSources[i];
		const actual = bundle.manifests[i];
		if (
			claimed.label !== actual.label ||
			claimed.basename !== actual.basename ||
			claimed.path !== actual.path
		)
			fail(`receipt/header manifest mismatch at index ${i + 1}`);
	}
	if (
		!Array.isArray(receipt.appendTargets) ||
		receipt.appendTargets.length !== 1 ||
		receipt.appendTargets[0] !== receipt.bundlePath
	)
		fail("bundle receipt appendTargets must contain only bundlePath");
	return bundle;
}

function verifyLegacyReceipt(receipt) {
	if (receipt.bundlePath !== null && receipt.bundlePath !== "")
		fail("legacy receipt bundlePath must be empty");
	if (!Array.isArray(receipt.appendTargets))
		fail("legacy receipt appendTargets must be an array");
	const selectedPaths = receipt.selectedSources.map((source) => source.path);
	if (JSON.stringify(receipt.appendTargets) !== JSON.stringify(selectedPaths))
		fail(
			"legacy receipt appendTargets must equal selectedSources paths in order",
		);
}

function processTreeRows(text) {
	const rows = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/);
		if (!match) continue;
		rows.push({
			pid: Number.parseInt(match[1], 10),
			ppid: Number.parseInt(match[2], 10),
			command: match[3],
		});
	}
	return rows;
}

function descendantPids(rows, rootPid) {
	const descendants = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
				descendants.add(row.pid);
				changed = true;
			}
		}
	}
	return descendants;
}

function isClaudeAgent(command, lead) {
	const tokens = command.trim().split(/\s+/);
	const hasClaude = tokens.some((token) => token.split("/").pop() === "claude");
	const agentIndex = tokens.indexOf("--agent");
	return hasClaude && agentIndex >= 0 && tokens[agentIndex + 1] === lead;
}

function appendTargetsFromCommand(command) {
	const tokens = command.trim().split(/\s+/);
	const targets = [];
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i] === "--append-system-prompt-file") {
			if (i + 1 >= tokens.length)
				fail("append-system-prompt-file missing value");
			targets.push(tokens[i + 1]);
			i += 1;
		}
	}
	return targets;
}

function statusResult(status, fields, reason) {
	const suffix = Object.entries(fields)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
	process.stdout.write(
		`${status}${suffix ? ` ${suffix}` : ""}${reason ? ` reason=${reason}` : ""}\n`,
	);
}

function verifyLead(args) {
	if (!args.lead || !args.project)
		usage("Lead mode requires --lead and --project");
	const expectedRole =
		args.expect_role ?? deriveExpectedRole(args.project, args.lead);
	const expectedMode = deriveExpectedMode(args);
	if (expectedMode !== "bundle" && expectedMode !== "legacy")
		usage("--expect-mode must be bundle or legacy");

	const carrier = verifyCarrier(args.project, args.lead);
	if (carrier.skip) {
		statusResult(
			"SKIP",
			{
				project: args.project,
				lead: args.lead,
				carrier: carrier.backend,
			},
			"carrier-not-claude-cli",
		);
		return { status: "SKIP", exitCode: 0 };
	}

	const stateDir =
		process.env.FLYWHEEL_RULES_TRUTH_STATE_DIR ??
		join(process.env.HOME ?? "", ".flywheel", "lead-rules-bundles");
	const receiptPath = join(
		stateDir,
		`${args.project}-${args.lead}.active.json`,
	);
	const receipt = readJson(receiptPath, "active rules receipt");
	if (receipt.role !== expectedRole)
		fail(
			`receipt role mismatch: receipt=${String(receipt.role)} expected=${expectedRole}`,
		);
	if (receipt.mode !== expectedMode)
		fail(
			`receipt mode mismatch: receipt=${String(receipt.mode)} expected=${expectedMode}`,
		);
	verifySelectedSources(receipt, expectedRole);
	let bundleResult;
	if (receipt.mode === "bundle")
		bundleResult = verifyBundleReceipt(receipt, expectedRole, {
			lead: args.lead,
			project: args.project,
		});
	else verifyLegacyReceipt(receipt);
	if (bundleResult?.degraded)
		return {
			status: "DEGRADED",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};

	if (!Number.isInteger(receipt.pid) || receipt.pid <= 0)
		fail("invalid receipt pid");
	if (
		receipt.supervisorStart === null &&
		typeof receipt.generationNonce === "string" &&
		receipt.generationNonce.length > 0
	)
		return {
			status: "DEGRADED",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};
	if (typeof receipt.supervisorStart !== "string" || !receipt.supervisorStart)
		fail("receipt missing supervisorStart");
	const ps = process.env.FLYWHEEL_RULES_TRUTH_PS ?? "ps";
	const psEnv = { ...process.env, LC_ALL: "C" };
	const startProbe = runProbe(
		ps,
		["-p", String(receipt.pid), "-o", "lstart="],
		{ env: psEnv },
	);
	if (
		startProbe.status !== 0 ||
		startProbe.stdout.trim() !== receipt.supervisorStart
	)
		return { status: "STALE", exitCode: args.strict ? 1 : 0, carrier, receipt };

	const tmux = process.env.FLYWHEEL_RULES_TRUTH_TMUX ?? "tmux";
	const paneProbe = runProbe(tmux, [
		"list-panes",
		"-t",
		`=flywheel:=${args.project}-${args.lead}`,
		"-F",
		"#{pane_pid}\t#{pane_dead}",
	]);
	if (paneProbe.status !== 0)
		return {
			status: "STATIC_ONLY",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};
	const livePanes = paneProbe.stdout
		.trim()
		.split("\n")
		.map((line) => line.split("\t"))
		.filter(([pid, dead]) => /^[0-9]+$/.test(pid ?? "") && dead === "0");
	if (livePanes.length !== 1)
		return {
			status: "STATIC_ONLY",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};

	const treeProbe = runProbe(ps, ["-axo", "pid=,ppid=,command="], {
		env: psEnv,
	});
	if (treeProbe.status !== 0)
		return {
			status: "STATIC_ONLY",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};
	const rows = processTreeRows(treeProbe.stdout);
	const descendants = descendantPids(
		rows,
		Number.parseInt(livePanes[0][0], 10),
	);
	const candidates = rows.filter(
		(row) => descendants.has(row.pid) && isClaudeAgent(row.command, args.lead),
	);
	if (candidates.length !== 1)
		return {
			status: "STATIC_ONLY",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};

	const safeTarget = /^[A-Za-z0-9._/-]+$/;
	if (!receipt.appendTargets.every((target) => safeTarget.test(target)))
		return {
			status: "AMBIGUOUS",
			exitCode: args.strict ? 1 : 0,
			carrier,
			receipt,
		};
	const actualTargets = appendTargetsFromCommand(candidates[0].command);
	if (JSON.stringify(actualTargets) !== JSON.stringify(receipt.appendTargets))
		fail(
			`live appendTargets mismatch: expected=${JSON.stringify(receipt.appendTargets)} actual=${JSON.stringify(actualTargets)}`,
		);
	return {
		status: receipt.mode === "legacy" ? "LEGACY_EXPECTED" : "PASS",
		exitCode: 0,
		carrier,
		receipt,
	};
}

function verifyAll(args) {
	const gateEntries = allLeadTruth();
	let exitCode = 0;
	for (const entry of gateEntries) {
		const localArgs = {
			...args,
			all: false,
			project: entry.projectName,
			lead: entry.leadId,
			expect_role: deriveExpectedRole(
				entry.projectName,
				entry.leadId,
				gateEntries,
			),
		};
		try {
			const result = verifyLead(localArgs);
			if (result.status !== "SKIP") {
				statusResult(result.status, {
					project: localArgs.project,
					lead: localArgs.lead,
					mode: result.receipt.mode,
					role: result.receipt.role,
					carrier: result.carrier.label,
				});
			}
			if (result.exitCode !== 0) exitCode = 1;
		} catch (error) {
			statusResult(
				"FAIL",
				{ project: localArgs.project, lead: localArgs.lead },
				error.message,
			);
			exitCode = 1;
		}
	}
	return exitCode;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	try {
		if (args.bundle_file) {
			if (!args.expect_role) usage("--bundle-file requires --expect-role");
			const result = verifyBundle(args.bundle_file, args.expect_role);
			if (result.degraded) {
				statusResult(
					"DEGRADED",
					{
						bundle: args.bundle_file,
						role: result.role,
						files: result.files,
						sha: result.sha,
					},
					"sha-unavailable",
				);
				process.exitCode = args.strict ? 1 : 0;
			} else {
				process.stdout.write(
					`PASS bundle=${args.bundle_file} role=${result.role} files=${result.files} sha=${result.sha}\n`,
				);
			}
			return;
		}
		if (args.all) {
			process.exitCode = verifyAll(args);
			return;
		}
		const result = verifyLead(args);
		if (result.status !== "SKIP") {
			statusResult(result.status, {
				project: args.project,
				lead: args.lead,
				mode: result.receipt.mode,
				role: result.receipt.role,
				carrier: result.carrier.label,
			});
		}
		process.exitCode = result.exitCode;
	} catch (error) {
		const target = args.bundle_file
			? `bundle=${args.bundle_file}`
			: `project=${String(args.project)} lead=${String(args.lead)}`;
		process.stdout.write(`FAIL ${target} reason=${error.message}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main();
