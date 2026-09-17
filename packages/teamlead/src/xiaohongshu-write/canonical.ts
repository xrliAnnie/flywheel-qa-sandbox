import { createHash } from "node:crypto";

const MAX_DEPTH = 32;
const MAX_BYTES = 1024 * 1024;

function invalid(): never {
	throw new Error("invalid_write_json");
}

function validString(value: string): void {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
		} else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
	}
}

/** V1 wire encoding: integers only, UTF-16 key order, exact Unicode text. */
export function canonical(value: unknown): string {
	const ancestors = new Set<object>();
	function encode(item: unknown, depth: number): string {
		if (depth > MAX_DEPTH) invalid();
		if (item === null) return "null";
		if (typeof item === "boolean") return String(item);
		if (typeof item === "string") {
			validString(item);
			return JSON.stringify(item);
		}
		if (typeof item === "number") {
			if (!Number.isSafeInteger(item)) invalid();
			return JSON.stringify(item);
		}
		if (typeof item !== "object") invalid();
		if (ancestors.has(item)) invalid();
		ancestors.add(item);
		let output: string;
		if (Array.isArray(item)) {
			const values: string[] = [];
			for (let i = 0; i < item.length; i++)
				values.push(encode(item[i], depth + 1));
			output = `[${values.join(",")}]`;
		} else {
			const proto = Object.getPrototypeOf(item);
			if (proto !== Object.prototype && proto !== null) invalid();
			if (Object.getOwnPropertySymbols(item).length) invalid();
			output = `{${Object.keys(item)
				.sort()
				.map((key) => {
					validString(key);
					const descriptor = Object.getOwnPropertyDescriptor(item, key);
					if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
					return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
				})
				.join(",")}}`;
		}
		ancestors.delete(item);
		return output;
	}
	const result = encode(value, 0);
	if (Buffer.byteLength(result) > MAX_BYTES) invalid();
	return result;
}

export function contentDigest(value: unknown): string {
	return createHash("sha256")
		.update("flywheel:xhs-write:v1\n")
		.update(canonical(value))
		.digest("hex");
}

/** Parse before schema validation so duplicate (including escaped) keys cannot disappear. */
export function parseStrictJson(raw: string): unknown {
	if (Buffer.byteLength(raw) > MAX_BYTES) invalid();
	let cursor = 0;
	function space() {
		while (/[\x20\t\n\r]/.test(raw[cursor] ?? "") && cursor < raw.length)
			cursor++;
	}
	function string(): string {
		const start = cursor++;
		while (cursor < raw.length) {
			const char = raw[cursor++];
			if (char === "\\") cursor++;
			else if (char === '"') {
				const result: string = JSON.parse(raw.slice(start, cursor));
				validString(result);
				return result;
			}
		}
		return invalid();
	}
	function value(depth: number): unknown {
		if (depth > MAX_DEPTH) invalid();
		space();
		if (raw[cursor] === '"') return string();
		if (raw[cursor] === "{") {
			cursor++;
			space();
			const result: Record<string, unknown> = Object.create(null);
			if (raw[cursor] === "}") {
				cursor++;
				return result;
			}
			while (cursor < raw.length) {
				space();
				if (raw[cursor] !== '"') invalid();
				const key = string();
				if (Object.hasOwn(result, key)) invalid();
				space();
				if (raw[cursor++] !== ":") invalid();
				result[key] = value(depth + 1);
				space();
				const separator = raw[cursor++];
				if (separator === "}") return result;
				if (separator !== ",") invalid();
			}
			return invalid();
		}
		if (raw[cursor] === "[") {
			cursor++;
			space();
			const result: unknown[] = [];
			if (raw[cursor] === "]") {
				cursor++;
				return result;
			}
			while (cursor < raw.length) {
				result.push(value(depth + 1));
				space();
				const separator = raw[cursor++];
				if (separator === "]") return result;
				if (separator !== ",") invalid();
			}
			return invalid();
		}
		const token =
			/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
				raw.slice(cursor),
			);
		if (!token) invalid();
		cursor += token[0].length;
		return JSON.parse(token[0]);
	}
	const parsed = value(0);
	space();
	if (cursor !== raw.length) invalid();
	canonical(parsed);
	return parsed;
}
