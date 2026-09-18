import { randomUUID } from "node:crypto";
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
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PortfolioSnapshot } from "./types.js";

const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";
function validate(value: unknown): asserts value is PortfolioSnapshot {
	const v = value as PortfolioSnapshot;
	if (
		!v ||
		v.v !== 1 ||
		!Number.isSafeInteger(v.seq) ||
		v.seq < 1 ||
		typeof v.snapshotId !== "string" ||
		!/^[A-Za-z0-9_-]{1,100}$/.test(v.snapshotId) ||
		!Array.isArray(v.projects) ||
		typeof v.sampledAt !== "string" ||
		!Number.isFinite(Date.parse(v.sampledAt))
	)
		throw new Error("invalid snapshot");
}
export class SnapshotStore {
	readonly root: string;
	readonly snapshotsRoot: string;
	readonly latestPath: string;
	private readonly stateDir: string;
	constructor(
		stateDir: string,
		_now: () => number = Date.now,
		private readonly onPruned?: (snapshotId: string) => void,
	) {
		this.stateDir = resolve(stateDir);
		this.root = join(this.stateDir, "portfolio");
		this.snapshotsRoot = join(this.root, "snapshots");
		this.latestPath = join(this.root, "latest.json");
		this.checkDirectories(true);
	}
	private checkDirectories(create = false): void {
		for (const path of [this.stateDir, this.root, this.snapshotsRoot]) {
			if (create)
				try {
					mkdirSync(path, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("snapshot directory must be a real directory");
		}
	}
	private read(path: string): PortfolioSnapshot | null {
		this.checkDirectories();
		let fd: number;
		try {
			fd = openSync(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
				throw new Error("invalid snapshot file");
			const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
			validate(value);
			return value;
		} finally {
			closeSync(fd);
		}
	}
	readLatest(): PortfolioSnapshot | null {
		return this.read(this.latestPath);
	}
	write(snapshot: PortfolioSnapshot): void {
		validate(snapshot);
		this.checkDirectories();
		const lockPath = join(this.root, ".lock"),
			owner = randomUUID();
		let lock: number;
		try {
			lock = openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new Error(
					"snapshot store locked; explicit owner recovery required",
				);
			throw error;
		}
		const errors: unknown[] = [];
		try {
			writeFileSync(lock, owner);
			fsyncSync(lock);
			const path = join(this.snapshotsRoot, `${snapshot.snapshotId}.json`),
				current = this.readLatest(),
				prior = this.read(path);
			if (prior && JSON.stringify(prior) !== JSON.stringify(snapshot))
				throw new Error("snapshot binding conflict");
			if (
				current &&
				current.seq === snapshot.seq &&
				JSON.stringify(current) !== JSON.stringify(snapshot)
			)
				throw new Error("snapshot sequence binding conflict");
			if (!prior) this.atomicJson(path, snapshot);
			if (!current || snapshot.seq > current.seq)
				this.atomicJson(this.latestPath, snapshot);
			this.prune();
		} catch (error) {
			errors.push(error);
		}
		try {
			closeSync(lock);
			this.checkDirectories();
			const fd = openSync(
				lockPath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const stat = fstatSync(fd);
				if (
					!stat.isFile() ||
					stat.size > 100 ||
					readFileSync(fd, "utf8") !== owner
				)
					throw new Error("snapshot lock ownership changed");
			} finally {
				closeSync(fd);
			}
			unlinkSync(lockPath);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length)
			throw new AggregateError(errors, "snapshot write and cleanup failed");
	}
	private prune(): void {
		const snapshots = readdirSync(this.snapshotsRoot)
			.filter((name) => /^[A-Za-z0-9_-]{1,100}\.json$/.test(name))
			.map((name) => ({
				name,
				snapshot: this.read(join(this.snapshotsRoot, name)),
			}));
		snapshots.sort(
			(a, b) =>
				(a.snapshot?.seq ?? 0) - (b.snapshot?.seq ?? 0) ||
				a.name.localeCompare(b.name),
		);
		for (const entry of snapshots.slice(
			0,
			Math.max(0, snapshots.length - 50),
		)) {
			unlinkSync(join(this.snapshotsRoot, entry.name));
			this.onPruned?.(entry.name.slice(0, -5));
		}
	}
	private atomicJson(path: string, value: unknown): void {
		this.checkDirectories();
		const temporary = `${path}.tmp-${randomUUID()}`;
		const fd = openSync(temporary, "wx", 0o600);
		let renamed = false;
		try {
			try {
				writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.checkDirectories();
			renameSync(temporary, path);
			renamed = true;
			const directory = openSync(
				dirname(path),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		} finally {
			if (!renamed) unlinkSync(temporary);
		}
	}
}
