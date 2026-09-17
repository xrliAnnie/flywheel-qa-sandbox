// Offline inventory only: no installation, signing, or completeness assertion.
import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInstallationMetadata } from "../../packages/teamlead/src/xiaohongshu-write/installation-metadata.js";
import { parseInstalledTreeManifest } from "../../packages/teamlead/src/xiaohongshu-write/installed-tree.js";
import { renderBootstrapPolicy } from "../../packages/teamlead/src/xiaohongshu-write/installer-manifests.js";
import { projectNativeManifest } from "../../packages/teamlead/src/xiaohongshu-write/native-manifest.js";

const identity = (s: BigIntStats) =>
	[
		s.dev,
		s.ino,
		s.uid,
		s.gid,
		s.mode,
		s.nlink,
		s.size,
		s.mtimeNs,
		s.ctimeNs,
	].join(":");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function measureRuntime(tree: string, output: string) {
	if (process.getuid?.() === 0) throw Error("offline_inventory_unavailable");
	for (const path of [tree, output])
		if (!isAbsolute(path) || normalize(path) !== path || path.endsWith("/"))
			throw Error();
	const outside = relative(tree, output);
	if (
		realpathSync(tree) !== tree ||
		!(outside === ".." || outside.startsWith("../"))
	)
		throw Error();
	const entries: Array<Record<string, string | number>> = [];
	const observed: Array<{ path: string; identity: string; names?: string }> =
		[];
	let total = 0,
		count = 0;
	const visit = (path: string, depth: number) => {
		if (++count > 20001 || depth > 32) throw Error();
		const before = lstatSync(path, { bigint: true }),
			id = identity(before),
			name = relative(tree, path);
		if (
			before.uid !== BigInt(process.getuid!()) ||
			(before.mode & 0o7022n) !== 0n
		)
			throw Error();
		if (before.isDirectory()) {
			const names = readdirSync(path).sort();
			if (!names.length) throw Error();
			observed.push({ path, identity: id, names: JSON.stringify(names) });
			if (name)
				entries.push({
					path: name,
					kind: "directory",
					mode: Number(before.mode & 0o777n),
				});
			for (const child of names) visit(join(path, child), depth + 1);
		} else {
			if (
				!before.isFile() ||
				before.nlink !== 1n ||
				before.size > 256n * 1024n * 1024n
			)
				throw Error();
			total += Number(before.size);
			if (total > 2 * 1024 ** 3) throw Error();
			const fd = openSync(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			const hash = createHash("sha256"),
				buffer = Buffer.alloc(64 * 1024);
			let size = 0;
			try {
				if (identity(fstatSync(fd, { bigint: true })) !== id) throw Error();
				for (;;) {
					const n = readSync(fd, buffer, 0, buffer.length, null);
					if (!n) break;
					size += n;
					if (size > Number(before.size)) throw Error();
					hash.update(buffer.subarray(0, n));
				}
				if (
					size !== Number(before.size) ||
					identity(fstatSync(fd, { bigint: true })) !== id
				)
					throw Error();
			} finally {
				closeSync(fd);
			}
			observed.push({ path, identity: id });
			entries.push({
				path: name,
				kind: "file",
				mode: Number(before.mode & 0o777n),
				size,
				sha256: hash.digest("hex"),
			});
		}
	};
	visit(tree, 0);
	for (const item of observed) {
		if (
			identity(lstatSync(item.path, { bigint: true })) !== item.identity ||
			(item.names !== undefined &&
				JSON.stringify(readdirSync(item.path).sort()) !== item.names)
		)
			throw Error();
	}
	entries.sort((a, b) =>
		String(a.path) < String(b.path)
			? -1
			: String(a.path) > String(b.path)
				? 1
				: 0,
	);
	const json = `${JSON.stringify(
		parseInstalledTreeManifest(
			JSON.stringify({
				schemaVersion: 1,
				root: "/Library/Application Support/Flywheel/Xhs/runtime",
				entries,
			}),
		),
	)}\n`;
	const native = projectNativeManifest(json),
		policy = renderBootstrapPolicy(json);
	const metadata = entries.some(
		(entry) => entry.path === "xhs-installer-bootstrap",
	)
		? renderInstallationMetadata(json)
		: null;
	mkdirSync(output, { mode: 0o700 });
	for (const [name, bytes] of [
		["runtime.manifest.json", json],
		["runtime.manifest", native],
		["installer-bootstrap.policy", policy],
	])
		writeFileSync(join(output, name!), bytes!, { flag: "wx", mode: 0o600 });
	if (metadata !== null)
		writeFileSync(join(output, "installation.metadata"), metadata, {
			flag: "wx",
			mode: 0o600,
		});
	return {
		schemaVersion: 1,
		kind: "offline_inventory",
		hostAcceptance: false,
		entries: entries.length,
		bytes: total,
		jsonSha256: sha(json),
		manifestSha256: sha(native),
		bootstrapPolicySha256: sha(policy),
		installationMetadataSha256: metadata === null ? null : sha(metadata),
	};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (
			process.argv.length !== 6 ||
			process.argv[2] !== "--tree" ||
			process.argv[4] !== "--output-dir"
		)
			throw Error();
		process.stdout.write(
			`${JSON.stringify(measureRuntime(process.argv[3]!, process.argv[5]!))}\n`,
		);
	} catch {
		process.stderr.write("offline_inventory_unavailable\n");
		process.exitCode = 1;
	}
}
