import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildBrowserSandboxSpec } from "../browser-sandbox.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("denies resolved credential aliases while carving out only the disposable profile", () => {
	const f = fixture();
	const privateRoot = join(f.root, "private"),
		state = join(privateRoot, "state"),
		qaRoot = join(state, "browser"),
		gh = join(f.root, "gh-private"),
		alias = join(f.root, "gh-alias");
	mkdirSync(qaRoot, { recursive: true, mode: 0o700 });
	mkdirSync(gh, { mode: 0o700 });
	symlinkSync(gh, alias);
	vi.stubEnv("FLYWHEEL_STATE_DIR", privateRoot);
	vi.stubEnv("GH_CONFIG_DIR", alias);
	const spec = buildBrowserSandboxSpec({ ...f.input, qaRoot });
	expect(spec.policy).toContain(
		`(deny file-read* (subpath ${JSON.stringify(gh)}))`,
	);
	expect(spec.policy).toContain(
		`(deny file-read* (subpath ${JSON.stringify(alias)}))`,
	);
	expect(spec.policy).toContain(
		`(deny file-read* (require-all (subpath ${JSON.stringify(state)}) (require-not (subpath ${JSON.stringify(qaRoot)}))))`,
	);
	expect(spec.policy).toContain(
		`(deny file-read* (subpath ${JSON.stringify(join(state, ".browser-credential-probe"))}))`,
	);
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-seatbelt-")));
	dirs.push(root);
	const packageRoot = join(root, "deployment", "chrome-devtools-mcp"),
		qaRoot = join(root, "qa"),
		projectRoot = join(root, "project"),
		chromeRoot = join(root, "deployment", "Google Chrome.app");
	const chromeExecutable = join(chromeRoot, "Contents/MacOS/Google Chrome"),
		helper = join(
			chromeRoot,
			"Contents/Frameworks/Google Chrome Framework.framework/Versions/123.0/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
		);
	mkdirSync(join(packageRoot, "build/src/bin"), { recursive: true });
	mkdirSync(qaRoot, { mode: 0o700 });
	mkdirSync(projectRoot);
	mkdirSync(join(chromeRoot, "Contents/MacOS"), { recursive: true });
	mkdirSync(join(helper, ".."), { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "chrome-devtools-mcp", version: "1.9.0" }),
	);
	writeFileSync(
		join(packageRoot, "build/src/bin/chrome-devtools-mcp.js"),
		"// fixture",
	);
	writeFileSync(chromeExecutable, "fixture", { mode: 0o755 });
	writeFileSync(helper, "fixture", { mode: 0o755 });
	const nodeExecutable = join(root, "deployment", "node");
	writeFileSync(nodeExecutable, "fixture", { mode: 0o755 });
	return {
		root,
		chromeRoot,
		helper,
		input: {
			packageRoot,
			qaRoot,
			projectRoot,
			chromeExecutable,
			nodeExecutable,
			proxyPort: 4311,
		},
	};
}
it("builds only a Seatbelt launcher with fixed worker args, env and proxy endpoint", () => {
	const f = fixture(),
		spec = buildBrowserSandboxSpec(f.input);
	expect(spec.command).toBe("/usr/bin/sandbox-exec");
	expect(spec.args.slice(0, 3)).toEqual([
		"-p",
		spec.policy,
		f.input.nodeExecutable,
	]);
	expect(spec.args).toContain("--chrome-arg=--proxy-bypass-list=<-loopback>");
	expect(spec.cwd).toBe(f.input.qaRoot);
	expect(spec.env.HOME).toBe(f.input.qaRoot);
	expect(spec.policy).toContain("(deny default)");
	expect(spec.policy).toContain("(allow file-read*)");
	expect(spec.policy).toContain("(allow sysctl-read)");
	for (const name of [
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
	])
		expect(spec.policy).toContain(
			`(deny file-read* (subpath ${JSON.stringify(join(homedir(), name))}))`,
		);
	expect(spec.policy).toContain(
		`(deny file-read* (subpath ${JSON.stringify(join(f.root, ".qa-credential-probe"))}))`,
	);
	expect(spec.policy).toContain(
		'(allow network-outbound (remote tcp "localhost:4311"))',
	);
	expect(spec.policy).toContain(`(literal ${JSON.stringify(f.helper)})`);
	expect(spec.policy).not.toContain("(allow process-exec)");
	expect(spec.policy).not.toContain("(allow network-outbound)");
	expect(spec.policy).not.toContain("(allow network-inbound");
	expect(spec.args).toContain("--chrome-arg=--no-sandbox");
});
it("does not override native executable mapping with a blanket deny", () => {
	const spec = buildBrowserSandboxSpec(fixture().input);
	expect(spec.policy).not.toMatch(/\(deny[^\n]*file-map-executable/);
	expect(spec.policy).toContain("(deny iokit-get-properties nvram*)");
	expect(spec.policy).toContain("(allow file-map-executable (literal");
	expect(spec.policy).not.toContain("(allow file-map-executable)");
	expect(spec.policy).not.toContain('(subpath "/Library/Apple")');
});
it("confines Crashpad IPC and permits only metadata under the host dump directory", () => {
	const spec = buildBrowserSandboxSpec(fixture().input);
	const profile = join(homedir(), "Library/Application Support/Google/Chrome");
	expect(spec.policy).toContain(
		'(allow mach-register mach-lookup (global-name-regex #"^org\\.chromium\\.crashpad\\.child_port_handshake\\.[0-9]+\\.[0-9]+\\.[^.]+$"))',
	);
	expect(spec.policy).not.toMatch(/\(allow mach-(?:register|lookup)\)/);
	expect(spec.policy).toContain(
		`(deny file-read* (subpath ${JSON.stringify(profile)}))`,
	);
	expect(
		spec.policy
			.split("\n")
			.filter((line) => line.startsWith("(allow file-read-metadata")),
	).toEqual([
		`(allow file-read-metadata (subpath ${JSON.stringify(join(profile, "Crashpad"))}))`,
	]);
	expect(spec.policy).toContain(
		`(allow file-read-xattr (subpath ${JSON.stringify(join(profile, "Crashpad"))}))`,
	);
	expect(spec.policy).not.toContain("/usr/bin/xattr");
	expect(spec.policy).not.toContain("(allow file-read-data");
});
it("denies the entire home except exact runtime roots without enumerating secret filenames", () => {
	const f = fixture();
	const home = join(f.root, "host-home");
	mkdirSync(home);
	vi.stubEnv("HOME", home);
	const spec = buildBrowserSandboxSpec(f.input);
	expect(spec.policy).toContain(
		`(deny file-read* (require-all (subpath ${JSON.stringify(home)}) (require-not (subpath ${JSON.stringify(f.input.packageRoot)})) (require-not (subpath ${JSON.stringify(f.chromeRoot)})) (require-not (subpath ${JSON.stringify(f.input.qaRoot)})) (require-not (literal ${JSON.stringify(f.input.nodeExecutable)}))))`,
	);
	// The home boundary must cover future credentials without extending a list.
	expect(spec.policy).not.toContain(".future-secret");
	expect(spec.policy).not.toContain(
		`(allow file-read* (subpath ${JSON.stringify(home)}))`,
	);
	const alias = join(f.root, "home-alias");
	symlinkSync(home, alias);
	vi.stubEnv("HOME", alias);
	const aliased = buildBrowserSandboxSpec(f.input);
	for (const path of [home, alias])
		expect(aliased.policy).toContain(
			`(deny file-read* (require-all (subpath ${JSON.stringify(path)})`,
		);
});
it("keeps package modes strict but delegates host binary integrity to pre-spawn pins", () => {
	const f = fixture();
	chmodSync(f.input.nodeExecutable, 0o775);
	chmodSync(f.input.chromeExecutable, 0o775);
	const spec = buildBrowserSandboxSpec(f.input);
	expect(spec.policy).not.toContain('(subpath "/opt/homebrew")');
	for (const path of ["Cellar", "opt", "lib"])
		expect(spec.policy).toContain(`(subpath "/opt/homebrew/${path}")`);
	for (const path of ["etc", "var"])
		expect(spec.policy).not.toContain(`(subpath "/opt/homebrew/${path}")`);
	expect(spec.policy).not.toContain(
		'(allow file-write* (subpath "/opt/homebrew"))',
	);
	chmodSync(f.input.packageRoot, 0o777);
	expect(() => buildBrowserSandboxSpec(f.input)).toThrow(
		"browser_sandbox_configuration_invalid",
	);
});
it("rejects private QA roots that are shared or overlap source/system/project roots", () => {
	const f = fixture();
	chmodSync(f.input.qaRoot, 0o755);
	expect(() => buildBrowserSandboxSpec(f.input)).toThrow();
	chmodSync(f.input.qaRoot, 0o700);
	const nested = join(f.input.packageRoot, "workspace");
	mkdirSync(nested);
	expect(() =>
		buildBrowserSandboxSpec({ ...f.input, projectRoot: nested }),
	).toThrow();
	expect(() =>
		buildBrowserSandboxSpec({ ...f.input, projectRoot: "/usr/lib" }),
	).toThrow();
});
it("rejects deployment symlinks escaping to credentials or project files", () => {
	const f = fixture();
	const secret = join(f.input.projectRoot, ".netrc");
	writeFileSync(secret, "SYNTHETIC_CREDENTIAL");
	symlinkSync(secret, join(f.input.packageRoot, "external.js"));
	expect(() => buildBrowserSandboxSpec(f.input)).toThrow(
		"browser_sandbox_configuration_invalid",
	);
});
it("allows contained framework symlinks but never executes updater or arbitrary project scripts", () => {
	const f = fixture(),
		versions = join(
			f.chromeRoot,
			"Contents/Frameworks/Google Chrome Framework.framework/Versions",
		);
	symlinkSync("123.0", join(versions, "Current"));
	const updater = join(f.chromeRoot, "Contents/MacOS/updater");
	writeFileSync(updater, "fixture", { mode: 0o755 });
	const spec = buildBrowserSandboxSpec(f.input),
		exec = spec.policy
			.split("\n")
			.find((line) => line.startsWith("(allow process-exec"))!;
	expect(exec).toContain(JSON.stringify(f.helper));
	expect(exec).not.toContain("updater");
	expect(exec).not.toContain(f.input.projectRoot);
	expect(exec).toContain("/bin/bash");
	expect(exec).not.toContain("/bin/sh");
	const writes = spec.policy
		.split("\n")
		.filter((line) => line.startsWith("(allow file-write"));
	expect(writes).toEqual([
		`(allow file-write* (subpath ${JSON.stringify(f.input.qaRoot)}))`,
		'(allow file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
	]);
	expect(spec.policy).not.toMatch(
		/SecurityServer|sysmond|network-bind|network-inbound|remote udp|remote ip/,
	);
	expect(spec.policy).toContain("(deny process-info*)");
	expect(spec.policy).toContain("(allow process-info* (target self))");
	expect(spec.policy).not.toContain("(allow process-info*)");
	expect(Object.isFrozen(spec.args)).toBe(true);
	expect(Object.isFrozen(spec.env)).toBe(true);
});
it("selects native Chrome through an exact argv wrapper and rejects replacement", () => {
	const f = fixture();
	const spec = buildBrowserSandboxSpec(f.input);
	const alias = join(f.input.qaRoot, "chrome-arm64");
	expect(spec.args).toContain(`--executable-path=${alias}`);
	expect(spec.env).not.toHaveProperty("ARCHPREFERENCE");
	expect(lstatSync(alias).isFile()).toBe(true);
	expect(lstatSync(alias).mode & 0o777).toBe(0o500);
	expect(spec.chromeLauncherSha256).toBe(
		createHash("sha256").update(readFileSync(alias)).digest("hex"),
	);
	expect(readFileSync(alias, "utf8")).toContain(
		"exec /usr/bin/arch -arch arm64",
	);
	expect(spec.policy).toContain('(literal "/usr/bin/arch")');
	expect(spec.policy).toContain('(literal "/bin/bash")');
	expect(spec.policy).not.toContain('(literal "/bin/sh")');
	expect(readFileSync(alias, "utf8")).toMatch(/^#!\/bin\/bash\n/);
	expect(spec.policy).not.toContain('(subpath "/Library/Apple")');
	expect(() => buildBrowserSandboxSpec(f.input)).not.toThrow();
	chmodSync(alias, 0o700);
	writeFileSync(alias, "#!/bin/sh\nexit 0\n");
	chmodSync(alias, 0o500);
	expect(() => buildBrowserSandboxSpec(f.input)).toThrow();
	rmSync(alias);
	symlinkSync("/bin/sh", alias);
	expect(() => buildBrowserSandboxSpec(f.input)).toThrow();
	expect(readlinkSync(alias)).toBe("/bin/sh");
});
it.skipIf(process.platform !== "darwin")(
	"executes the actual wrapper with dotted quoted paths and literal arguments",
	() => {
		const f = fixture();
		const chromeExecutable = join(
			f.root,
			"Chrome's :;,$() binary.app/Contents/MacOS/Google Chrome",
		);
		renameSync(f.chromeRoot, join(chromeExecutable, "../../.."));
		writeFileSync(
			chromeExecutable,
			'#!/bin/sh\nif [ "$1" = "--cdp-probe" ]; then IFS= read -r value <&3 || :; printf "%s" "$value"; else printf "%s\\n" "$@"; fi\n',
		);
		chmodSync(chromeExecutable, 0o755);
		const spec = buildBrowserSandboxSpec({ ...f.input, chromeExecutable });
		const launcher = spec.args
			.find((arg) => arg.startsWith("--executable-path="))!
			.slice("--executable-path=".length);
		const args = [
			"literal a.b",
			"$(exit 9)",
			"quote'and\"double",
			"semi;colon",
		];
		const result = spawnSync(launcher, args, {
			env: spec.env,
			encoding: "utf8",
			timeout: 10000,
		});
		expect(
			result.status,
			JSON.stringify({
				stderr: result.stderr,
				error: result.error,
				signal: result.signal,
			}),
		).toBe(0);
		expect(result.stdout).toBe(args.join("\n") + "\n");
		// Puppeteer uses inherited descriptors 3/4 for CDP; exec must preserve them.
		const pipeFixture = join(f.input.qaRoot, "cdp-fixture");
		writeFileSync(pipeFixture, "synthetic-cdp-pipe");
		const fd = openSync(pipeFixture, "r");
		try {
			const piped = spawnSync(launcher, ["--cdp-probe"], {
				env: spec.env,
				encoding: "utf8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "pipe", fd],
			});
			expect(piped.status, piped.stderr).toBe(0);
			expect(piped.stdout).toBe("synthetic-cdp-pipe");
		} finally {
			closeSync(fd);
		}
	},
);
it.skipIf(process.platform !== "darwin")(
	"launches the fixed Chrome .app path for version output without opening a browser",
	() => {
		const f = fixture();
		const spec = buildBrowserSandboxSpec({
			...f.input,
			chromeExecutable:
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		});
		const result = spawnSync(
			join(f.input.qaRoot, "chrome-arm64"),
			["--version"],
			{ env: spec.env, encoding: "utf8", timeout: 10000 },
		);
		expect(
			result.status,
			JSON.stringify({
				stderr: result.stderr,
				error: result.error,
				signal: result.signal,
			}),
		).toBe(0);
		expect(result.stdout).toMatch(/^Google Chrome \d+\./);
	},
);
it("rejects custom env and argv instead of constructing an alternate launcher", () => {
	const f = fixture();
	expect(() =>
		buildBrowserSandboxSpec({
			...f.input,
			args: ["--no-sandbox"],
			env: { SECRET: "CANARY" },
		} as typeof f.input),
	).toThrow("browser_sandbox_configuration_invalid");
});
it("rejects group/world-writable deployment ancestors that permit source replacement", () => {
	const f = fixture();
	chmodSync(join(f.root, "deployment"), 0o777);
	expect(() => buildBrowserSandboxSpec(f.input)).toThrow(
		"browser_sandbox_configuration_invalid",
	);
});
