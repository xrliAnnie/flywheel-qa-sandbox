// FLY-1062 PR3 · in-memory R2 bucket stub for hermetic handler tests.
//
// Implements exactly the R2 binding subset the handler uses (get / put /
// head / delete with onlyIf + sha256 storage-side verification) with R2's
// documented semantics: conditional put returns null when the precondition
// fails (nothing written), sha256 mismatch rejects, reads are strongly
// consistent. Also records OBSERVATIONS the tests assert on (e.g. that the
// handler streamed a payload body instead of buffering it) and offers a
// beforePut hook so races (a manifest CAS landing while a slow PUT is in
// flight) can be simulated deterministically.
import { createHash } from "node:crypto";

function toBytes(value) {
	if (value === null || value === undefined)
		return { bytes: new Uint8Array(0), kind: "empty" };
	if (typeof value === "string")
		return { bytes: Buffer.from(value, "utf8"), kind: "string" };
	if (value instanceof Uint8Array) return { bytes: value, kind: "bytes" };
	if (value instanceof ArrayBuffer)
		return { bytes: new Uint8Array(value), kind: "bytes" };
	return null; // ReadableStream handled async by the caller
}

async function streamToBytes(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(
			typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
		);
	}
	return Buffer.concat(chunks);
}

function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

class MemoryObjectBody {
	constructor(rec) {
		this.key = rec.key;
		this.etag = rec.etag;
		this.httpEtag = `"${rec.etag}"`;
		this.size = rec.bytes.length;
		this.customMetadata = { ...rec.customMetadata };
		this.uploaded = rec.uploaded;
		this._bytes = rec.bytes;
	}

	get body() {
		const bytes = this._bytes;
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(bytes));
				controller.close();
			},
		});
	}

	async arrayBuffer() {
		return this._bytes.buffer.slice(
			this._bytes.byteOffset,
			this._bytes.byteOffset + this._bytes.byteLength,
		);
	}

	async text() {
		return Buffer.from(this._bytes).toString("utf8");
	}

	async json() {
		return JSON.parse(await this.text());
	}
}

export class MemoryBucket {
	constructor() {
		this.objects = new Map(); // key → {key, bytes, etag, customMetadata, uploaded}
		this.observations = { puts: [] }; // {key, bodyKind}
		this.hooks = {}; // beforePut(key) → async
	}

	_meta(rec) {
		return new MemoryObjectBody(rec);
	}

	async head(key) {
		const rec = this.objects.get(key);
		return rec ? this._meta(rec) : null;
	}

	async get(key) {
		const rec = this.objects.get(key);
		return rec ? this._meta(rec) : null;
	}

	async put(key, value, options = {}) {
		let bodyKind;
		let bytes;
		const direct = toBytes(value);
		if (direct) {
			bytes = direct.bytes;
			bodyKind = direct.kind;
		} else {
			// ReadableStream (or async iterable) — the streaming path.
			bodyKind = "stream";
			bytes = await streamToBytes(value);
		}
		this.observations.puts.push({ key, bodyKind });
		if (this.hooks.beforePut) {
			const hook = this.hooks.beforePut;
			this.hooks.beforePut = null; // one-shot — a hook that re-puts must not recurse
			await hook(key);
		}
		// R2 storage-side checksum verification: mismatch rejects the write.
		if (options.sha256) {
			const got = sha256Hex(bytes);
			if (got !== options.sha256.toLowerCase()) {
				throw new Error(
					`put: sha256 mismatch (want ${options.sha256}, got ${got})`,
				);
			}
		}
		const existing = this.objects.get(key);
		if (options.onlyIf) {
			const cond = options.onlyIf;
			if (cond.etagMatches !== undefined) {
				const want = String(cond.etagMatches).replace(/"/g, "");
				if (!existing || existing.etag !== want) return null;
			}
			if (cond.etagDoesNotMatch !== undefined) {
				const not = String(cond.etagDoesNotMatch).replace(/"/g, "");
				if (not === "*") {
					if (existing) return null;
				} else if (existing && existing.etag === not) {
					return null;
				}
			}
		}
		const rec = {
			key,
			bytes,
			etag: sha256Hex(bytes),
			customMetadata: { ...(options.customMetadata || {}) },
			uploaded: new Date(),
		};
		this.objects.set(key, rec);
		return this._meta(rec);
	}

	async delete(key) {
		this.objects.delete(key);
	}

	// test helpers ------------------------------------------------------------
	rawBytes(key) {
		const rec = this.objects.get(key);
		return rec ? Buffer.from(rec.bytes) : null;
	}

	seed(key, value, customMetadata = {}) {
		const { bytes } = toBytes(
			typeof value === "string" ||
				value instanceof Uint8Array ||
				value instanceof ArrayBuffer
				? value
				: JSON.stringify(value),
		);
		this.objects.set(key, {
			key,
			bytes,
			etag: sha256Hex(bytes),
			customMetadata,
			uploaded: new Date(),
		});
	}
}
