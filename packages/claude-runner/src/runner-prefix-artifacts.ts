import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

export interface RunnerPrefixArtifactIdentity {
	version: 1;
	executionId: string;
	activationId?: string;
	reviewRequestId?: string;
	sessionId: string;
	role: "design" | "implement" | "qa" | "review-design" | "review-code";
	profileDigest: string;
}

export interface RunnerPrefixArtifactSource {
	sourcePath: string;
	sha256: string;
	destination: string;
	executable?: boolean;
}

export interface RunnerPrefixArtifactInput {
	trustedRoots: readonly string[];
	sources: RunnerPrefixArtifactSource[];
	targetDirectory: string;
	identity: RunnerPrefixArtifactIdentity;
}

export interface RunnerPrefixArtifactResult {
	directory: string;
	stampPath: string;
	manifestDigest: string;
}

interface ArtifactEntry {
	sourcePath: string;
	sha256: string;
	destination: string;
	executable: boolean;
}

function digest(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function fail(reason: string): never {
	throw new Error(`runner_prefix_artifacts: ${reason}`);
}

function validatePath(path: string, absolute: boolean): void {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		/[\0\\*?[\]{}:]/.test(path) ||
		isAbsolute(path) !== absolute ||
		path
			.split(sep)
			.some(
				(part, index) =>
					part === "." ||
					part === ".." ||
					(part === "" && !(absolute && index === 0)),
			)
	)
		fail("invalid path");
}

function isWithin(root: string, path: string): boolean {
	const delta = relative(root, path);
	return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

/** All target ancestors must already exist and be real directories. */
function assertDirectoryChain(path: string): void {
	let current = parse(path).root;
	for (const component of path
		.slice(current.length)
		.split(sep)
		.filter(Boolean)) {
		current = join(current, component);
		if (!lstatSync(current).isDirectory())
			fail("symlink or non-directory in target path");
	}
}

function assertPrivateDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700)
		fail("directory must be private");
}

function identityStamp(
	identity: RunnerPrefixArtifactIdentity,
): RunnerPrefixArtifactIdentity {
	const identifier = (value: unknown): value is string =>
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
	if (
		identity.version !== 1 ||
		!identifier(identity.executionId) ||
		!identifier(identity.sessionId) ||
		(identity.activationId !== undefined &&
			!identifier(identity.activationId)) ||
		(identity.reviewRequestId !== undefined &&
			!identifier(identity.reviewRequestId)) ||
		!["design", "implement", "qa", "review-design", "review-code"].includes(
			identity.role,
		) ||
		!/^[a-f0-9]{64}$/.test(identity.profileDigest)
	)
		fail("invalid identity");
	// Construct explicitly: caller metadata and source content never enter the stamp.
	return {
		version: 1,
		executionId: identity.executionId,
		...(identity.activationId === undefined
			? {}
			: { activationId: identity.activationId }),
		...(identity.reviewRequestId === undefined
			? {}
			: { reviewRequestId: identity.reviewRequestId }),
		sessionId: identity.sessionId,
		role: identity.role,
		profileDigest: identity.profileDigest,
	};
}

function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function assertFileMode(stat: Stats, mode?: number): void {
	if (mode !== undefined && ((stat.mode & 0o7777) !== mode || stat.nlink !== 1))
		fail("artifact mode or link changed");
}

/** O_NONBLOCK ensures a swapped-in FIFO cannot hang verification. */
function readRegularFile(path: string, mode?: number): Buffer {
	const before = lstatSync(path);
	if (!before.isFile()) fail("unsupported source or artifact file type");
	assertFileMode(before, mode);
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || !sameFile(before, opened))
			fail("file changed while opening");
		assertFileMode(opened, mode);
		const content = readFileSync(fd);
		const after = fstatSync(fd);
		const pathAfter = lstatSync(path);
		assertFileMode(after, mode);
		assertFileMode(pathAfter, mode);
		if (
			!sameFile(opened, after) ||
			!sameFile(opened, pathAfter) ||
			!pathAfter.isFile() ||
			opened.size !== after.size ||
			opened.mtimeMs !== after.mtimeMs ||
			opened.ctimeMs !== after.ctimeMs ||
			opened.mode !== after.mode
		)
			fail("file changed while reading");
		return content;
	} finally {
		closeSync(fd);
	}
}

function prepare(input: RunnerPrefixArtifactInput) {
	validatePath(input.targetDirectory, true);
	assertDirectoryChain(dirname(input.targetDirectory));
	assertPrivateDirectory(dirname(input.targetDirectory));
	const identity = identityStamp(input.identity);
	if (input.trustedRoots.length === 0) fail("no trusted source roots");
	const roots = input.trustedRoots.map((root) => {
		validatePath(root, true);
		const canonical = realpathSync(root);
		if (!lstatSync(canonical).isDirectory()) fail("invalid source root");
		return { root, canonical };
	});
	const contents = new Map<string, Buffer>();
	const entries: ArtifactEntry[] = input.sources
		.map((source) => {
			validatePath(source.destination, false);
			if (source.destination.split(sep)[0] === "stamp.json")
				fail("reserved destination path");
			validatePath(source.sourcePath, true);
			if (!/^[a-f0-9]{64}$/.test(source.sha256)) fail("invalid source hash");
			if (
				source.executable !== undefined &&
				typeof source.executable !== "boolean"
			)
				fail("invalid executable flag");
			const trusted = roots.find(
				({ root, canonical }) =>
					isWithin(root, source.sourcePath) ||
					isWithin(canonical, source.sourcePath),
			);
			if (!trusted) fail("untrusted source path");
			const relativeSource = relative(
				isWithin(trusted.root, source.sourcePath)
					? trusted.root
					: trusted.canonical,
				source.sourcePath,
			);
			const sourcePath = join(trusted.canonical, relativeSource);
			// Trusted roots may be aliases, but no descendant file or directory may be a symlink.
			let componentPath = trusted.canonical;
			for (const component of relativeSource.split(sep).filter(Boolean)) {
				componentPath = join(componentPath, component);
				if (lstatSync(componentPath).isSymbolicLink())
					fail("source symlink rejected");
			}
			if (!isWithin(trusted.canonical, realpathSync(sourcePath)))
				fail("source escapes trusted root");
			const content = readRegularFile(sourcePath);
			if (realpathSync(sourcePath) !== sourcePath) fail("source path changed");
			if (digest(content) !== source.sha256) fail("source hash mismatch");
			contents.set(source.destination, content);
			return {
				sourcePath,
				sha256: source.sha256,
				destination: source.destination,
				executable: source.executable === true,
			};
		})
		.sort((left, right) =>
			left.destination < right.destination
				? -1
				: left.destination > right.destination
					? 1
					: 0,
		);
	for (let index = 0; index < entries.length; index++) {
		const destination = entries[index]!.destination;
		if (
			entries
				.slice(0, index)
				.some(
					(other) =>
						other.destination === destination ||
						destination.startsWith(`${other.destination}${sep}`),
				)
		)
			fail("overlapping destination paths");
	}
	const manifest = { identity, sources: entries };
	const manifestDigest = digest(JSON.stringify(manifest));
	const stamp = `${JSON.stringify({ ...manifest, manifestDigest }, null, 2)}\n`;
	return { entries, contents, stamp, manifestDigest };
}

function resultFor(
	input: RunnerPrefixArtifactInput,
	manifestDigest: string,
): RunnerPrefixArtifactResult {
	const directory = join(input.targetDirectory, "artifacts");
	return {
		directory,
		stampPath: join(directory, "stamp.json"),
		manifestDigest,
	};
}

function createPrivateDirectory(path: string): void {
	mkdirSync(path, { mode: 0o700 });
	// chmod is independent of umask; normalize before creating any children.
	chmodSync(path, 0o700);
	assertPrivateDirectory(path);
}

function writePrivateFile(
	path: string,
	content: string | Buffer,
	mode: number,
): void {
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		mode,
	);
	try {
		fchmodSync(fd, mode);
		assertFileMode(fstatSync(fd), mode);
		writeFileSync(fd, content);
		assertFileMode(fstatSync(fd), mode);
	} finally {
		closeSync(fd);
	}
}

/**
 * Offline, opt-in building block; it selects no assets and modifies no live config.
 * The caller supplies the complete regular-file asset closure and pinned hashes.
 * targetDirectory's existing parent must be private (0700), canonical and under
 * caller control. Writers must not mutate that parent concurrently.
 *
 * Exclusively reserve targetDirectory, then atomically publish its artifacts child.
 * This avoids rename-over-empty-directory on platforms without rename NOREPLACE.
 * An interrupted reservation fails closed; no existing target is ever reused here.
 */
export function materializeRunnerPrefixArtifacts(
	input: RunnerPrefixArtifactInput,
): RunnerPrefixArtifactResult {
	const prepared = prepare(input);
	try {
		mkdirSync(input.targetDirectory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			fail("target already exists");
		throw error;
	}
	const reservation = lstatSync(input.targetDirectory);
	const staging = join(input.targetDirectory, ".staging");
	const result = resultFor(input, prepared.manifestDigest);
	try {
		chmodSync(input.targetDirectory, 0o700);
		assertPrivateDirectory(input.targetDirectory);
		createPrivateDirectory(staging);
		const directories = new Set([staging]);
		for (const entry of prepared.entries) {
			const path = join(staging, entry.destination);
			let parent = staging;
			for (const component of entry.destination.split(sep).slice(0, -1)) {
				parent = join(parent, component);
				if (directories.has(parent)) continue;
				createPrivateDirectory(parent);
				directories.add(parent);
			}
			writePrivateFile(
				path,
				prepared.contents.get(entry.destination)!,
				entry.executable ? 0o700 : 0o600,
			);
		}
		writePrivateFile(join(staging, "stamp.json"), prepared.stamp, 0o600);
		assertDirectoryChain(input.targetDirectory);
		if (!sameFile(reservation, lstatSync(input.targetDirectory)))
			fail("reservation replaced");
		renameSync(staging, result.directory);
		return result;
	} catch (error) {
		// Never follow a replacement symlink or remove another writer's reservation.
		try {
			assertDirectoryChain(input.targetDirectory);
			if (sameFile(reservation, lstatSync(input.targetDirectory)))
				rmSync(input.targetDirectory, { recursive: true });
		} catch {
			// Preserve the original failure; leave an uncertain reservation for inspection.
		}
		throw error;
	}
}

/** Verify exact identity, provenance, bytes, file set and permissions; never repair. */
export function verifyRunnerPrefixArtifacts(
	input: RunnerPrefixArtifactInput,
): RunnerPrefixArtifactResult {
	const prepared = prepare(input);
	const result = resultFor(input, prepared.manifestDigest);
	assertDirectoryChain(result.directory);
	assertPrivateDirectory(input.targetDirectory);
	if (
		JSON.stringify(readdirSync(input.targetDirectory).sort()) !==
		'["artifacts"]'
	)
		fail("unexpected reservation entries");
	const files = new Map(
		prepared.entries.map((entry) => [
			entry.destination,
			{ sha256: entry.sha256, mode: entry.executable ? 0o700 : 0o600 },
		]),
	);
	files.set("stamp.json", { sha256: digest(prepared.stamp), mode: 0o600 });
	const directories = new Set<string>();
	for (const destination of files.keys()) {
		let parent = dirname(destination);
		while (parent !== ".") {
			directories.add(parent);
			parent = dirname(parent);
		}
	}
	function verifyDirectory(relativePath: string): void {
		const path = join(result.directory, relativePath);
		assertPrivateDirectory(path);
		for (const name of readdirSync(path)) {
			const child = join(relativePath, name);
			if (directories.delete(child)) {
				verifyDirectory(child);
				continue;
			}
			const expected = files.get(child);
			if (!expected) fail("unexpected artifact entry");
			if (
				digest(
					readRegularFile(join(result.directory, child), expected.mode),
				) !== expected.sha256
			)
				fail("artifact or stamp hash mismatch");
			files.delete(child);
		}
	}
	verifyDirectory("");
	if (files.size !== 0 || directories.size !== 0)
		fail("missing artifact entries");
	return result;
}
