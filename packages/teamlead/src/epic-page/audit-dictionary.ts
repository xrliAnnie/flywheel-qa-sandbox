import { canonicalJsonString } from "flywheel-config";
import type { Cell, Provenance } from "./model.js";

export interface AuditDictionaryData {
	sources: Provenance[];
	texts: string[];
	times: string[];
	// source, observed_at, optional source_updated_at; indexes resolve above.
	cells: Array<[number, number, number?]>;
}

/** One dictionary per render: no shared mutable state or clock input. */
export class AuditDictionary {
	private readonly values: AuditDictionaryData = {
		sources: [],
		texts: [],
		times: [],
		cells: [],
	};
	private readonly textIds = new Map<string, string>();
	private readonly sourceIds = new Map<string, number>();
	private readonly timeIds = new Map<string, number>();
	private readonly cellIds = new Map<string, string>();
	private time(value: string): number {
		const old = this.timeIds.get(value);
		if (old !== undefined) return old;
		const id = this.values.times.push(value) - 1;
		this.timeIds.set(value, id);
		return id;
	}
	add(cell: Cell<unknown>): string {
		const key = canonicalJsonString(cell.provenance);
		let source = this.sourceIds.get(key);
		if (source === undefined) {
			source = this.values.sources.push(cell.provenance) - 1;
			this.sourceIds.set(key, source);
		}
		const reference: [number, number, number?] = [
			source,
			this.time(cell.observed_at),
		];
		if (cell.source_updated_at)
			reference.push(this.time(cell.source_updated_at));
		const signature = JSON.stringify(reference);
		const old = this.cellIds.get(signature);
		if (old !== undefined) return old;
		const id = String(this.values.cells.push(reference) - 1);
		this.cellIds.set(signature, id);
		return id;
	}
	text(value: string): string {
		const old = this.textIds.get(value);
		if (old !== undefined) return old;
		const id = String(this.values.texts.push(value) - 1);
		this.textIds.set(value, id);
		return id;
	}
	data(): AuditDictionaryData {
		return this.values;
	}
	json(): string {
		return JSON.stringify(this.values).replace(
			/[<>&\u2028\u2029]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	}
}

/** Fixed labels only; raw evidence never participates in the compact summary. */
export function judgmentSummary(
	cell: Cell<import("../ship-judgment/epic-facts.js").EpicJudgment | null>,
): string {
	if (!cell.value) return "机器意见：读取失败";
	const display = { pending: "待展示", published: "已展示", history: "历史" }[
		cell.value.display
	];
	const overall =
		cell.value.overall === null
			? "待判断"
			: {
					can: "可",
					cannot: "不可",
					recommend_reject: "建议拒绝",
					undetermined: "无法判断",
				}[cell.value.overall];
	return `机器意见：${display} · ${overall}`;
}
