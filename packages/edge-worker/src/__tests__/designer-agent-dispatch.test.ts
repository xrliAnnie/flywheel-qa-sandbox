import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "flywheel-config";
import { ConfigLoader } from "flywheel-config";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";

/**
 * FLY-1059: routing for the new visual `designer` role, driven against the REAL
 * `.flywheel/config.yaml` on this branch (through the real ConfigLoader +
 * AgentDispatcher — no synthetic fixture), so the test proves the actual runtime
 * contract and catches drift the same way Blueprint's dispatch does.
 */

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const CONFIG_PATH = path.join(REPO_ROOT, ".flywheel/config.yaml");

describe("designer agent dispatch (FLY-1059, real .flywheel/config.yaml)", () => {
	let agents: Record<string, AgentConfig>;
	let dispatcher: AgentDispatcher;

	beforeAll(async () => {
		const loader = new ConfigLoader((p) => readFile(p, "utf-8"));
		const config = await loader.load(CONFIG_PATH);
		agents = config.agents ?? {};
		dispatcher = new AgentDispatcher(agents, undefined, REPO_ROOT);
	});

	it("designer is dual-registered [engineering, product]", () => {
		expect(agents.designer).toBeDefined();
		expect(agents.designer?.departments).toEqual(["engineering", "product"]);
	});

	it("`designer` / `mockup` route to the designer role from BOTH depts (R2#3)", () => {
		for (const dept of ["engineering", "product"] as const) {
			for (const label of ["designer", "mockup"]) {
				const r = dispatcher.dispatch({
					issueLabels: [label],
					owningDept: dept,
				});
				expect(`${dept}/${label}→${r.agentName}`).toBe(
					`${dept}/${label}→designer`,
				);
				expect(r.matchMethod).toBe("label");
			}
		}
	});

	it("`design` / `ux` still route to product-designer (pm/product moved out — FLY-1089)", () => {
		for (const label of ["design", "ux"]) {
			const r = dispatcher.dispatch({
				issueLabels: [label],
				owningDept: "product",
			});
			expect(`${label}→${r.agentName}`).toBe(`${label}→product-designer`);
		}
	});

	it("`ui` still routes to engineer, NOT designer (R1#3 — whole-issue route ≠ Design-phase mockup-first)", () => {
		const r = dispatcher.dispatch({
			issueLabels: ["ui"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("engineer");
	});

	it("zero label overlap across ALL agents (case-insensitive) — first-match safety", () => {
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
	});

	it("designer ∩ product-designer = ∅ and designer ∩ engineer = ∅", () => {
		const setOf = (name: string) =>
			new Set((agents[name]?.match?.labels ?? []).map((l) => l.toLowerCase()));
		const designer = setOf("designer");
		const pd = setOf("product-designer");
		const eng = setOf("engineer");
		expect([...designer].filter((l) => pd.has(l))).toEqual([]);
		expect([...designer].filter((l) => eng.has(l))).toEqual([]);
		// and the label move actually happened
		expect(designer.has("designer")).toBe(true);
		expect(pd.has("designer")).toBe(false);
	});
});
