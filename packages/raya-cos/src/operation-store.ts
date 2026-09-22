import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export interface OperationInput {
	operationId: string;
	inputDigest: string;
	kind: string;
	stage: string;
	sourceRefs: string[];
	material: JsonValue;
}
export interface StoredOperation extends OperationInput {
	schemaVersion: 2;
	revision: number;
}
const MAX_BYTES = 1024 * 1024;
const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";
function valid(value: unknown): value is StoredOperation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as StoredOperation;
	return (
		v.schemaVersion === 2 &&
		Number.isSafeInteger(v.revision) &&
		v.revision > 0 &&
		typeof v.operationId === "string" &&
		v.operationId.length > 0 &&
		v.operationId.length <= 1024 &&
		typeof v.inputDigest === "string" &&
		/^[a-f0-9]{64}$/.test(v.inputDigest) &&
		typeof v.kind === "string" &&
		/^[a-z][a-z0-9_-]{0,63}$/.test(v.kind) &&
		typeof v.stage === "string" &&
		/^[a-z][a-z0-9_-]{0,63}$/.test(v.stage) &&
		Array.isArray(v.sourceRefs) &&
		v.sourceRefs.every((ref) => typeof ref === "string" && ref.length > 0) &&
		Object.hasOwn(v, "material")
	);
}

/** Short synchronous CAS transactions only. External effects run after commit. */
export class OperationStore {
	private readonly workspace: string;
	private readonly root: string;
	constructor(workspace: string) {
		this.workspace = realpathSync(resolve(workspace));
		this.root = join(this.workspace, "state/cos/operations");
		this.checkDirectories(true);
	}
	private checkDirectories(create = false): void {
		let path = this.workspace;
		for (const part of ["state", "cos", "operations"]) {
			path = join(path, part);
			if (create) {
				try {
					mkdirSync(path, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw new Error(
					"operation directory must not be a symlink or non-directory",
				);
		}
	}
	private path(operationId: string): string {
		if (
			typeof operationId !== "string" ||
			!operationId ||
			operationId.length > 1024
		)
			throw new Error("invalid operation identity");
		return join(
			this.root,
			`${createHash("sha256").update(operationId).digest("hex")}.json`,
		);
	}
	read(operationId: string): StoredOperation | undefined {
		this.checkDirectories();
		let fd: number;
		try {
			fd = openSync(
				this.path(operationId),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_BYTES)
				throw new Error("invalid operation file");
			const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
			if (!valid(value) || value.operationId !== operationId)
				throw new Error("invalid operation state");
			return value;
		} finally {
			closeSync(fd);
		}
	}
	list(): StoredOperation[] {
		this.checkDirectories();
		return readdirSync(this.root)
			.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
			.sort()
			.map((name) => {
				const fd = openSync(
					join(this.root, name),
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const stat = fstatSync(fd);
					if (!stat.isFile() || stat.size > MAX_BYTES)
						throw new Error("invalid operation file");
					const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
					if (
						!valid(value) ||
						this.path(value.operationId) !== join(this.root, name)
					)
						throw new Error("invalid operation state");
					return value;
				} finally {
					closeSync(fd);
				}
			});
	}

	commit(input: OperationInput, expectedRevision: number): StoredOperation {
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			expectedRevision >= Number.MAX_SAFE_INTEGER
		)
			throw new Error("invalid expected revision");
		const candidate = {
			...input,
			schemaVersion: 2 as const,
			revision: expectedRevision + 1,
		};
		const serialized = `${JSON.stringify(candidate)}\n`;
		const stored: unknown = JSON.parse(serialized);
		if (!valid(stored) || Buffer.byteLength(serialized) > MAX_BYTES)
			throw new Error("invalid operation input");
		this.checkDirectories();
		const lockPath = join(this.root, ".lock");
		const owner = randomUUID();
		let lock: number;
		try {
			lock = openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new Error(
					"operation store locked; explicit owner recovery required",
				);
			throw error;
		}
		let temporary: string | undefined;
		const failures: unknown[] = [];
		try {
			writeFileSync(lock, JSON.stringify({ owner }));
			fsyncSync(lock);
			const current = this.read(input.operationId);
			if ((current?.revision ?? 0) !== expectedRevision)
				throw new Error("operation revision conflict");
			if (
				current &&
				(current.inputDigest !== input.inputDigest ||
					current.kind !== input.kind)
			)
				throw new Error("operation input binding conflict");
			temporary = join(this.root, `.tmp-${owner}`);
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, serialized);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.checkDirectories();
			renameSync(temporary, this.path(input.operationId));
			temporary = undefined;
			const directory = openSync(
				this.root,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		} catch (error) {
			failures.push(error);
		}
		try {
			closeSync(lock);
			this.checkDirectories();
			if (temporary) unlinkSync(temporary);
			// Never remove a replacement lock, even if another writer violated the protocol.
			const fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || stat.size > 1024)
					throw new Error("operation lock ownership changed");
				if (
					(JSON.parse(readFileSync(fd, "utf8")) as { owner?: string }).owner !==
					owner
				)
					throw new Error("operation lock ownership changed");
			} finally {
				closeSync(fd);
			}
			unlinkSync(lockPath);
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(
				failures,
				"operation transaction and cleanup failed",
			);
		return stored;
	}
}
