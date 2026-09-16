import { randomUUID } from "node:crypto";

const denied = () => new Error("upstream_token_unverified");
/** Activation-local token handles. No token is written to disk or granted authority by this map. */
export class XiaohongshuTokenHandles {
	private records = new Map<string, { id: string; token: string }>();
	private closed = false;
	constructor(private readonly assertCurrent: () => void) {}
	private current() {
		if (this.closed) throw denied();
		this.assertCurrent();
	}
	resolve(handle: string, id: string) {
		this.current();
		const record = this.records.get(handle);
		if (!record || record.id !== id) throw denied();
		return record.token;
	}
	project(text: string): string {
		this.current();
		if (Buffer.byteLength(text) > 196608) throw denied();
		const staged = new Map(this.records);
		const selected = new Set<string>();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			if (/xsec_?token\s*[=:]/i.test(text)) throw denied();
			value = undefined;
		}
		let nodes = 0;
		const visit = (raw: unknown, depth = 0): unknown => {
			if (depth > 32 || ++nodes > 10000) throw denied();
			if (Array.isArray(raw)) return raw.map((item) => visit(item, depth + 1));
			if (!raw || typeof raw !== "object") return raw;
			const object = raw as Record<string, unknown>,
				out: Record<string, unknown> = Object.create(null);
			if (Object.hasOwn(object, "resourceHandle")) throw denied();
			const keys = Object.keys(object).filter((key) =>
				/^xsec_?token$/i.test(key),
			);
			if (keys.length) {
				const tokens = [...new Set(keys.map((key) => object[key]))],
					ids = [
						...new Set(
							[
								object.id,
								object.feed_id,
								object.feedId,
								object.user_id,
								object.userId,
							].filter((v) => typeof v === "string" && v.length > 0),
						),
					];
				if (
					tokens.length !== 1 ||
					typeof tokens[0] !== "string" ||
					tokens[0].length < 8 ||
					tokens[0].length > 4096 ||
					ids.length !== 1 ||
					String(ids[0]).length > 256
				)
					throw denied();
				const token = tokens[0],
					id = String(ids[0]);
				const existing = [...staged].find(
					([, entry]) => entry.id === id && entry.token === token,
				);
				const handle = existing?.[0] ?? randomUUID();
				selected.add(handle);
				if (selected.size > 512) throw denied();
				staged.delete(handle);
				staged.set(handle, { id, token });
				out.resourceHandle = handle;
			}
			for (const [key, v] of Object.entries(object))
				if (!keys.includes(key)) out[key] = visit(v, depth + 1);
			return out;
		};
		let output = value === undefined ? text : JSON.stringify(visit(value));
		// Also remove copies in share URLs and other text fields; those are not new grants.
		for (const { token } of staged.values())
			for (const spelling of [
				token,
				JSON.stringify(token).slice(1, -1),
				encodeURIComponent(token),
			])
				output = output.split(spelling).join("[redacted]");
		if (/(?:[?&]|\\u0026)xsec_token=(?!\[redacted\])[^&\s"<>]+/i.test(output))
			throw denied();
		if (value !== undefined) JSON.parse(output);
		while (staged.size > 512) staged.delete(staged.keys().next().value!);
		this.current();
		this.records = staged;
		return output;
	}
	close() {
		this.closed = true;
		this.records.clear();
	}
}
