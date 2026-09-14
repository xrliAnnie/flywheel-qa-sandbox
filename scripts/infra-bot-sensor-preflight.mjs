import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Read-only admission check; never suppress a down signal after activation.
export async function preflight(
	label,
	{
		probe = async (target) =>
			(
				await execFileAsync("launchctl", ["print", target], {
					timeout: 10_000,
				})
			).stdout,
		wait = setTimeout,
	} = {},
) {
	if (
		typeof label !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)
	) {
		throw new Error("expected one bare launchd job label");
	}
	const target = `gui/${process.getuid()}/${label}`;
	let previous;
	for (let sample = 0; sample < 2; sample++) {
		if (sample) await wait(35_000); // Production KeepAlive throttle is 30s.
		const stdout = await probe(target);
		// launchctl top-level fields have exactly one tab; ignore nested states.
		const field = (key) => {
			const matches = [
				...stdout.matchAll(new RegExp(`^\\t${key} = ([^\\r\\n]+)$`, "gm")),
			];
			return matches.length === 1 ? matches[0][1].trim() : undefined;
		};
		const state = field("state");
		if (state !== "running") {
			throw new Error(
				`not running: ${state ?? "unknown"}; last exit code=${field("last exit code") ?? "unknown"}; possible KeepAlive crash-loop`,
			);
		}
		const pid = field("pid");
		const runs = field("runs");
		if (![pid, runs].every((value) => /^[1-9]\d*$/.test(value ?? ""))) {
			throw new Error(
				"cannot establish stability: missing/invalid pid or runs",
			);
		}
		if (previous && (previous.pid !== pid || previous.runs !== runs)) {
			throw new Error(
				"job restarted during 35s preflight; possible KeepAlive crash-loop",
			);
		}
		previous = { pid, runs };
	}
	return { target, ...previous };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		if (process.argv.length !== 3)
			throw new Error("expected one bare launchd job label");
		const result = await preflight(process.argv[2]);
		console.log(
			`PASS: ${result.target} stable for 35s; pid=${result.pid} runs=${result.runs}`,
		);
		console.log(`FLYWHEEL_CODEX_INFRA_BOT_JOB=${process.argv[2]}`);
	} catch (error) {
		console.error(`REFUSED: ${error.message}; do not enable the sensor`);
		process.exitCode = 1;
	}
}
