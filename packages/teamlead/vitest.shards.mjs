import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";

// Largest-cost-first packing keeps --shard=k/N and operates on Vitest's own
// discovered specifications. New files receive the measured median file cost.
export function balanceSpecs(specs, count, cost) {
	if (!Number.isInteger(count) || count < 1)
		throw new Error("Invalid shard count");
	const bins = Array.from({ length: count }, () => []);
	const totals = Array(count).fill(0);
	const sorted = [...specs].sort(
		(a, b) =>
			cost(b) - cost(a) ||
			(a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0),
	);
	for (const spec of sorted) {
		const index = totals.indexOf(Math.min(...totals));
		bins[index].push(spec);
		totals[index] += cost(spec);
	}
	return bins;
}

export default class TeamleadSequencer extends BaseSequencer {
	async shard(specs) {
		const { index, count } = this.ctx.config.shard;
		const { unknownFileMs, filesMs } = JSON.parse(
			readFileSync(new URL("./ci-test-costs.json", import.meta.url), "utf8"),
		);
		const cost = (spec) =>
			filesMs[
				relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/")
			] ?? unknownFileMs;
		return balanceSpecs(specs, count, cost)[index - 1];
	}
}

// Measured expensive files run without a competing worker in CI. Unknown files
// remain included in the parallel project; this list never controls discovery.
export const serialFiles = Object.entries(
	JSON.parse(
		readFileSync(new URL("./ci-test-costs.json", import.meta.url), "utf8"),
	).filesMs,
)
	.filter(([, ms]) => ms >= 2500)
	.map(([file]) => file);
