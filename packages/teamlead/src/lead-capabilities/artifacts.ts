import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const denied = () => new Error("lead_artifact_denied");
const extensions: Readonly<Record<string, string>> = {
	"application/octet-stream": "bin",
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/webp": "webp",
	"application/pdf": "pdf",
	"text/html": "html",
	"text/plain": "txt",
	"text/markdown": "md",
	"application/json": "json",
};
export interface LeadArtifactHandle {
	handle: string;
	relativePath: string;
	mimeType: string;
	size: number;
	sha256: string;
}
interface RecordEntry {
	view: LeadArtifactHandle;
	device: number;
	inode: number;
}
/** Parent-owned activation registry. Named model permissions MUST make the artifact
 * directory and its ancestry immutable to model tools; a writable project is not
 * by itself sufficient. Files stay nonsecret, but providers consume verified bytes. */
export class LeadArtifactStore {
	private readonly records = new Map<string, RecordEntry>();
	private bytes = 0;
	private closed = false;
	private readonly rootDevice: number;
	private readonly rootInode: number;
	constructor(
		private readonly options: {
			projectRoot: string;
			artifactRoot: string;
			assertCurrent(): void;
		},
	) {
		const { projectRoot, artifactRoot } = options;
		if (
			!isAbsolute(projectRoot) ||
			!isAbsolute(artifactRoot) ||
			realpathSync(projectRoot) !== projectRoot ||
			realpathSync(artifactRoot) !== artifactRoot ||
			!artifactRoot.startsWith(projectRoot + sep) ||
			dirname(artifactRoot) !== projectRoot
		)
			throw denied();
		const stat = lstatSync(artifactRoot);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.()
		)
			throw denied();
		this.rootDevice = stat.dev;
		this.rootInode = stat.ino;
	}
	private current() {
		if (this.closed) throw denied();
		this.options.assertCurrent();
		const stat = lstatSync(this.options.artifactRoot);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== this.rootDevice ||
			stat.ino !== this.rootInode ||
			realpathSync(this.options.artifactRoot) !== this.options.artifactRoot
		)
			throw denied();
	}
	async put(data: Uint8Array, mimeType: string): Promise<LeadArtifactHandle> {
		let fd: number | undefined;
		try {
			this.current();
			const extension = Object.hasOwn(extensions, mimeType)
				? extensions[mimeType]
				: undefined;
			if (
				!extension ||
				data.byteLength === 0 ||
				data.byteLength > 25 * 1024 * 1024 ||
				this.records.size >= 128 ||
				this.bytes + data.byteLength > 256 * 1024 * 1024
			)
				throw denied();
			const bytes = Buffer.from(data),
				handle = randomUUID(),
				path = join(this.options.artifactRoot, `${handle}.${extension}`);
			fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			this.current();
			writeFileSync(fd, bytes);
			const stat = fstatSync(fd);
			this.current();
			if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length)
				throw denied();
			const view = {
				handle,
				relativePath: relative(this.options.projectRoot, path),
				mimeType,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			this.records.set(handle, { view, device: stat.dev, inode: stat.ino });
			this.bytes += bytes.length;
			return { ...view };
		} catch {
			throw denied();
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	async read(
		handle: string,
	): Promise<{ artifact: LeadArtifactHandle; data: Buffer }> {
		let fd: number | undefined;
		try {
			this.current();
			const entry = this.records.get(handle);
			if (!entry) throw denied();
			fd = openSync(
				join(this.options.projectRoot, entry.view.relativePath),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			const before = fstatSync(fd);
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.dev !== entry.device ||
				before.ino !== entry.inode ||
				before.size !== entry.view.size
			)
				throw denied();
			const buffer = Buffer.alloc(before.size + 1);
			let count = 0;
			while (count < buffer.length) {
				const n = readSync(fd, buffer, count, buffer.length - count, null);
				if (!n) break;
				count += n;
			}
			const data = buffer.subarray(0, count),
				after = fstatSync(fd);
			this.current();
			if (
				after.size !== before.size ||
				after.mtimeMs !== before.mtimeMs ||
				data.length !== entry.view.size ||
				createHash("sha256").update(data).digest("hex") !== entry.view.sha256
			)
				throw denied();
			return { artifact: { ...entry.view }, data };
		} catch {
			throw denied();
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	/** Invalidates handles; lifecycle cleanup owns deleting the exact activation directory. */
	close() {
		this.closed = true;
		this.records.clear();
		this.bytes = 0;
	}
}
