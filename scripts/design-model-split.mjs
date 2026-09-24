#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	canonicalModelAuthorityPath,
	parsePercentageModelSplit,
	parseWeightedModelSplit,
	validateModelConfigDocument,
	withModelAuthorityLock,
} from "../packages/config/dist/index.js";

function parseArgs(args) {
	const [command, ...rest] = args;
	if (!["set", "show"].includes(command))
		throw new Error(
			"usage: design-model-split.mjs show | set (--codex-percent NUMBER | --policy-file PATH) [--config PATH]",
		);
	const opts = {};
	for (let i = 0; i < rest.length; i += 2) {
		const key = rest[i],
			value = rest[i + 1];
		if (
			!["--config", "--codex-percent", "--policy-file"].includes(key) ||
			key in opts ||
			value === undefined ||
			value.startsWith("--") ||
			!value.trim()
		)
			throw new Error(`invalid, duplicate or missing option: ${key}`);
		opts[key] = value;
	}
	if (
		command === "show" &&
		("--codex-percent" in opts || "--policy-file" in opts)
	)
		throw new Error("show does not accept a mutation option");
	if (
		command === "set" &&
		"--codex-percent" in opts === "--policy-file" in opts
	)
		throw new Error(
			"set requires exactly one of --codex-percent or --policy-file",
		);
	if (
		command === "set" &&
		"--codex-percent" in opts &&
		!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(
			opts["--codex-percent"],
		)
	)
		throw new Error("set requires a finite percentage from 0 to 100");
	const percent = Number(opts["--codex-percent"]);
	if (
		command === "set" &&
		"--codex-percent" in opts &&
		(!Number.isFinite(percent) || percent < 0 || percent > 100)
	)
		throw new Error("percentage must be from 0 to 100");
	return {
		command,
		percent,
		policyFile: opts["--policy-file"],
		path:
			opts["--config"] ??
			process.env.FLYWHEEL_MODELS_CONFIG ??
			join(homedir(), ".flywheel", "models.json"),
	};
}
function readAuthority(path) {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o777) !== 0o600 ||
			(process.getuid && stat.uid !== process.getuid())
		)
			throw new Error(
				`unsafe authority ${path}: require regular file owned by current uid with mode 0600`,
			);
	} catch (error) {
		if (error.code === "ENOENT") return { version: 1 };
		throw error;
	}
	const document = JSON.parse(readFileSync(path, "utf8"));
	validateModelConfigDocument(document);
	return document;
}
function describe(path, document) {
	const snapshot = validateModelConfigDocument(document);
	const policy = snapshot.modelSplit;
	if (policy && !policy.enabled)
		throw new Error(
			"model split is disabled; no effective ratio. Set a percentage to enable routing.",
		);
	const common = {
		sourcePath: path,
		ruleVersion: policy?.version ?? "fly2403-v1",
		authorityRevision: createHash("sha256")
			.update(JSON.stringify(document))
			.digest("hex"),
		source: policy ? "runtime" : "registry v1 parity fallback",
	};
	if (policy?.rule === "issue_node_weighted") {
		return {
			...common,
			rule: policy.rule,
			balance: policy.balance,
			nodes: Object.fromEntries(
				Object.entries(policy.nodes).map(([nodeId, arms]) => {
					const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
					return [
						nodeId,
						arms.map((arm) => ({
							...arm,
							percent: (arm.weight / total) * 100,
						})),
					];
				}),
			),
			appliesTo:
				"code/simple_code weighted nodes; next new workflow admission; existing assignments stay frozen",
		};
	}
	let codexPercent = 50;
	if (policy?.rule === "issue_number_percentage")
		codexPercent = policy.codexPercent;
	else if (policy) {
		const models = [policy.odd, policy.even].map((arm) =>
			snapshot.getDispatchCanonical(arm.model),
		);
		const astra = snapshot.getDispatchCanonical("astra");
		const fable = snapshot.getDispatchCanonical("fable");
		if (models.some((model) => model !== astra && model !== fable))
			throw new Error(
				"legacy policy is not an Astra/Fable split; inspect modelSplit mappings",
			);
		codexPercent = models.filter((model) => model === astra).length * 50;
	}
	return {
		...common,
		codexPercent,
		fablePercent: 100 - codexPercent,
		appliesTo:
			"code.eng_design; next new workflow admission; existing assignments stay frozen",
	};
}

function readPolicyFile(path, document) {
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("policy file must contain one modelSplit object");
	if (value.rule === "issue_node_weighted") {
		const { version, ...policy } = parseWeightedModelSplit(value);
		return { input: policy, expectedVersion: version };
	}
	if (value.rule === "issue_number_percentage") {
		const { version, ...policy } = parsePercentageModelSplit(value);
		return { input: policy, expectedVersion: version };
	}
	if (value.rule === "issue_number_parity") {
		const snapshot = validateModelConfigDocument({
			...document,
			modelSplit: value,
		});
		if (
			snapshot.runtimeModelSplitStatus !== "valid" ||
			snapshot.modelSplit?.rule !== "issue_number_parity"
		)
			throw new Error("invalid issue_number_parity policy file");
		return { input: value, expectedVersion: snapshot.modelSplit.version };
	}
	throw new Error(`unsupported modelSplit rule: ${value.rule}`);
}
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "show") {
		const path = canonicalModelAuthorityPath(args.path);
		return describe(path, readAuthority(path));
	}
	return withModelAuthorityLock(args.path, async (path) => {
		const document = readAuthority(path);
		const before =
			document.modelSplit?.enabled === false
				? {
						ruleVersion: document.modelSplit.version,
						authorityRevision: createHash("sha256")
							.update(JSON.stringify(document))
							.digest("hex"),
					}
				: describe(path, document);
		if (
			args.policyFile === undefined &&
			document.modelSplit?.rule === "issue_node_weighted"
		)
			throw new Error(
				"--codex-percent cannot replace issue_node_weighted; use --policy-file with a complete policy",
			);
		let input;
		let expectedVersion;
		if (args.policyFile !== undefined) {
			({ input, expectedVersion } = readPolicyFile(args.policyFile, document));
		} else {
			const policy = parsePercentageModelSplit({
				enabled: true,
				rule: "issue_number_percentage",
				codexPercent: args.percent,
				codex: { arm: "A", model: "astra" },
				fable: { arm: "B", model: "fable" },
			});
			expectedVersion = policy.version;
			const { version: _version, ...parsed } = policy;
			input = parsed;
		}
		const candidate = { ...document, modelSplit: input };
		validateModelConfigDocument(candidate);
		const temp = join(
			dirname(path),
			`.models.${process.pid}.${randomUUID()}.tmp`,
		);
		let fd;
		try {
			fd = openSync(
				temp,
				constants.O_CREAT |
					constants.O_EXCL |
					constants.O_WRONLY |
					constants.O_NOFOLLOW,
				0o600,
			);
			fchmodSync(fd, 0o600);
			writeFileSync(fd, `${JSON.stringify(candidate, null, 2)}\n`);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			// Validate the exact bytes that will become authoritative while holding the shared lock.
			const verified = readAuthority(temp);
			const result = describe(path, verified);
			if (expectedVersion && result.ruleVersion !== expectedVersion)
				throw new Error("candidate verification failed");
			renameSync(temp, path);
			return {
				...result,
				previousRuleVersion: before.ruleVersion,
				previousAuthorityRevision: before.authorityRevision,
			};
		} finally {
			if (fd !== undefined) closeSync(fd);
			rmSync(temp, { force: true });
		}
	});
}
main()
	.then((result) => console.log(JSON.stringify(result, null, 2)))
	.catch((error) => {
		console.error(`design-model-split: ${error.message}`);
		process.exitCode = 1;
	});
