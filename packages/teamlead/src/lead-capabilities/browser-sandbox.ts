import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
	type BrowserWorkerSpecInput,
	buildBrowserWorkerSpec,
} from "./browser-config.js";
import {
	leadCredentialAliases,
	pinLeadCredentialPaths,
} from "./credential-paths.js";

const invalid = () => new Error("browser_sandbox_configuration_invalid");
const under = (child: string, parent: string) =>
	child === parent || child.startsWith(parent + sep);
const overlaps = (a: string, b: string) => under(a, b) || under(b, a);
const literal = (value: string) => `(literal ${JSON.stringify(value)})`;
const subtree = (value: string) => `(subpath ${JSON.stringify(value)})`;
/** Fixed sibling outside the worker's writable profile, shared with the real probe. */
export const browserCredentialProbeRoot = (qaRoot: string) =>
	join(dirname(qaRoot), `.${basename(qaRoot)}-credential-probe`);
const homebrewLibraryRoots = [
	"/opt/homebrew/Cellar",
	"/opt/homebrew/opt",
	"/opt/homebrew/lib",
] as const;
const systemReadRoots = [
	...homebrewLibraryRoots,
	"/usr/lib",
	"/usr/share/icu",
	"/usr/share/zoneinfo",
	"/System/Library/Frameworks",
	"/System/Library/PrivateFrameworks",
	"/System/Library/Fonts",
	"/System/Library/ColorSync/Profiles",
	"/System/Library/CoreServices/SystemAppearance.bundle",
	"/System/Library/CoreServices/SystemVersion.bundle",
	"/Library/Fonts",
] as const;
/** SBPL syntax from OpenAI Codex seatbelt_base_policy.sbpl/seatbelt.rs,
 * Chromium sandbox/policy/mac/common.sb, and Apple's shipped /usr/share/sandbox/wfs.sb.
 * This validates a launch specification, not macOS enforcement or Chrome compatibility.
 * Source roots must also be excluded from the model's named-profile writable roots. */
export function buildBrowserSandboxSpec(input: BrowserWorkerSpecInput) {
	try {
		const keys = new Set([
			"packageRoot",
			"nodeExecutable",
			"chromeExecutable",
			"qaRoot",
			"projectRoot",
			"proxyPort",
		]);
		if (Object.keys(input).some((key) => !keys.has(key))) throw invalid();
		const worker = buildBrowserWorkerSpec(input),
			projectRoot = realpathSync(input.projectRoot);
		const chromeRoot = dirname(dirname(dirname(worker.chromeExecutable))),
			brand = basename(worker.chromeExecutable);
		if (
			!chromeRoot.endsWith(".app") ||
			!["Google Chrome", "Google Chrome for Testing", "Chromium"].includes(
				brand,
			) ||
			relative(chromeRoot, worker.chromeExecutable) !==
				`Contents/MacOS/${brand}`
		)
			throw invalid();
		const readRoots = [worker.packageRoot, chromeRoot];
		for (const source of [worker.packageRoot]) {
			let ancestor = dirname(source);
			while (true) {
				const mode = statSync(ancestor).mode;
				// Sticky temp ancestors cannot replace another owner's existing child.
				if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) throw invalid();
				if (ancestor === "/") break;
				ancestor = dirname(ancestor);
			}
		}
		for (const source of [...readRoots, worker.nodeExecutable])
			if (overlaps(source, worker.qaRoot) || overlaps(source, projectRoot))
				throw invalid();
		for (const source of systemReadRoots)
			if (overlaps(source, worker.qaRoot) || overlaps(source, projectRoot))
				throw invalid();
		if ((statSync(worker.qaRoot).mode & 0o077) !== 0) throw invalid();
		const immutable = (path: string) => {
			const stat = statSync(path);
			if (
				(under(path, worker.packageRoot) && (stat.mode & 0o022) !== 0) ||
				(!stat.isFile() && !stat.isDirectory())
			)
				throw invalid();
			return stat;
		};
		if ((immutable(worker.nodeExecutable).mode & 0o111) === 0) throw invalid();
		const executables = new Set([
				worker.nodeExecutable,
				worker.chromeExecutable,
			]),
			seen = new Set<string>();
		let count = 0;
		function inspect(path: string, root: string) {
			const resolved = realpathSync(path);
			if (!under(resolved, root) || ++count > 50000) throw invalid();
			const st = immutable(resolved);
			if (seen.has(resolved)) return;
			seen.add(resolved);
			if (st.isDirectory()) {
				for (const name of readdirSync(resolved))
					inspect(join(resolved, name), root);
				return;
			}
			const rel = relative(chromeRoot, resolved),
				prefix = `Contents/Frameworks/${brand} Framework.framework/Versions/`;
			if (root === chromeRoot && rel.startsWith(prefix)) {
				const rest = rel.slice(prefix.length),
					versionEnd = rest.indexOf("/");
				if (
					versionEnd > 0 &&
					/^[0-9]+(?:\.[0-9]+)+$/.test(rest.slice(0, versionEnd))
				) {
					const child = rest.slice(versionEnd + 1),
						helpers = [
							`${brand} Helper`,
							`${brand} Helper (GPU)`,
							`${brand} Helper (Renderer)`,
						];
					if (
						child === "Helpers/chrome_crashpad_handler" ||
						helpers.some(
							(helper) =>
								child === `Helpers/${helper}.app/Contents/MacOS/${helper}`,
						)
					) {
						if ((st.mode & 0o111) === 0) throw invalid();
						executables.add(resolved);
					}
				}
			}
		}
		for (const root of readRoots) inspect(root, root);
		if (
			(statSync(worker.chromeExecutable).mode & 0o111) === 0 ||
			executables.size < 3
		)
			throw invalid();
		// Reject a deployment symlink changed into a special file; reads stay inside verified roots.
		if (!lstatSync(worker.nodeExecutable).isFile()) throw invalid();
		const credentialPaths = pinLeadCredentialPaths([
			...leadCredentialAliases(process.env),
			...[
				".codex",
				".flywheel",
				".claude",
				".gbrain",
				".config",
				".ssh",
				".zshrc",
				".npmrc",
				".gitconfig",
				".docker/config.json",
				"Library/Application Support/discord/Local Storage",
				"Library/Keychains",
				"Library/Application Support/Google/Chrome",
			].map((path) => join(homedir(), path)),
			projectRoot,
			browserCredentialProbeRoot(worker.qaRoot),
		]);
		const readDenials = credentialPaths.paths.map((path) => {
			if (under(path, worker.qaRoot)) throw invalid();
			// Only the disposable profile is carved out of a containing private root.
			const filter = under(worker.qaRoot, path)
				? `(require-all ${subtree(path)} (require-not ${subtree(worker.qaRoot)}))`
				: subtree(path);
			return `(deny file-read* ${filter})`;
		});
		credentialPaths.assertCurrent();
		const homePaths = pinLeadCredentialPaths([homedir()]);
		homePaths.assertCurrent();
		// Lead QA1161 ruling: use argv, never ARCHPREFERENCE's path parser.
		// exec preserves the browser PID and CDP descriptors without a child shell.
		const quotedChrome =
			"'" + worker.chromeExecutable.replaceAll("'", "'\"'\"'") + "'";
		const wrapper = `#!/bin/bash\nexec /usr/bin/arch -arch arm64 ${quotedChrome} "$@"\n`;
		const chromeLauncherSha256 = createHash("sha256")
			.update(wrapper)
			.digest("hex");
		try {
			writeFileSync(worker.chromeLauncher, wrapper, {
				flag: "wx",
				mode: 0o500,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const fd = openSync(
			worker.chromeLauncher,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const st = fstatSync(fd);
			if (
				!st.isFile() ||
				st.nlink !== 1 ||
				st.uid !== process.getuid?.() ||
				(st.mode & 0o777) !== 0o500 ||
				st.size !== Buffer.byteLength(wrapper) ||
				readFileSync(fd, "utf8") !== wrapper
			)
				throw invalid();
		} finally {
			closeSync(fd);
		}
		executables.add(worker.chromeLauncher);
		executables.add("/bin/bash");
		executables.add("/usr/bin/arch");
		const policy = `${[
			"(version 1)",
			"(deny default)",
			"(deny network*)",
			"(deny process-info*)",
			// macOS os_log/firehose queries its own unique PID during MCP startup.
			// Match Apple's shipped self-introspection rule; other targets stay denied.
			"(allow process-info* (target self))",
			// QA host bisect: an explicit blanket mapping deny forces Chrome into
			// Rosetta despite the arm64 launcher. Keep default-deny and the scoped
			// mapping grants below; do not admit the Rosetta runtime.
			"(deny iokit-get-properties nvram*)",
			"(allow process-fork)",
			"(allow signal (target same-sandbox))",
			`(allow process-exec ${[...executables].sort().map(literal).join(" ")})`,
			`(allow file-map-executable ${literal(worker.nodeExecutable)} ${literal("/usr/bin/arch")} ${literal("/bin/bash")} ${literal(worker.chromeLauncher)} ${subtree(chromeRoot)} ${[...homebrewLibraryRoots, "/usr/lib", "/System/Library/Frameworks", "/System/Library/PrivateFrameworks"].map(subtree).join(" ")})`,
			// Lead ruling e3d41f41: Node 25.6.1 aborts under the read allowlist.
			// Broad runtime reads retain explicit credential/project/probe denial
			// (file-read* includes metadata). Write/exec/network boundaries are unchanged.
			"(allow file-read*)",
			// Lead 4bc8df26: disabling Chrome's renderer sandbox requires a home
			// boundary, including future credentials outside the enumerated roots.
			// Only the pinned runtime and disposable profile need home data reads;
			// do not grant the surrounding worktree or an entire Library directory.
			...homePaths.paths.map(
				(path) =>
					`(deny file-read* (require-all ${subtree(path)} ${[worker.packageRoot, chromeRoot, worker.qaRoot].map((root) => `(require-not ${subtree(root)})`).join(" ")} (require-not ${literal(worker.nodeExecutable)})))`,
			),
			...readDenials,
			// Lead ed48f532 / host gate be1736d0: Chrome stats its default dump
			// directory even with crash reporting disabled and dumps redirected.
			// Host proof 1620cb21: Chrome also stats Crashpad/new. Admit only
			// this subtree's metadata; profile data and enumeration stay denied.
			`(allow file-read-metadata ${subtree(join(homedir(), "Library/Application Support/Google/Chrome/Crashpad"))})`,
			// Host proof b0f95b33: Crashpad initialization reads directory xattrs.
			// This grants no file data or enumeration and no additional execution.
			`(allow file-read-xattr ${subtree(join(homedir(), "Library/Application Support/Google/Chrome/Crashpad"))})`,
			`(allow file-write* ${subtree(worker.qaRoot)})`,
			'(allow file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
			`(allow network-outbound (remote tcp "localhost:${input.proxyPort}"))`,
			"(allow sysctl-read)",
			// Crashpad's PID/thread/random handshake name is the only additional
			// Mach namespace authorized by the same bounded host rework ruling.
			'(allow mach-register mach-lookup (global-name-regex #"^org\\.chromium\\.crashpad\\.child_port_handshake\\.[0-9]+\\.[0-9]+\\.[^.]+$"))',
			'(allow mach-lookup (global-name "com.apple.windowserver.active") (global-name "com.apple.FontObjectsServer") (global-name "com.apple.fonts"))',
			'(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient"))',
		].join("\n")}\n`;
		return Object.freeze({
			command: "/usr/bin/sandbox-exec" as const,
			args: Object.freeze([
				"-p",
				policy,
				worker.nodeExecutable,
				...worker.args,
			]),
			env: Object.freeze({ ...worker.env }),
			cwd: worker.qaRoot,
			chromeLauncherSha256,
			policy,
		});
	} catch {
		throw invalid();
	}
}
