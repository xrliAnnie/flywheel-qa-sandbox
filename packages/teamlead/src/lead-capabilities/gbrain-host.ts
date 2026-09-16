import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
export interface GbrainHostBaseline {
	home: string;
	packageRoot: string;
	version: string;
	sourceSha256: string;
	bun: { path: string; sha256: string };
	lock: { path: string; sha256: string };
}
/** Observed host pins; updates require an explicit reviewed baseline change. */
export const GBRAIN_HOST_BASELINE: Readonly<GbrainHostBaseline> = Object.freeze(
	{
		home: "/Users/xiaorongli",
		packageRoot: "/Users/xiaorongli/.bun/install/global/node_modules/gbrain",
		version: "0.9.0",
		sourceSha256:
			"295cd5a8ab8cb88842f9fe07f96479af75cbada8bef11887afc65d237690eacf",
		bun: Object.freeze({
			path: "/Users/xiaorongli/.npm-global/lib/node_modules/bun/bin/bun.exe",
			sha256:
				"1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6",
		}),
		lock: Object.freeze({
			path: "/Users/xiaorongli/.bun/install/global/bun.lock",
			sha256:
				"a4cd8ba383eb6b034254965856d7d06766891aa42ea1b261ddbd4530ca106c6a",
		}),
	},
);
const denied = () => new Error("gbrain_host_unverified");
function digest(path: string, limit: number) {
	if (realpathSync(path) !== path) throw denied();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > limit) throw denied();
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(65536);
		let bytes = 0;
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, null);
			if (!n) break;
			bytes += n;
			if (bytes > limit) throw denied();
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
function sourceDigest(root: string) {
	if (realpathSync(root) !== root) throw denied();
	const paths = ["package.json"];
	let bytes = 0;
	function visit(relative: string) {
		const path = join(root, relative),
			stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw denied();
		if (stat.isDirectory()) {
			for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
		} else if (stat.isFile()) {
			paths.push(relative);
			bytes += stat.size;
			if (paths.length > 4096 || bytes > 16777216) throw denied();
		} else throw denied();
	}
	visit("src");
	const rows = paths
		.sort()
		.map((path) => [path, digest(join(root, path), 16777216)]);
	return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
/** Parent only: same host config as Claude, no database environment overrides or copied service. */
export function pinGbrainHost(
	baseline: GbrainHostBaseline = GBRAIN_HOST_BASELINE,
) {
	const pin = structuredClone(baseline);
	try {
		const configPath = join(pin.home, ".gbrain/config.json");
		const verifyCode = () => {
			if (
				digest(pin.bun.path, 268435456) !== pin.bun.sha256 ||
				digest(pin.lock.path, 1048576) !== pin.lock.sha256 ||
				sourceDigest(pin.packageRoot) !== pin.sourceSha256
			)
				throw denied();
			const pkg = JSON.parse(
				readFileSync(join(pin.packageRoot, "package.json"), "utf8"),
			);
			if (pkg.name !== "gbrain" || pkg.version !== pin.version) throw denied();
		};
		verifyCode();
		const configDigest = digest(configPath, 65536),
			config = JSON.parse(readFileSync(configPath, "utf8"));
		if (
			config.engine !== "postgres" ||
			typeof config.database_url !== "string" ||
			!config.database_url ||
			config.database_path !== undefined
		)
			throw denied();
		const secrets = Object.values(config).filter(
			(v): v is string =>
				typeof v === "string" && v.length > 0 && v !== "postgres",
		);
		const databaseUrl = new URL(config.database_url);
		if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol))
			throw denied();
		if (databaseUrl.password)
			secrets.push(
				databaseUrl.password,
				decodeURIComponent(databaseUrl.password),
			);
		const assertCurrent = () => {
			try {
				verifyCode();
				if (digest(configPath, 65536) !== configDigest) throw denied();
			} catch {
				throw denied();
			}
		};
		assertCurrent();
		return {
			launch: {
				command: pin.bun.path,
				args: [
					"--no-env-file",
					"--no-install",
					"--config=/dev/null",
					join(pin.packageRoot, "src/cli.ts"),
					"serve",
				],
				env: { HOME: pin.home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
				cwd: pin.packageRoot,
			},
			secrets: Object.freeze(secrets),
			assertCurrent,
			evidence: Object.freeze({
				version: pin.version,
				sourceSha256: pin.sourceSha256,
				bunSha256: pin.bun.sha256,
				lockSha256: pin.lock.sha256,
				configSource: "host ~/.gbrain/config.json",
			}),
		};
	} catch {
		throw denied();
	}
}
