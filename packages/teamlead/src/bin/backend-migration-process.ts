import { execFile } from "node:child_process";

export class MigrationCarrierAbsentError extends Error {
	constructor() {
		super("migration carrier job absent");
	}
}

async function probe(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				encoding: "utf8",
				timeout: 1000,
				maxBuffer: 64 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			},
			(error, stdout, stderr) => {
				if (
					error &&
					file === "/bin/launchctl" &&
					typeof error.code === "number" &&
					!error.killed &&
					!error.signal &&
					/could not find service|no such process/i.test(`${stdout}\n${stderr}`)
				)
					reject(new MigrationCarrierAbsentError());
				else if (error) reject(new Error("migration carrier probe failed"));
				else resolve(stdout.trim());
			},
		);
	});
}
/** Basic launchd/carrier observation only; caller must match argv and canonical identity.
 * No nudge, signal, process environment dump or business action is performed.
 */
export async function observeMigrationCarrier(
	uid: number,
): Promise<{ pid: number; start: string; command: string }> {
	if (!Number.isSafeInteger(uid) || uid < 0)
		throw new Error("invalid migration uid");
	const label = `gui/${uid}/com.flywheel.lead.flywheel-flywheel-product-lead`;
	const launchPid = async () => {
		const text = await probe("/bin/launchctl", ["print", label]);
		const states = [...text.matchAll(/^\s*state = (\S+)\s*$/gm)];
		const pids = [...text.matchAll(/^\s*pid = (\d+)\s*$/gm)];
		const pid = Number(pids[0]?.[1]);
		if (
			states.length !== 1 ||
			states[0]?.[1] !== "running" ||
			pids.length !== 1 ||
			!Number.isSafeInteger(pid) ||
			pid <= 0
		)
			throw new Error("migration carrier unproven");
		return pid;
	};
	const pid = await launchPid();
	const read = (field: string) =>
		probe("/bin/ps", ["-p", String(pid), "-o", `${field}=`]);
	const start = await read("lstart");
	const command = await read("command");
	if (!start || !command || /[\r\n\0]/.test(start + command))
		throw new Error("migration carrier unproven");
	if (
		(await launchPid()) !== pid ||
		(await read("lstart")) !== start ||
		(await read("command")) !== command
	)
		throw new Error("migration carrier changed");
	return { pid, start, command };
}
