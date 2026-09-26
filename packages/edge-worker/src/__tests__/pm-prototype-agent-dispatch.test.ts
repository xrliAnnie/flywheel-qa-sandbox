import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "flywheel-config";
import { ConfigLoader } from "flywheel-config";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";

/**
 * FLY-1089: routing for the new `pm` and `prototype` roles, driven against the
 * REAL `.flywheel/config.yaml` on this branch (through the real ConfigLoader +
 * AgentDispatcher — no synthetic fixture), so the test proves the actual runtime
 * contract and catches drift the same way Blueprint's dispatch does. Mirrors the
 * FLY-1059 designer-agent-dispatch.test.ts shape.
 *
 * The three-role split makes each label owned by EXACTLY ONE agent (label sets are
 * pairwise disjoint), so a SINGLE-label issue routes deterministically regardless of
 * YAML order. This does NOT make a MULTI-label issue order-independent: an issue
 * carrying two executor-family labels still first-matches by YAML order (see the
 * multi-label test below, which documents that behavior). "Exactly one executor-family
 * label per issue" is the operational precondition; true ambiguity rejection would be
 * an engine follow-up, out of this config-only scope.
 */

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const CONFIG_PATH = path.join(REPO_ROOT, ".flywheel/config.yaml");

describe("pm + prototype agent dispatch (FLY-1089, real .flywheel/config.yaml)", () => {
	let agents: Record<string, AgentConfig>;
	let dispatcher: AgentDispatcher;

	beforeAll(async () => {
		const loader = new ConfigLoader((p) => readFile(p, "utf-8"));
		const config = await loader.load(CONFIG_PATH);
		agents = config.agents ?? {};
		dispatcher = new AgentDispatcher(agents, undefined, REPO_ROOT);
	});

	it("pm and prototype are dual-registered [engineering, product]", () => {
		expect(agents.pm).toBeDefined();
		expect(agents.pm?.departments).toEqual(["engineering", "product"]);
		expect(agents.prototype).toBeDefined();
		expect(agents.prototype?.departments).toEqual(["engineering", "product"]);
	});

	it("`pm` / `product` route to pm from BOTH depts", () => {
		for (const dept of ["engineering", "product"] as const) {
			for (const label of ["pm", "product"]) {
				const r = dispatcher.dispatch({
					issueLabels: [label],
					owningDept: dept,
				});
				expect(`${dept}/${label}→${r.agentName}`).toBe(`${dept}/${label}→pm`);
				expect(r.matchMethod).toBe("label");
				// FLY-901: dispatched by the product Lead, department is the incoming dept
				expect(r.department).toBe(dept);
			}
		}
	});

	it("`prototype` routes to prototype from BOTH depts", () => {
		for (const dept of ["engineering", "product"] as const) {
			const r = dispatcher.dispatch({
				issueLabels: ["prototype"],
				owningDept: dept,
			});
			expect(`${dept}/prototype→${r.agentName}`).toBe(
				`${dept}/prototype→prototype`,
			);
			expect(r.matchMethod).toBe("label");
		}
	});

	it("full creative-role map — dual-registered labels route to their own role from BOTH depts", () => {
		// pm / prototype / product-designer / designer are dual-registered
		// [engineering, product], so they resolve from either dept.
		const cases: Array<[string, string]> = [
			["pm", "pm"],
			["product", "pm"],
			["prototype", "prototype"],
			["doc", "product-designer"],
			["docs", "product-designer"],
			["design", "product-designer"],
			["ux", "product-designer"],
			["designer", "designer"],
			["mockup", "designer"],
		];
		for (const [label, expected] of cases) {
			for (const dept of ["engineering", "product"] as const) {
				const r = dispatcher.dispatch({
					issueLabels: [label],
					owningDept: dept,
				});
				expect(`${dept}/${label}→${r.agentName}`).toBe(
					`${dept}/${label}→${expected}`,
				);
			}
		}
	});

	it("engineering-only roles (engineer / qa) route in their home dept, not product", () => {
		for (const label of ["code", "feat", "research", "plan"]) {
			const r = dispatcher.dispatch({
				issueLabels: [label],
				owningDept: "engineering",
			});
			expect(`${label}→${r.agentName}`).toBe(`${label}→engineer`);
		}
		for (const label of ["qa", "testing"]) {
			const r = dispatcher.dispatch({
				issueLabels: [label],
				owningDept: "engineering",
			});
			expect(`${label}→${r.agentName}`).toBe(`${label}→qa`);
		}
		// qa is engineering-only (not dual-registered) → unreachable from product scope
		const fromProduct = dispatcher.dispatch({
			issueLabels: ["qa"],
			owningDept: "product",
		});
		expect(fromProduct.matchMethod).toBe("shipped-generic");
	});

	it("`poc` is NOT an alias — it appears in no agent's labels and falls to shipped-generic", () => {
		//去黑话 (Codex R1#3 / R2#1): poc was deliberately NOT kept as an alias.
		for (const cfg of Object.values(agents)) {
			expect(
				(cfg.match?.labels ?? []).map((l) => l.toLowerCase()),
			).not.toContain("poc");
		}
		const r = dispatcher.dispatch({
			issueLabels: ["poc"],
			owningDept: "product",
		});
		expect(r.agentName).toBe("generic");
		expect(r.matchMethod).toBe("shipped-generic");
	});

	it("a MULTI-label issue first-matches by YAML order (NOT order-independent — precondition: one executor-family label per issue)", () => {
		// Two executor-family labels on one issue → whichever agent is earlier in the
		// config's YAML order wins. This is the documented operational precondition
		// ('one executor-family label per issue'), NOT a bug. Asserting the CURRENT
		// behavior so a future edit that changes it is caught + reviewed.
		const order = Object.keys(agents);
		const r = dispatcher.dispatch({
			issueLabels: ["pm", "prototype"],
			owningDept: "product",
		});
		// pm is declared before prototype in .flywheel/config.yaml → pm wins.
		expect(order.indexOf("pm")).toBeLessThan(order.indexOf("prototype"));
		expect(r.agentName).toBe("pm");
	});

	it("label sets are pairwise DISJOINT — no single label owned by two agents (single-label routing is order-independent)", () => {
		const named = Object.entries(agents).map(([name, cfg]) => ({
			name,
			labels: new Set((cfg.match?.labels ?? []).map((l) => l.toLowerCase())),
		}));
		const overlaps: string[] = [];
		for (let i = 0; i < named.length; i++) {
			for (let j = i + 1; j < named.length; j++) {
				const a = named[i]!;
				const b = named[j]!;
				const inter = [...a.labels].filter((l) => b.labels.has(l));
				if (inter.length > 0) {
					overlaps.push(`${a.name}∩${b.name}=[${inter.join(",")}]`);
				}
			}
		}
		expect(overlaps).toEqual([]);
		// and the label move actually happened: pm/product left product-designer
		const pd = new Set(
			(agents["product-designer"]?.match?.labels ?? []).map((l) =>
				l.toLowerCase(),
			),
		);
		expect(pd.has("pm")).toBe(false);
		expect(pd.has("product")).toBe(false);
		expect(new Set(agents.pm?.match?.labels).has("pm")).toBe(true);
	});
});
