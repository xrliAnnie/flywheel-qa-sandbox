import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface BrowserHostBaseline {
	chrome: {
		root: string;
		version: string;
		identifier: string;
		teamIdentifier: string;
	};
	node: { path: string; version: string; sha256: string };
	libnode: { path: string; sha256: string };
}
/** Explicit host baseline per Lead d090db17. Drift never refreshes this pin automatically. */
export const BROWSER_HOST_BASELINE = Object.freeze({
	chrome: Object.freeze({
		root: "/Applications/Google Chrome.app",
		version: "153.0.8010.37",
		identifier: "com.google.Chrome",
		teamIdentifier: "EQHXZ8M8AV",
	}),
	node: Object.freeze({
		path: "/opt/homebrew/Cellar/node/25.6.1/bin/node",
		version: "v25.6.1",
		sha256: "8b6a6d43e16ddc3cddaf1217fb75dbe7151e342e36317491bf3ef4a1ec5d4202",
	}),
	libnode: Object.freeze({
		path: "/opt/homebrew/Cellar/node/25.6.1/lib/libnode.141.dylib",
		sha256: "eba53ff748dff3e370155b4d6543b66f65419c2751b7bdc8b642ce092aff5e9c",
	}),
});
const denied = () => new Error("browser_host_identity_unverified");
function digest(path: string) {
	if (realpathSync(path) !== path) throw denied();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > 268435456) throw denied();
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(65536);
		let bytes = 0;
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, null);
			if (!n) break;
			bytes += n;
			if (bytes > 268435456) throw denied();
			hash.update(buffer.subarray(0, n));
		}
		const after = fstatSync(fd);
		if (
			bytes !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			throw denied();
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}
/** Parent-only pre-spawn identity check; no production profile or credential reads. */
export function verifyBrowserHostIdentity(
	input: {
		nodeExecutable: string;
		chromeExecutable: string;
	},
	baseline: BrowserHostBaseline = BROWSER_HOST_BASELINE,
) {
	try {
		const pin = structuredClone(baseline);
		if (
			realpathSync(input.nodeExecutable) !== pin.node.path ||
			realpathSync(input.chromeExecutable) !==
				join(pin.chrome.root, "Contents/MacOS/Google Chrome")
		)
			throw denied();
		const hashes = () => {
			if (
				digest(pin.node.path) !== pin.node.sha256 ||
				digest(pin.libnode.path) !== pin.libnode.sha256
			)
				throw denied();
		};
		hashes();
		const run = (command: string, args: string[], timeout = 15000) =>
			execFileSync(command, args, {
				encoding: "utf8",
				timeout,
				maxBuffer: 4096,
				stdio: ["ignore", "pipe", "pipe"],
				env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "en_US.UTF-8" },
			}).trim();
		const version = () =>
			run("/usr/libexec/PlistBuddy", [
				"-c",
				"Print :CFBundleShortVersionString",
				join(pin.chrome.root, "Contents/Info.plist"),
			]);
		const observedChromeVersion = version();
		if (!/^[0-9]+(?:\.[0-9]+){3}$/.test(observedChromeVersion)) throw denied();
		run("/usr/bin/codesign", ["--verify", "--deep", pin.chrome.root], 60000);

		const signature = spawnSync("/usr/bin/codesign", ["-dv", pin.chrome.root], {
			encoding: "utf8",
			timeout: 15000,
			maxBuffer: 4096,
			env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" },
		});
		if (signature.status !== 0 || signature.error) throw denied();
		const fields = (name: string) =>
			signature.stderr
				.split("\n")
				.filter((line) => line.startsWith(`${name}=`))
				.map((line) => line.slice(name.length + 1));
		if (
			JSON.stringify(fields("Identifier")) !==
				JSON.stringify([pin.chrome.identifier]) ||
			JSON.stringify(fields("TeamIdentifier")) !==
				JSON.stringify([pin.chrome.teamIdentifier])
		)
			throw denied();
		if (
			run(pin.node.path, ["--version"]) !== pin.node.version ||
			version() !== observedChromeVersion
		)
			throw denied();
		hashes();

		const modePaths = new Set<string>();
		for (const source of [pin.chrome.root, pin.node.path]) {
			let path = source;
			for (;;) {
				modePaths.add(path);
				if (path === "/") break;
				path = dirname(path);
			}
		}
		return {
			chromeVersion: observedChromeVersion,
			chromeIdentifier: pin.chrome.identifier,
			chromeTeamIdentifier: pin.chrome.teamIdentifier,
			warnings:
				observedChromeVersion === pin.chrome.version
					? []
					: ["chrome_version_drift"],
			nodeVersion: pin.node.version,
			nodeSha256: pin.node.sha256,
			libnodeSha256: pin.libnode.sha256,
			codesign: "verified" as const,
			sourceModes: [...modePaths].map((path) => ({
				path,
				mode: statSync(path).mode & 0o7777,
			})),
		};
	} catch {
		throw denied();
	}
}
