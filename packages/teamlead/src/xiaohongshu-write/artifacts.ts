import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { artifactSchema, type FrozenArtifact } from "./contracts.js";

export type ArtifactRecord = FrozenArtifact & {
	projectId: string;
	privatePath: string;
	inode: string;
	createdAt: number;
	retentionUntil: number;
};
export interface ArtifactCatalog {
	registerArtifact(record: ArtifactRecord): void;
	matchingArtifact(
		projectId: string,
		expected: Pick<FrozenArtifact, "sha256" | "sizeBytes" | "mimeType">,
	): ArtifactRecord | null;
	retainArtifact(
		artifactId: string,
		projectId: string,
		retentionUntil: number,
	): void;
	collectArtifacts(
		now: number,
		remove: (record: ArtifactRecord) => void,
	): number;
	artifact(artifactId: string, projectId: string): ArtifactRecord | null;
}
type Options = {
	attachmentLimit: number;
	totalLimit?: number;
	// Trusted decoder must consume the frozen bytes. No default that silently accepts media.
	validate: (bytes: Buffer, mime: FrozenArtifact["mimeType"]) => Promise<void>;
};
function invalid(): never {
	throw Error("artifact_unverified");
}
function inode(stat: Stats): string {
	return `${stat.dev}:${stat.ino}`;
}
function sniff(bytes: Buffer): FrozenArtifact["mimeType"] {
	if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
		return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "image/jpeg";
	if (
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	)
		return "image/webp";
	if (
		bytes.toString("ascii", 4, 8) === "ftyp" &&
		["isom", "iso2", "mp41", "mp42", "avc1"].includes(
			bytes.toString("ascii", 8, 12),
		)
	)
		return "video/mp4";
	return invalid();
}

/** Lives only in the dedicated authority. Ingress supplies bounded bytes, never paths. */
export class XhsFrozenArtifactStore {
	private readonly rootIdentity: string;
	private used: number;
	private readonly limit: number;
	private readonly totalLimit: number;
	constructor(
		private readonly root: string,
		private readonly catalog: ArtifactCatalog,
		private readonly options: Options,
	) {
		const stat = lstatSync(root);
		if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) invalid();
		this.rootIdentity = inode(stat);
		this.limit = Math.min(options.attachmentLimit, 10 * 1024 * 1024);
		this.totalLimit = Math.min(
			options.totalLimit ?? 2 * 1024 ** 3,
			2 * 1024 ** 3,
		);
		if (
			!Number.isSafeInteger(this.limit) ||
			this.limit <= 0 ||
			!Number.isSafeInteger(this.totalLimit) ||
			this.totalLimit <= 0 ||
			typeof options.validate !== "function"
		)
			invalid();
		// Count all files, including interrupted imports, so crash leftovers cannot evade quota.
		this.used = readdirSync(root).reduce((sum, name) => {
			const file = lstatSync(join(root, name));
			if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600)
				invalid();
			return sum + file.size;
		}, 0);
	}
	private assertRoot(): void {
		const stat = lstatSync(this.root);
		if (
			!stat.isDirectory() ||
			inode(stat) !== this.rootIdentity ||
			(stat.mode & 0o777) !== 0o700
		)
			invalid();
	}
	private syncRoot(): void {
		this.assertRoot();
		const fd = openSync(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	async import(
		projectId: string,
		mimeType: FrozenArtifact["mimeType"],
		stream: AsyncIterable<Uint8Array>,
		now: number,
	): Promise<FrozenArtifact> {
		if (
			!projectId ||
			projectId.length > 256 ||
			!Number.isSafeInteger(now) ||
			now < 0 ||
			!stream ||
			typeof stream === "string" ||
			typeof stream[Symbol.asyncIterator] !== "function"
		)
			invalid();
		this.assertRoot();
		const artifactId = randomUUID();
		const path = join(this.root, artifactId);
		let fd: number | undefined;
		let size = 0;
		let created = false;
		try {
			fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			created = true;
			const hash = createHash("sha256");
			for await (const chunk of stream) {
				if (!(chunk instanceof Uint8Array)) invalid();
				if (size + chunk.byteLength > this.limit)
					throw Error("preview_media_too_large");
				if (this.used + chunk.byteLength > this.totalLimit)
					throw Error("artifact_capacity_exceeded");
				this.assertRoot();
				// Reserve before synchronous writes; concurrent imports cannot over-admit across awaits.
				this.used += chunk.byteLength;
				size += chunk.byteLength;
				let offset = 0;
				while (offset < chunk.byteLength) {
					const written = writeSync(
						fd,
						chunk,
						offset,
						chunk.byteLength - offset,
					);
					if (!written) invalid();
					offset += written;
				}
				hash.update(chunk);
			}
			if (!size) invalid();
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			this.syncRoot();
			const stat = lstatSync(path);
			const bytes = this.verifiedBytes(path, inode(stat), size);
			if (sniff(bytes) !== mimeType) invalid();
			await this.options.validate(bytes, mimeType);
			const sha256 = hash.digest("hex");
			const after = this.verifiedBytes(path, inode(stat), size);
			if (createHash("sha256").update(after).digest("hex") !== sha256)
				invalid();
			const artifact = artifactSchema.parse({
				artifactId,
				sha256,
				sizeBytes: size,
				mimeType,
			});
			const existing = this.catalog.matchingArtifact(projectId, artifact);
			if (existing) {
				if (
					existing.projectId !== projectId ||
					existing.privatePath !== existing.artifactId ||
					existing.sha256 !== sha256 ||
					existing.sizeBytes !== size ||
					existing.mimeType !== mimeType
				)
					invalid();
				const retained = artifactSchema.parse({
					...artifact,
					artifactId: existing.artifactId,
				});
				const retainedBytes = this.verifiedBytes(
					join(this.root, retained.artifactId),
					existing.inode,
					size,
				);
				if (createHash("sha256").update(retainedBytes).digest("hex") !== sha256)
					invalid();
				// No await between lookup and registration/reuse: concurrent imports in
				// this single authority cannot publish different IDs for the same content.
				this.catalog.retainArtifact(
					retained.artifactId,
					projectId,
					now + 7 * 86400_000,
				);
				unlinkSync(path);
				created = false;
				this.used -= size;
				this.syncRoot();
				return retained;
			}
			this.catalog.registerArtifact({
				...artifact,
				projectId,
				privatePath: artifactId,
				inode: inode(stat),
				createdAt: now,
				retentionUntil: now + 7 * 86400_000,
			});
			return artifact;
		} catch (error) {
			if (fd !== undefined) {
				closeSync(fd);
				fd = undefined;
			}
			if (created) {
				try {
					this.assertRoot();
					unlinkSync(path);
					this.used -= size;
					this.syncRoot();
				} catch {
					return invalid();
				}
			}
			if (
				error instanceof Error &&
				["preview_media_too_large", "artifact_capacity_exceeded"].includes(
					error.message,
				)
			)
				throw error;
			return invalid();
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	private verifiedBytes(path: string, identity: string, size: number): Buffer {
		this.assertRoot();
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			inode(stat) !== identity ||
			stat.size !== size ||
			(stat.mode & 0o777) !== 0o600 ||
			size > this.limit
		)
			invalid();
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = fstatSync(fd);
			if (
				!opened.isFile() ||
				inode(opened) !== identity ||
				opened.nlink !== 1 ||
				opened.size !== size
			)
				invalid();
			const bytes = readFileSync(fd);
			this.assertRoot();
			const after = lstatSync(path);
			if (
				inode(after) !== identity ||
				after.nlink !== 1 ||
				bytes.length !== size
			)
				invalid();
			return bytes;
		} finally {
			closeSync(fd);
		}
	}
	collect(now: number): number {
		return this.catalog.collectArtifacts(now, (record) => {
			if (
				record.privatePath !== record.artifactId ||
				!/^[a-f0-9-]{36}$/.test(record.privatePath)
			)
				invalid();
			const path = join(this.root, record.privatePath);
			const bytes = this.verifiedBytes(path, record.inode, record.sizeBytes);
			if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
				invalid();
			unlinkSync(path);
			this.used -= record.sizeBytes;
			this.syncRoot();
		});
	}

	async read(projectId: string, expected: FrozenArtifact): Promise<Buffer> {
		try {
			artifactSchema.parse(expected);
			const record = this.catalog.artifact(expected.artifactId, projectId);
			if (
				!record ||
				record.privatePath !== expected.artifactId ||
				record.sha256 !== expected.sha256 ||
				record.sizeBytes !== expected.sizeBytes ||
				record.mimeType !== expected.mimeType
			)
				invalid();
			const bytes = this.verifiedBytes(
				join(this.root, record.privatePath),
				record.inode,
				record.sizeBytes,
			);
			if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
				invalid();
			return bytes;
		} catch {
			return invalid();
		}
	}
}
