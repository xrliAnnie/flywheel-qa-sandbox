// Unprivileged offline assembly. No key generation, signing, installation,
// accounts, service startup or production mutation.
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseAuthorityConfig,
	verifyProviderConfigBinding,
} from "../../packages/teamlead/src/xiaohongshu-write/authority-config.js";
import { renderAuthorityDeployment } from "../../packages/teamlead/src/xiaohongshu-write/deployment.js";
import { parseInstalledTreeManifest } from "../../packages/teamlead/src/xiaohongshu-write/installed-tree.js";
import { readOfflineQaBindings } from "../../packages/teamlead/src/xiaohongshu-write/offline-qa-bindings.js";
import { readImmutableFile } from "../../packages/teamlead/src/xiaohongshu-write/trusted-files.js";
import { measureRuntime } from "./measure-runtime.js";

const root = "/Library/Application Support/Flywheel/Xhs",
	runtime = `${root}/runtime`;
const sha = (raw: string | Buffer) =>
	createHash("sha256").update(raw).digest("hex");
const identity = (s: ReturnType<typeof lstatSync>) =>
	[
		s.dev,
		s.ino,
		s.mode,
		s.uid,
		s.gid,
		s.size,
		s.nlink,
		s.mtimeMs,
		s.ctimeMs,
	].join(":");
function source(path: string) {
	const before = lstatSync(path);
	if (
		!before.isFile() ||
		before.nlink !== 1 ||
		before.size < 1 ||
		before.size > 65536
	)
		throw Error();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		if (identity(before) !== identity(fstatSync(fd))) throw Error();
		const bytes = Buffer.alloc(before.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const n = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (!n) break;
			offset += n;
		}
		if (
			offset !== before.size ||
			identity(before) !== identity(fstatSync(fd)) ||
			identity(before) !== identity(lstatSync(path))
		)
			throw Error();
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, offset),
		);
	} finally {
		closeSync(fd);
	}
}
function copyMeasured(
	from: string,
	to: string,
	entry: { size: number; sha256: string; mode: number },
) {
	const before = lstatSync(from),
		input = openSync(
			from,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	let output: number | undefined;
	try {
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.size !== entry.size ||
			identity(before) !== identity(fstatSync(input))
		)
			throw Error();
		output = openSync(
			to,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			entry.mode,
		);
		const bytes = Buffer.alloc(65536),
			hash = createHash("sha256");
		let total = 0;
		for (;;) {
			const n = readSync(
				input,
				bytes,
				0,
				Math.min(bytes.length, entry.size - total + 1),
				null,
			);
			if (!n) break;
			total += n;
			if (total > entry.size) throw Error();
			hash.update(bytes.subarray(0, n));
			for (let written = 0; written < n; ) {
				const count = writeSync(output, bytes, written, n - written);
				if (count <= 0) throw Error();
				written += count;
			}
		}
		if (
			total !== entry.size ||
			hash.digest("hex") !== entry.sha256 ||
			identity(before) !== identity(fstatSync(input)) ||
			identity(before) !== identity(lstatSync(from))
		)
			throw Error();
		fsyncSync(output);
		chmodSync(to, entry.mode);
	} finally {
		closeSync(input);
		if (output !== undefined) closeSync(output);
	}
}
export function assembleConfiguration(
	tree: string,
	authoritySource: string,
	providerSource: string,
	qaSource: string,
	output: string,
) {
	try {
		if (process.getuid?.() === 0) throw Error();
		for (const path of [tree, output])
			if (!isAbsolute(path) || normalize(path) !== path || path.endsWith("/"))
				throw Error();
		const outside = relative(tree, output);
		if (!(outside === ".." || outside.startsWith("../"))) throw Error();
		const qa = readOfflineQaBindings(qaSource),
			policyRaw = source(authoritySource),
			providerRaw = source(providerSource);
		const config = parseAuthorityConfig(policyRaw),
			provider = verifyProviderConfigBinding(config, providerRaw);
		for (const key of [
			"serviceUid",
			"serviceGid",
			"modelUid",
			"ingressGid",
			"acceptancePublicKey",
		] as const)
			if (config[key] !== qa.bindings[key]) throw Error();
		if (
			qa.bindings.modelGid === config.serviceGid ||
			config.enabled ||
			config.providerConfig.path !== `${root}/provider.json` ||
			config.providerConfig.sha256 !== sha(providerRaw) ||
			config.acceptancePath !== `${root}/acceptance.json` ||
			provider.acceptancePath !== `${root}/provider-acceptance.json` ||
			config.node.path !== `${runtime}/node` ||
			config.entry.path !==
				`${runtime}/packages/teamlead/dist/xiaohongshu-write/authority-main.js` ||
			config.launcher.path !== `${runtime}/xhs-authority-launcher`
		)
			throw Error();
		const deployment = renderAuthorityDeployment(
			policyRaw,
			providerRaw,
			`${root}/authority.json`,
		);
		for (const pin of [
			config.node,
			config.entry,
			config.peerHelper,
			config.launcher,
			config.boundaryProbe,
			provider.providerBinary,
			provider.browser,
			provider.guardian,
			provider.ffmpeg,
			provider.ffprobe,
		])
			if (!pin.path.startsWith(`${runtime}/`)) throw Error();
		mkdirSync(output, { mode: 0o700 });
		const sourceInventory = measureRuntime(
			tree,
			join(output, "source-inventory"),
		);
		const manifest = parseInstalledTreeManifest(
			readFileSync(
				join(output, "source-inventory/runtime.manifest.json"),
				"utf8",
			),
		);
		const files = new Map(manifest.entries.map((entry) => [entry.path, entry]));
		if (files.has("fixture-installer.json")) throw Error();
		for (const requirement of deployment.files) {
			if (!requirement.path.startsWith(`${runtime}/`)) continue;
			const entry = files.get(requirement.path.slice(runtime.length + 1));
			if (
				!entry ||
				entry.kind !== "file" ||
				entry.sha256 !== requirement.sha256 ||
				entry.mode !== requirement.mode
			)
				throw Error();
		}
		for (const name of [
			"installer-entry.js",
			"xhs-installer-bootstrap",
			"xhs-fixture-principal",
			"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
			"node_modules/better-sqlite3/package.json",
			"node_modules/better-sqlite3/lib/index.js",
			"node_modules/bindings/bindings.js",
			"node_modules/file-uri-to-path/index.js",
			"package.json",
		]) {
			const entry = files.get(name);
			if (!entry || entry.kind !== "file" || entry.size === 0) throw Error();
			if (name.startsWith("xhs-") && entry.mode !== 0o755) throw Error();
		}
		const destination = join(output, "runtime");
		mkdirSync(destination, { mode: 0o755 });
		chmodSync(destination, 0o755);
		for (const entry of manifest.entries) {
			const path = join(destination, entry.path);
			if (entry.kind === "directory") {
				if (entry.mode !== 0o755) throw Error();
				mkdirSync(path, { mode: 0o755 });
				chmodSync(path, 0o755);
			} else {
				copyMeasured(join(tree, entry.path), path, entry);
			}
		}
		const fixtureRaw = `${JSON.stringify({ schemaVersion: 1, authorityConfigSha256: sha(policyRaw), modelGid: qa.bindings.modelGid })}\n`;
		writeFileSync(join(destination, "fixture-installer.json"), fixtureRaw, {
			flag: "wx",
			mode: 0o644,
		});
		chmodSync(join(destination, "fixture-installer.json"), 0o644);
		const inventory = measureRuntime(destination, join(output, "install"));
		for (const [name, raw] of [
			["authority.json", policyRaw],
			["provider.json", providerRaw],
			["com.flywheel.xhs-authority.plist", deployment.plist],
		])
			writeFileSync(join(output, "install", name!), raw!, {
				flag: "wx",
				mode: 0o600,
			});
		writeFileSync(
			join(output, "requirements.json"),
			`${JSON.stringify({
				...deployment,
				files: [
					...deployment.files,
					...[
						"runtime.manifest.json",
						"runtime.manifest",
						"installer-bootstrap.policy",
						"installation.metadata",
					].map((name) => ({
						path: `${root}/${name}`,
						uid: 0,
						gid: 0,
						mode: 0o644,
						sha256: sha(readFileSync(join(output, "install", name))),
					})),
					{
						path: `${root}/boundary-signing.key`,
						uid: 0,
						gid: 0,
						mode: 0o600,
						source: "independent_qa_private_key_not_in_artifact",
					},
				],
			})}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		readImmutableFile(qaSource, { maxBytes: 16384, sha256: qa.sha256 });
		if (
			source(authoritySource) !== policyRaw ||
			source(providerSource) !== providerRaw
		)
			throw Error();
		const result = {
			schemaVersion: 1,
			kind: "offline_installation_candidate",
			configurationComplete: true,
			hostAcceptance: false,
			targetHostId: qa.bindings.targetHostId,
			qaPublicBindingsSha256: qa.sha256,
			authorityConfigSha256: sha(policyRaw),
			providerConfigSha256: sha(providerRaw),
			runtimeDestination: runtime,
			installDestination: root,
			launchdPlistDestination:
				"/Library/LaunchDaemons/com.flywheel.xhs-authority.plist",
			sourceInventory,
			inventory,
		};
		// Written last. Partial output is retained, never labelled complete or retried.
		writeFileSync(
			join(output, "artifact.json"),
			`${JSON.stringify(result)}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		return result;
	} catch {
		throw Error("offline_configuration_unavailable");
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		if (
			args.length !== 10 ||
			args[0] !== "--runtime-tree" ||
			args[2] !== "--authority-source" ||
			args[4] !== "--provider-source" ||
			args[6] !== "--qa-public-bindings" ||
			args[8] !== "--output-dir"
		)
			throw Error();
		process.stdout.write(
			`${JSON.stringify(assembleConfiguration(args[1]!, args[3]!, args[5]!, args[7]!, args[9]!))}\n`,
		);
	} catch {
		process.stderr.write("offline_configuration_unavailable\n");
		process.exitCode = 1;
	}
}
