import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

type Pin = { path: string; sha256: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null };
function checkPin(pin: Pin, executable: boolean) {
	const stat = lstatSync(pin.path);
	if (
		!isAbsolute(pin.path) ||
		normalize(pin.path) !== pin.path ||
		!stat.isFile() ||
		stat.nlink !== 1 ||
		(stat.mode & 0o022) !== 0 ||
		(executable && (stat.mode & 0o111) === 0) ||
		stat.size > (executable ? 256 * 1024 * 1024 : 64 * 1024) ||
		!/^[a-f0-9]{64}$/.test(pin.sha256) ||
		createHash("sha256").update(readFileSync(pin.path)).digest("hex") !==
			pin.sha256
	)
		throw Error();
}
/** Caller must first pass loadAuthorityConfig: it proves immutable root ancestry,
 * groups, policy and QA receipt. This adapter rechecks pins and current UID/GID.
 * Spawn is not readiness; private protocol/account checks remain mandatory. */
export async function startGuardedProviderProcess(options: {
	serviceUid: number;
	serviceGid: number;
	providerBinary: Pin;
	providerConfig: Pin;
}): Promise<{ pid: number; exited: Promise<Exit>; stop(): Promise<void> }> {
	try {
		if (
			!process.getuid ||
			!process.getgid ||
			process.getuid() === 0 ||
			process.getuid() !== options.serviceUid ||
			process.getgid() !== options.serviceGid
		)
			throw Error();
		checkPin(options.providerBinary, true);
		checkPin(options.providerConfig, false);
		const child = spawn(
			options.providerBinary.path,
			["-guarded-config", options.providerConfig.path],
			{
				cwd: "/",
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdio: "ignore",
				shell: false,
			},
		);
		let outcome: Exit | undefined;
		const exited = new Promise<Exit>((resolve) => {
			child.once("close", (code, signal) => {
				outcome = { code, signal };
				resolve(outcome);
			});
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		if (!child.pid) throw Error();
		let stopping: Promise<void> | undefined;
		return {
			pid: child.pid,
			exited,
			stop() {
				if (stopping) return stopping;
				stopping = (async () => {
					if (!outcome && child.exitCode === null && child.signalCode === null)
						child.kill("SIGTERM");
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						const result = await Promise.race([
							exited,
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(Error("provider_stop_unconfirmed")),
									20000,
								);
							}),
						]);
						if (result.code !== 0 || result.signal !== null)
							throw Error("provider_stop_unconfirmed");
					} finally {
						if (timer) clearTimeout(timer);
					}
				})();
				void stopping.catch(() => {
					stopping = undefined;
				});
				return stopping;
			},
		};
	} catch {
		throw Error("provider_process_unavailable");
	}
}
