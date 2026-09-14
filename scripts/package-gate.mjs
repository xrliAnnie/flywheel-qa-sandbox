const RPC_MESSAGE = '[vitest-worker]: Timeout calling "onTaskUpdate"';

export function classifyAttempt(exitCode, signal, receipt) {
	if (signal) return "failed";
	if (exitCode === 0) return "passed";
	if (
		exitCode !== 1 ||
		!receipt ||
		receipt.schemaVersion !== 1 ||
		receipt.complete !== true ||
		!["passed", "failed"].includes(receipt.reason) ||
		receipt.failed !== 0 ||
		!Number.isInteger(receipt.passed) ||
		receipt.passed <= 0 ||
		receipt.files !== receipt.expectedFiles ||
		receipt.files <= 0 ||
		!Array.isArray(receipt.errors) ||
		receipt.errors.length === 0 ||
		!receipt.errors.every((error) => error?.message === RPC_MESSAGE)
	)
		return "failed";
	return "worker_rpc_timeout";
}

export function summarizeRun(statuses) {
	if (!statuses.length || statuses.includes("failed"))
		return { status: "failed", exitCode: 1 };
	if (statuses.includes("worker_rpc_timeout"))
		return { status: "artifact", exitCode: 2 };
	return { status: "passed", exitCode: 0 };
}

import { execFileSync, spawn } from "node:child_process";
import {
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
function execute(command, args, { root, log, env, quiet }) {
	return new Promise((resolveResult) => {
		const startedAt = new Date().toISOString();
		const output = createWriteStream(log);
		const child = spawn(command, args, {
			cwd: root,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let spawnError;
		for (const [stream, target] of [
			[child.stdout, process.stdout],
			[child.stderr, process.stderr],
		]) {
			stream.on("data", (chunk) => {
				output.write(chunk);
				if (!quiet) target.write(chunk);
			});
		}
		child.on("error", (error) => {
			spawnError = error.message;
			output.write(`${error.message}\n`);
		});
		child.on("close", (exitCode, signal) =>
			output.end(() =>
				resolveResult({
					command: [command, ...args],
					startedAt,
					finishedAt: new Date().toISOString(),
					exitCode,
					signal,
					spawnError,
					log,
				}),
			),
		);
	});
}
function readReceipt(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function readManifest(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

export async function runGate({
	root = resolve(scriptDirectory, ".."),
	pnpm = "pnpm",
	receiptRoot = tmpdir(),
	quiet = false,
} = {}) {
	mkdirSync(receiptRoot, { recursive: true });
	const directory = mkdtempSync(join(receiptRoot, "flywheel-package-gate-"));
	let head = null;
	try {
		head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		/* fixtures can be outside git */
	}
	const summary = {
		schemaVersion: 1,
		directory,
		root,
		head,
		startedAt: new Date().toISOString(),
		packages: [],
	};
	const save = () =>
		writeFileSync(
			join(directory, "summary.json"),
			`${JSON.stringify(summary, null, 2)}\n`,
		);
	const finish = (result) => {
		Object.assign(summary, result, { finishedAt: new Date().toISOString() });
		save();
		if (!quiet)
			console.log(`PACKAGE_GATE_RECEIPT=${join(directory, "summary.json")}`);
		return summary;
	};
	save();
	summary.build = await execute(pnpm, ["-r", "build"], {
		root,
		log: join(directory, "build.log"),
		quiet,
	});
	save();
	if (summary.build.exitCode !== 0 || summary.build.signal)
		return finish({ status: "failed", exitCode: 1 });
	const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) =>
			readManifest(join(root, "packages", entry.name, "package.json")),
		)
		.filter((pkg) => pkg?.scripts?.["test:run"])
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const [index, pkg] of packages.entries()) {
		const row = {
			name: pkg.name,
			script: pkg.scripts["test:run"],
			status: "failed",
			attempts: [],
		};
		summary.packages.push(row);
		const vitest = /^vitest run(?:\s|$)/.test(row.script);
		for (let attempt = 1; attempt <= 2; attempt++) {
			const report = join(directory, `${index}-${attempt}.json`);
			const args = ["--filter", pkg.name, "test:run"];
			if (vitest)
				args.push(
					"--reporter=default",
					`--outputFile=${report}`,
					`--reporter=${join(scriptDirectory, "package-gate-reporter.mjs")}`,
				);
			const result = await execute(pnpm, args, {
				root,
				log: join(directory, `${index}-${attempt}.log`),
				quiet,
				env: {
					VITEST_MAX_FORKS: "1",
					VITEST_MIN_FORKS: "1",
				},
			});
			result.receipt = vitest ? readReceipt(report) : null;
			result.status = classifyAttempt(
				result.exitCode,
				result.signal,
				result.receipt,
			);
			row.attempts.push(result);
			row.status = result.status;
			save();
			if (result.status !== "worker_rpc_timeout") break;
		}
	}
	return finish(summarizeRun(summary.packages.map((pkg) => pkg.status)));
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	runGate()
		.then((result) => {
			process.exitCode = result.exitCode;
		})
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}
