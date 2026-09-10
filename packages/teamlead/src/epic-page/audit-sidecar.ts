import { canonicalJsonString } from "flywheel-config";

// Tagged nodes distinguish string references from numbers and arrays.
type Node =
	| null
	| boolean
	| number
	| [0, number]
	| [1, Node[]]
	| [2, Array<[number, Node]>];
interface PackedAudit {
	version: 1;
	strings: string[];
	entries: Node[];
}

/** Request-local, deterministic and lossless JSON audit with interned strings. */
export class AuditSidecar {
	private readonly values: PackedAudit = {
		version: 1,
		strings: [],
		entries: [],
	};
	private readonly strings = new Map<string, number>();
	private readonly entries = new Map<string, string>();
	private intern(value: string): number {
		const existing = this.strings.get(value);
		if (existing !== undefined) return existing;
		const id = this.values.strings.push(value) - 1;
		this.strings.set(value, id);
		return id;
	}
	private pack(value: unknown): Node {
		if (
			value === null ||
			typeof value === "boolean" ||
			typeof value === "number"
		)
			return value;
		if (typeof value === "string") return [0, this.intern(value)];
		if (Array.isArray(value)) return [1, value.map((v) => this.pack(v))];
		if (typeof value === "object")
			return [
				2,
				Object.entries(value).map(([k, v]) => [this.intern(k), this.pack(v)]),
			];
		throw new Error("audit_value_not_json");
	}
	add(value: unknown): string {
		const canonical = canonicalJsonString(value);
		const old = this.entries.get(canonical);
		if (old !== undefined) return old;
		const id = String(
			this.values.entries.push(this.pack(JSON.parse(canonical))) - 1,
		);
		this.entries.set(canonical, id);
		return id;
	}
	get count(): number {
		return this.values.entries.length;
	}
	json(): string {
		return JSON.stringify(this.values);
	}
}

/** Decoder for generated artifacts and executable losslessness checks. */
export function decodeAuditSidecar(json: string): unknown[] {
	const data = JSON.parse(json) as PackedAudit;
	if (data.version !== 1) throw new Error("audit_version_unsupported");
	const unpack = (node: Node): unknown => {
		if (!Array.isArray(node)) return node;
		if (node[0] === 0) return data.strings[node[1]];
		if (node[0] === 1) return node[1].map(unpack);
		return Object.fromEntries(
			node[1].map(([key, value]) => [data.strings[key], unpack(value)]),
		);
	};
	return data.entries.map(unpack);
}
