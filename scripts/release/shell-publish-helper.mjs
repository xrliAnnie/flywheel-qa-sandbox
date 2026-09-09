#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { distTagForVersion } from "./lib/dist-tag.mjs";

const execFileAsync = promisify(execFile);
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SELF_DIR, "..", "..");
const SHELL_DIR = path.join(ROOT, "packages", "onboard-shell");
const CONTENT_GATE = path.join(
	SHELL_DIR,
	"__tests__",
	"onboard-shell-publish-gate.test.sh",
);
const NPM_CACHE = path.join(
	process.env.RUNNER_TEMP ?? os.tmpdir(),
	"flywheel-shell-publish-npm-cache",
);
const npmEnv = () => ({ ...process.env, npm_config_cache: NPM_CACHE });

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function appendOutput(name, value) {
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	}
}

function emit(result, outputs = {}) {
	console.log(JSON.stringify(result));
	for (const [name, value] of Object.entries(outputs))
		appendOutput(name, value);
}

function parseArgs(argv, { positionals = 0, valueFlags = [] } = {}) {
	const parsed = { positionals: [] };
	const seen = new Set();
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i];
		if (!value.startsWith("--")) {
			parsed.positionals.push(value);
			continue;
		}
		if (value.includes("="))
			throw new Error(`equals-form flag refused: ${value}`);
		const name = value.slice(2);
		if (!valueFlags.includes(name)) throw new Error(`unknown flag: ${value}`);
		if (seen.has(name)) throw new Error(`duplicate flag: ${value}`);
		seen.add(name);
		if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
			throw new Error(`${value} requires a value`);
		}
		parsed[name] = argv[++i];
	}
	if (parsed.positionals.length !== positionals) {
		throw new Error(`expected ${positionals} positional argument(s)`);
	}
	return parsed;
}

async function packageFromTarball(tarball) {
	const result = await execFileAsync(
		"tar",
		["-xOzf", tarball, "package/package.json"],
		{ encoding: "utf8" },
	);
	const pkg = JSON.parse(result.stdout);
	if (pkg.name !== "@flywheel-ai/onboard" || typeof pkg.version !== "string") {
		throw new Error(
			"tarball does not identify @flywheel-ai/onboard with a version",
		);
	}
	return pkg;
}

function exactInputs(args, pkg, tarball) {
	if (!fs.existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);
	if (!/^[0-9a-f]{64}$/.test(args["expect-sha"] ?? "")) {
		throw new Error("--expect-sha must be a lowercase sha256");
	}
	const tag = distTagForVersion(pkg.version);
	if (args["expect-tag"] !== tag) {
		throw new Error(
			`--expect-tag ${args["expect-tag"] ?? "<missing>"} does not match ${pkg.version} -> ${tag}`,
		);
	}
	const registry = new URL(args.registry).toString();
	const localSha = sha256(fs.readFileSync(tarball));
	if (localSha !== args["expect-sha"]) {
		return {
			tag,
			registry,
			localSha,
			conflict: "local tarball sha256 mismatch",
		};
	}
	return { tag, registry, localSha };
}

async function npmView(spec, field, registry) {
	const argv = ["view", spec];
	if (field) argv.push(field);
	argv.push("--json", "--registry", registry);
	try {
		const result = await execFileAsync("npm", argv, {
			encoding: "utf8",
			env: npmEnv(),
			maxBuffer: 4 * 1024 * 1024,
		});
		return { found: true, value: JSON.parse(result.stdout) };
	} catch (error) {
		const detail = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
		if (/\bE404\b/.test(detail)) return { found: false };
		throw new Error(`npm view failed closed: ${detail.trim()}`);
	}
}

async function inspectRegistry(pkg, inputs) {
	if (inputs.conflict) return { outcome: "conflict", reason: inputs.conflict };
	const published = await npmView(
		`${pkg.name}@${pkg.version}`,
		"dist.tarball",
		inputs.registry,
	);
	if (!published.found) return { outcome: "free" };
	if (typeof published.value !== "string" || !published.value) {
		return { outcome: "conflict", reason: "published tarball URL missing" };
	}
	const response = await fetch(published.value);
	if (!response.ok) {
		throw new Error(
			`registry tarball readback failed (HTTP ${response.status})`,
		);
	}
	const remoteSha = sha256(Buffer.from(await response.arrayBuffer()));
	const tags = await npmView(pkg.name, "dist-tags", inputs.registry);
	if (!tags.found || typeof tags.value !== "object" || tags.value === null) {
		return { outcome: "conflict", reason: "registry dist-tags missing" };
	}
	if (remoteSha !== inputs.localSha) {
		return {
			outcome: "conflict",
			reason: `registry sha256 ${remoteSha} != expected ${inputs.localSha}`,
		};
	}
	if (tags.value[inputs.tag] !== pkg.version) {
		return {
			outcome: "conflict",
			reason: `registry dist-tag ${inputs.tag} points to ${tags.value[inputs.tag] ?? "<missing>"}`,
		};
	}
	return { outcome: "idempotent" };
}

async function cmdPack(argv) {
	const args = parseArgs(argv, { valueFlags: ["out"] });
	if (!args.out) throw new Error("pack requires --out <dir>");
	const out = path.resolve(args.out);
	fs.mkdirSync(out, { recursive: true });
	const result = await execFileAsync(
		"npm",
		["pack", "--pack-destination", out, "--json"],
		{
			cwd: SHELL_DIR,
			encoding: "utf8",
			env: npmEnv(),
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	const records = JSON.parse(result.stdout);
	const filename = Array.isArray(records) ? records[0]?.filename : undefined;
	if (!filename) throw new Error("npm pack returned no filename");
	const tarball = path.resolve(out, filename);
	const pkg = await packageFromTarball(tarball);
	const packed = {
		tarball,
		sha: sha256(fs.readFileSync(tarball)),
		version: pkg.version,
		tag: distTagForVersion(pkg.version),
	};
	emit(packed, { tarball: packed.tarball, sha: packed.sha, tag: packed.tag });
}

async function cmdGate(argv) {
	const args = parseArgs(argv, { positionals: 1 });
	const tarball = path.resolve(args.positionals[0]);
	await execFileAsync("bash", [CONTENT_GATE, "--tarball", tarball], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	emit({ action: "gate", tarball, outcome: "passed" });
}

async function cmdPreflight(argv) {
	const args = parseArgs(argv, {
		positionals: 1,
		valueFlags: ["expect-sha", "expect-tag", "registry"],
	});
	const tarball = path.resolve(args.positionals[0]);
	const pkg = await packageFromTarball(tarball);
	const inputs = exactInputs(args, pkg, tarball);
	const result = await inspectRegistry(pkg, inputs);
	emit(
		{ action: "preflight", version: pkg.version, ...result },
		result.outcome === "conflict" ? {} : { outcome: result.outcome },
	);
	if (result.outcome === "conflict") {
		throw new Error(`registry conflict: ${result.reason}`);
	}
}

async function cmdVerify(argv) {
	const args = parseArgs(argv, {
		positionals: 1,
		valueFlags: ["expect-sha", "expect-tag", "registry"],
	});
	const tarball = path.resolve(args.positionals[0]);
	const pkg = await packageFromTarball(tarball);
	const inputs = exactInputs(args, pkg, tarball);
	const attempts = Number(process.env.FW_SHELL_VERIFY_ATTEMPTS ?? "12");
	const delayMs = Number(process.env.FW_SHELL_VERIFY_DELAY_MS ?? "15000");
	if (
		!Number.isInteger(attempts) ||
		attempts < 1 ||
		!Number.isFinite(delayMs) ||
		delayMs < 0
	) {
		throw new Error("invalid verify retry configuration");
	}
	let last = { outcome: "free", reason: "version not visible" };
	for (let attempt = 1; attempt <= attempts; attempt++) {
		last = await inspectRegistry(pkg, inputs);
		if (last.outcome === "idempotent") {
			emit({ action: "verify", version: pkg.version, outcome: "verified" });
			return;
		}
		if (attempt < attempts) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw new Error(
		`verify failed after publish: ${pkg.name}@${pkg.version} is not visible with the approved sha256 and dist-tag (${last.reason ?? last.outcome})`,
	);
}

async function main() {
	const [command, ...argv] = process.argv.slice(2);
	if (command === "pack") return cmdPack(argv);
	if (command === "gate") return cmdGate(argv);
	if (command === "preflight") return cmdPreflight(argv);
	if (command === "verify") return cmdVerify(argv);
	throw new Error("usage: shell-publish-helper.mjs pack|gate|preflight|verify");
}

main().catch((error) => {
	console.error(`[shell-publish-helper] ${error.message}`);
	process.exitCode = 1;
});
