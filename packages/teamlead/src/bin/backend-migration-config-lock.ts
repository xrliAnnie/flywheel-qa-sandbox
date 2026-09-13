import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Existing Python flock owns the FD; its short-lived latch child keeps it held
 * only while the parent performs synchronous file CAS. Never run lifecycle work here.
 */
export async function withMigrationConfigLock(
	input: { home: string; root: string; assertWindow(): void },
	transaction: (assertHeld: () => void) => void,
): Promise<void> {
	input.assertWindow();
	if (!isAbsolute(input.home) || !isAbsolute(input.root))
		throw Error("invalid migration lock path");
	const helper = join(input.root, "scripts/flywheel-config-lock.py");
	const stat = lstatSync(helper);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw Error("unsafe migration lock helper");
	const latch =
		'process.stdout.write("held:"+process.pid+String.fromCharCode(10)); process.stdin.resume();';
	await new Promise<void>((resolve, reject) => {
		const child = spawn("python3", [helper, process.execPath, "-e", latch], {
			env: {
				...process.env,
				CONFIG_LOCK_FILE: join(input.home, ".flywheel/projects.json.cfglock"),
				CONFIG_LOCK_DEADLINE: "5",
			},
			stdio: ["pipe", "pipe", "ignore"],
		});
		let buffer = "",
			entered = false,
			finished = false,
			failure: unknown;
		const timer = setTimeout(() => {
			failure ??= Error("migration config lock timed out");
			child.stdin.end();
			child.kill("SIGTERM");
		}, 15_000);
		const finish = (error?: unknown) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		child.on("error", () => finish(Error("migration config lock unavailable")));
		child.stdin.on("error", () => {
			failure ??= Error("migration config lock channel closed");
		});
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			if (entered || !buffer.includes("\n")) return;
			entered = true;
			try {
				const match = /^held:([1-9][0-9]*)\n$/.exec(buffer);
				if (!match || !child.pid)
					throw Error("migration config lock handshake invalid");
				const latchPid = Number(match[1]);
				const assertHeld = () => {
					input.assertWindow();
					if (child.exitCode !== null || child.signalCode !== null)
						throw Error("migration config lock exited");
					process.kill(child.pid!, 0);
					process.kill(latchPid, 0);
				};
				assertHeld();
				transaction(assertHeld);
				assertHeld();
			} catch (error) {
				failure = error;
			}
			child.stdin.end();
		});
		child.on("close", (code) =>
			finish(
				failure ??
					(code === 0 && entered
						? undefined
						: Error("migration config lock failed")),
			),
		);
	});
}
