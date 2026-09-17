import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	getLeaseProof,
	processStartTime,
	withMkdirLock,
} from "flywheel-config";

const denied = () => Error("xhs_staging_owner_unavailable");
export type XhsStagingOwner = { assertCurrent(): void; close(): Promise<void> };
/** Hold the existing interprocess lock for this registry's lifetime. Unknown
 * process identity or malformed ownership is never recovered by age. */
export async function acquireXhsStagingOwner(
	projectRoot: string,
	deps: { readStart?: (pid: number) => string | null } = {},
): Promise<XhsStagingOwner> {
	const readStart = deps.readStart ?? processStartTime;
	const start = readStart(process.pid);
	if (
		!start ||
		!isAbsolute(projectRoot) ||
		realpathSync(projectRoot) !== projectRoot
	)
		throw denied();
	const project = lstatSync(projectRoot),
		uid = process.getuid?.();
	if (!project.isDirectory() || uid === undefined || project.uid !== uid)
		throw denied();
	const lock = join(projectRoot, ".flywheel-xhs-staging-owner");
	const currentProject = () => {
		const current = lstatSync(projectRoot);
		if (
			!current.isDirectory() ||
			current.dev !== project.dev ||
			current.ino !== project.ino
		)
			throw denied();
	};
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ready!: (value: XhsStagingOwner) => void,
		failed!: (reason: unknown) => void;
	const result = new Promise<XhsStagingOwner>((resolve, reject) => {
		ready = resolve;
		failed = reject;
	});
	let verify: () => void = () => {
		throw denied();
	};
	let closed = false;
	const job = withMkdirLock(
		lock,
		async () => {
			currentProject();
			const proof = getLeaseProof(lock);
			if (!proof) throw denied();
			const directory = lstatSync(lock),
				marker = lstatSync(proof.markerPath);
			if (
				!directory.isDirectory() ||
				directory.uid !== uid ||
				!marker.isFile() ||
				marker.uid !== uid ||
				marker.nlink !== 1 ||
				marker.size > 4096
			)
				throw denied();
			let hardened = false;
			const readMarker = () => {
				const fd = openSync(
					proof.markerPath,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const stat = fstatSync(fd),
						path = lstatSync(proof.markerPath);
					if (
						!stat.isFile() ||
						stat.uid !== uid ||
						stat.nlink !== 1 ||
						stat.dev !== marker.dev ||
						stat.ino !== marker.ino ||
						path.dev !== stat.dev ||
						path.ino !== stat.ino ||
						stat.size < 1 ||
						stat.size > 4096 ||
						(hardened && (stat.mode & 0o7777) !== 0o600)
					)
						throw denied();
					const raw = Buffer.alloc(4097);
					const n = readSync(fd, raw, 0, raw.length, 0);
					if (n !== stat.size) throw denied();
					return raw.subarray(0, n).toString("utf8");
				} finally {
					closeSync(fd);
				}
			};
			const original = readMarker();
			const record = JSON.parse(original);
			if (
				record.pid !== process.pid ||
				record.processStartTime !== start ||
				record.token !== proof.ownershipToken
			)
				throw denied();
			verify = () => {
				currentProject();
				const now = lstatSync(lock);
				if (
					!now.isDirectory() ||
					now.dev !== directory.dev ||
					now.ino !== directory.ino ||
					(hardened && (now.mode & 0o7777) !== 0o700) ||
					readMarker() !== original
				)
					throw denied();
			};
			// The generic lock creates the marker; this consumer makes it durable before
			// exposing any staging capability. Only exact acquired inode paths are opened.
			for (const [path, mode] of [
				[proof.markerPath, 0o600],
				[lock, 0o700],
				[projectRoot, null],
			] as const) {
				const fd = openSync(
					path,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const opened = fstatSync(fd),
						expected =
							path === proof.markerPath
								? marker
								: path === lock
									? directory
									: project;
					if (opened.dev !== expected.dev || opened.ino !== expected.ino)
						throw denied();
					verify();
					if (mode !== null) fchmodSync(fd, mode);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			}
			hardened = true;
			verify();
			ready({
				assertCurrent() {
					if (closed) throw denied();
					verify();
				},
				async close() {
					if (!closed) {
						verify();
						closed = true;
						release();
					}
					await job;
					currentProject();
					const fd = openSync(
						projectRoot,
						constants.O_RDONLY | constants.O_NOFOLLOW,
					);
					try {
						const stat = fstatSync(fd);
						if (stat.dev !== project.dev || stat.ino !== project.ino)
							throw denied();
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
				},
			});
			await held;
		},
		{
			timeoutMs: 100,
			retryMs: 10,
			staleMs: Number.POSITIVE_INFINITY,
			readProcessStartTime: (pid) =>
				pid === process.pid ? start : readStart(pid),
			beforeStaleBreak: () => {
				currentProject();
				const stat = lstatSync(lock);
				if (!stat.isDirectory() || stat.uid !== uid) throw denied();
				const names = readdirSync(lock);
				if (names.length !== 1) throw denied();
				const marker = lstatSync(join(lock, names[0]!));
				if (!marker.isFile() || marker.uid !== uid || marker.nlink !== 1)
					throw denied();
			},
			beforeRelease: () => verify(),
		},
	).catch(() => {
		const error = denied();
		failed(error);
		throw error;
	});
	// A failed acquisition has no owner to await close; consume its rejection.
	void job.catch(() => {});
	return result;
}
