#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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
	validateModelConfigDocument,
	withModelAuthorityLock,
} from "../packages/config/dist/index.js";

function parseArgs(args) {
	const [command, ...rest] = args;
	if (!["set", "show"].includes(command))
		throw new Error(
			"usage: design-model-split.mjs show | set --codex-percent NUMBER [--config PATH]",
		);
	const opts = {};
	for (let i = 0; i < rest.length; i += 2) {
		const key = rest[i],
			value = rest[i + 1];
		if (
			!["--config", "--codex-percent"].includes(key) ||
			key in opts ||
			value === undefined ||
			value.startsWith("--") ||
			!value.trim()
		)
			throw new Error(`invalid, duplicate or missing option: ${key}`);
		opts[key] = value;
	}
	if (command === "show" && "--codex-percent" in opts)
		throw new Error("show does not accept --codex-percent");
	if (
		command === "set" &&
		(!("--codex-percent" in opts) ||
			!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(
				opts["--codex-percent"],
			))
	)
		throw new Error("set requires a finite percentage from 0 to 100");
	const percent = Number(opts["--codex-percent"]);
	if (
		command === "set" &&
		(!Number.isFinite(percent) || percent < 0 || percent > 100)
	)
		throw new Error("percentage must be from 0 to 100");
	return {
		command,
		percent,
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
		sourcePath: path,
		ruleVersion: policy?.version ?? "fly2403-v1",
		codexPercent,
		fablePercent: 100 - codexPercent,
		source: policy ? "runtime" : "registry v1 parity fallback",
		appliesTo:
			"code.eng_design; next new workflow admission; existing assignments stay frozen",
	};
}
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "show") {
		const path = canonicalModelAuthorityPath(args.path);
		return describe(path, readAuthority(path));
	}
	return withModelAuthorityLock(args.path, async (path) => {
		const document = readAuthority(path);
		const policy = parsePercentageModelSplit({
			enabled: true,
			rule: "issue_number_percentage",
			codexPercent: args.percent,
			codex: { arm: "A", model: "astra" },
			fable: { arm: "B", model: "fable" },
		});
		const { version, ...input } = policy;
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
			if (result.ruleVersion !== version)
				throw new Error("candidate verification failed");
			renameSync(temp, path);
			return result;
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
