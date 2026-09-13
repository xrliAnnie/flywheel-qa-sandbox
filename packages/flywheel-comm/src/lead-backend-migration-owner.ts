import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

interface ProcessEvidence {
	ppid: number;
	start: string;
	command: string;
}
export interface MigrationRestartOwner {
	home: string;
	restartPid: number;
	restartStart: string;
	lockDev: number;
	lockIno: number;
	/** Trusted deployed script paths supplied by the source-only restart helper. */
	restartScript: string;
	updaterScript: string;
}
function fail(): never {
	throw new Error("migration restart owner unproven");
}
function inspectProcess(pid: number): ProcessEvidence | null {
	try {
		const query = (field: string) =>
			execFileSync("/bin/ps", ["-p", String(pid), "-o", `${field}=`], {
				encoding: "utf8",
				timeout: 1000,
				maxBuffer: 16384,
				env: { ...process.env, LC_ALL: "C" },
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		return {
			ppid: Number(query("ppid")),
			start: query("lstart"),
			command: query("command"),
		};
	} catch {
		return null;
	}
}
function scriptInvocation(
	command: string,
	script: string,
	args: string,
): boolean {
	// ps has no portable argv boundary format. Exact sanctioned shell invocation
	// avoids substring acceptance; ambiguous encodings fail closed.
	return ["/bin/bash", "bash"].some(
		(shell) => command === `${shell} ${script}${args}`,
	);
}
/** Additional provenance fence, not a replacement for updater's R4 admission rules. */
export function assertMigrationRestartOwner(
	input: MigrationRestartOwner,
	probes: {
		parentPid: number;
		process(pid: number): ProcessEvidence | null;
	} = { parentPid: process.ppid, process: inspectProcess },
): string {
	if (
		!isAbsolute(input.home) ||
		!isAbsolute(input.restartScript) ||
		!isAbsolute(input.updaterScript) ||
		!Number.isSafeInteger(input.restartPid) ||
		input.restartPid <= 1 ||
		!input.restartStart ||
		!Number.isSafeInteger(input.lockDev) ||
		!Number.isSafeInteger(input.lockIno)
	)
		return fail();
	const lockPath = join(input.home, ".flywheel/restart.lock.d");
	const lock = lstatSync(lockPath);
	if (
		!lock.isDirectory() ||
		lock.isSymbolicLink() ||
		lock.uid !== process.getuid?.() ||
		(lock.mode & 0o022) !== 0 ||
		lock.dev !== input.lockDev ||
		lock.ino !== input.lockIno
	)
		return fail();
	let pid = probes.parentPid;
	const seen = new Set<number>();
	for (let depth = 0; depth < 16 && pid !== input.restartPid; depth++) {
		if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) return fail();
		seen.add(pid);
		const ancestor = probes.process(pid);
		if (!ancestor) return fail();
		pid = ancestor.ppid;
	}
	if (pid !== input.restartPid) return fail();
	const owner = probes.process(pid);
	if (
		!owner ||
		owner.start !== input.restartStart ||
		!scriptInvocation(owner.command, input.restartScript, " --reason updater")
	)
		return fail();
	const updater = probes.process(owner.ppid);
	if (!updater || !scriptInvocation(updater.command, input.updaterScript, ""))
		return fail();
	// Recheck the tuple and lock after sampling the ancestry.
	const after = probes.process(pid);
	const lockAfter = lstatSync(lockPath);
	if (
		!after ||
		after.start !== owner.start ||
		after.command !== owner.command ||
		after.ppid !== owner.ppid ||
		lockAfter.dev !== lock.dev ||
		lockAfter.ino !== lock.ino ||
		lockAfter.isSymbolicLink()
	)
		return fail();
	return createHash("sha256")
		.update(
			JSON.stringify({
				pid,
				start: owner.start,
				updaterPid: owner.ppid,
				updaterStart: updater.start,
				lockDev: lock.dev,
				lockIno: lock.ino,
			}),
		)
		.digest("hex");
}
