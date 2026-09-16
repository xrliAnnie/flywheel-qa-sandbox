import { execFileSync } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Host-only evidence. ps(1) flags are hexadecimal sys/proc.h flags:
// P_TRANSLATED=0x00020000. A non-translated process on arm64 is native.
export function parseChromeObservation(pid, output, qaRoot, hostArch) {
	const profile = output.match(/ --user-data-dir=(.*?)(?=\s--|$)/)?.[1];
	if (!profile) return null;
	const rel = relative(qaRoot, profile);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
		return null;
	const match = output.trim().match(/^([\da-f]+)\s+(.+)$/i);
	if (!match || !/^\d+$/.test(pid) || !match[2].startsWith(`${chrome} `))
		throw new Error("chrome_process_observation_invalid");
	if (hostArch !== "arm64") throw new Error("chrome_host_arch_unproven");
	if ((Number.parseInt(match[1], 16) & 0x00020000) !== 0)
		throw new Error("chrome_process_translated");
	if (/\s--headless(?:[=\s]|$)/.test(match[2]))
		throw new Error("chrome_process_headless");
	return { pid: Number(pid), flags: match[1], translated: false, headed: true };
}

export function verifyNativeHeadedChrome(qaRoot) {
	const read = (args) =>
		execFileSync("/bin/ps", args, {
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 1024 * 1024,
		});
	const processes = read(["-ww", "-axo", "pid=,comm="]);
	const observations = [];
	for (const line of processes.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(.+)$/);
		if (!match || match[2] !== chrome) continue;
		const observed = parseChromeObservation(
			match[1],
			read(["-ww", "-p", match[1], "-o", "flags=,args="]),
			qaRoot,
			process.arch,
		);
		if (observed) observations.push(observed);
	}
	if (observations.length !== 1)
		throw new Error("chrome_process_identity_unproven");
	return observations[0];
}
