// FLY-1062 broker PR · FsBucket — a durable filesystem implementation of the
// exact R2 binding subset the handler uses (get / put / head / delete with
// onlyIf + storage-side sha256), with MemoryBucket-parity semantics:
//   - conditional put returns null when the precondition fails (nothing written);
//   - a sha256 option mismatch REJECTS the write (nothing written);
//   - etag = sha256(bytes) — same derivation MemoryBucket uses;
//   - reads are strongly consistent (single process, single directory).
//
// This backs the minimal REAL endpoint (serve-node.mjs): one node process on
// one data directory. Conditional-put atomicity is guaranteed by a per-process
// async mutex — multi-instance deployments over a shared dir are OUT of this
// bucket's contract (the Cloudflare Worker + R2 form covers that; FLY-1143).
//
// Layout: <dataDir>/objects/<key> (raw bytes) + <dataDir>/meta/<key>.json
// (etag / customMetadata / uploaded). Writes land in <dataDir>/tmp and are
// renamed into place — a crash never leaves a half-written object visible.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

function _sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

// Key hygiene: bucket keys are forward-slash relative paths, no traversal, no
// backslashes, no absolute paths (fail-closed even though the handler only
// derives well-formed keys).
function assertSafeKey(key) {
	if (
		typeof key !== "string" ||
		key.length === 0 ||
		key.startsWith("/") ||
		key.includes("\\") ||
		key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
	) {
		throw new Error(`FsBucket: invalid key ${JSON.stringify(key)}`);
	}
}

class FsObjectBody {
	constructor(filePath, meta, size) {
		this.key = meta.key;
		this.etag = meta.etag;
		this.httpEtag = `"${meta.etag}"`;
		this.size = size;
		this.customMetadata = { ...meta.customMetadata };
		this.uploaded = new Date(meta.uploaded);
		this._filePath = filePath;
	}

	get body() {
		return Readable.toWeb(fs.createReadStream(this._filePath));
	}

	async arrayBuffer() {
		const buf = fs.readFileSync(this._filePath);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}

	async text() {
		return fs.readFileSync(this._filePath, "utf8");
	}

	async json() {
		return JSON.parse(await this.text());
	}
}

export class FsBucket {
	constructor(dataDir) {
		if (!dataDir) throw new Error("FsBucket: dataDir is required");
		this.dataDir = dataDir;
		this.objectsDir = path.join(dataDir, "objects");
		this.metaDir = path.join(dataDir, "meta");
		this.tmpDir = path.join(dataDir, "tmp");
		for (const d of [this.objectsDir, this.metaDir, this.tmpDir]) {
			fs.mkdirSync(d, { recursive: true });
		}
		// per-process async mutex: conditional put / delete are read-check-write
		// sequences that must not interleave.
		this._chain = Promise.resolve();
	}

	_locked(fn) {
		const run = this._chain.then(fn, fn);
		// keep the chain alive even when fn rejects
		this._chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	_paths(key) {
		assertSafeKey(key);
		return {
			obj: path.join(this.objectsDir, key),
			meta: path.join(this.metaDir, `${key}.json`),
		};
	}

	_readMeta(key) {
		const { obj, meta } = this._paths(key);
		if (!fs.existsSync(obj) || !fs.existsSync(meta)) return null;
		return {
			filePath: obj,
			meta: JSON.parse(fs.readFileSync(meta, "utf8")),
			size: fs.statSync(obj).size,
		};
	}

	async head(key) {
		const rec = this._readMeta(key);
		return rec ? new FsObjectBody(rec.filePath, rec.meta, rec.size) : null;
	}

	async get(key) {
		return this.head(key);
	}

	async put(key, value, options = {}) {
		const { obj, meta } = this._paths(key);

		// Stream (or buffer) into a tmp file while hashing — a payload is never
		// held whole in memory and never visible at its key until renamed.
		const tmpFile = path.join(this.tmpDir, `put-${randomUUID()}`);
		const hash = createHash("sha256");
		let size = 0;
		const out = fs.createWriteStream(tmpFile);
		try {
			const iterable =
				value === null || value === undefined
					? []
					: typeof value === "string"
						? [Buffer.from(value, "utf8")]
						: value instanceof Uint8Array
							? [Buffer.from(value)]
							: value instanceof ArrayBuffer
								? [Buffer.from(new Uint8Array(value))]
								: value; // ReadableStream / async iterable
			for await (const chunk of iterable) {
				const buf =
					typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
				hash.update(buf);
				size += buf.length;
				if (!out.write(buf)) {
					await new Promise((resolve) => out.once("drain", resolve));
				}
			}
			await new Promise((resolve, reject) =>
				out.end((e) => (e ? reject(e) : resolve())),
			);
			const etag = hash.digest("hex");

			// R2 storage-side checksum verification: mismatch rejects the write.
			if (options.sha256 && etag !== String(options.sha256).toLowerCase()) {
				throw new Error(
					`FsBucket put: sha256 mismatch (want ${options.sha256}, got ${etag})`,
				);
			}

			return await this._locked(async () => {
				const existing = this._readMeta(key);
				if (options.onlyIf) {
					const cond = options.onlyIf;
					if (cond.etagMatches !== undefined) {
						const want = String(cond.etagMatches).replace(/"/g, "");
						if (!existing || existing.meta.etag !== want) return null;
					}
					if (cond.etagDoesNotMatch !== undefined) {
						const not = String(cond.etagDoesNotMatch).replace(/"/g, "");
						if (not === "*") {
							if (existing) return null;
						} else if (existing && existing.meta.etag === not) {
							return null;
						}
					}
				}
				fs.mkdirSync(path.dirname(obj), { recursive: true });
				fs.mkdirSync(path.dirname(meta), { recursive: true });
				const record = {
					key,
					etag,
					customMetadata: { ...(options.customMetadata || {}) },
					uploaded: new Date().toISOString(),
				};
				const tmpMeta = path.join(this.tmpDir, `meta-${randomUUID()}`);
				fs.writeFileSync(tmpMeta, JSON.stringify(record));
				fs.renameSync(tmpFile, obj);
				fs.renameSync(tmpMeta, meta);
				return new FsObjectBody(obj, record, size);
			});
		} finally {
			fs.rmSync(tmpFile, { force: true });
		}
	}

	async delete(key) {
		const { obj, meta } = this._paths(key);
		await this._locked(async () => {
			fs.rmSync(obj, { force: true });
			fs.rmSync(meta, { force: true });
		});
	}
}
