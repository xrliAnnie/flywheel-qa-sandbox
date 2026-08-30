import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "flywheel-config";
import { ConfigLoader } from "flywheel-config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentDispatcher } from "../AgentDispatcher.js";
import { resolvedRepoDispatcher } from "./agent-dispatch-fixtures.js";

/**
 * FLY-1335: the `general` catch-all contract, driven against the REAL
 * `.flywheel/config.yaml` on this branch (real ConfigLoader + real
 * AgentDispatcher — no synthetic fixture), mirroring run-infra's wiring
 * (registry-resolved configs + registered fallbacks). An empty
 * `match.labels` never wins label matching — the "no label matched" fallback
 * is expressed by `default_agent`, and this suite pins that wiring so the
 * config can never silently regress to the shipped-generic fall-through again.
 */

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const CONFIG_PATH = path.join(REPO_ROOT, ".flywheel/config.yaml");

describe("general catch-all dispatch (FLY-1335, real .flywheel/config.yaml)", () => {
	let agents: Record<string, AgentConfig>;
	let defaultAgent: string | undefined;
	let dispatcher: AgentDispatcher;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		// Spy BEFORE load: the real config must not trip the FLY-1335
		// empty-labels warning (general IS the declared default_agent).
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const loader = new ConfigLoader((p) => readFile(p, "utf-8"));
		const config = await loader.load(CONFIG_PATH);
		const resolved = resolvedRepoDispatcher(config, REPO_ROOT);
		agents = resolved.agents;
		defaultAgent = config.default_agent;
		dispatcher = resolved.dispatcher;
	});

	afterAll(() => {
		warnSpy.mockRestore();
	});

	it("config declares default_agent: general and the agent exists", () => {
		expect(defaultAgent).toBe("general");
		expect(agents.general).toBeDefined();
		expect(agents.general?.nodeName).toBe("general");
		expect(agents.general?.label).toBe("通用执行");
	});

	it("unmatched label falls through to general via default_agent", () => {
		const r = dispatcher.dispatch({
			issueLabels: ["ops"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
		expect(r.agentConfig.agentFileRoot).toBe(
			path.join(REPO_ROOT, ".flywheel", "agents"),
		);
		expect(r.agentConfig.agentFile).toBe(
			path.join(REPO_ROOT, ".flywheel", "agents", "nodes", "general.md"),
		);
	});

	it("label-less issue falls through to general", () => {
		const r = dispatcher.dispatch({
			issueLabels: [],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
	});

	it("owningDept=undefined also falls through to general", () => {
		const r = dispatcher.dispatch({
			issueLabels: ["marketing"],
			owningDept: undefined,
		});
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
	});

	it("matched labels still route by label — default_agent shadows nothing", () => {
		const r = dispatcher.dispatch({
			issueLabels: ["bug"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("engineer");
		expect(r.matchMethod).toBe("label");
	});

	it('explicit agentName:"general" override path unchanged', () => {
		const r = dispatcher.dispatchByName("general");
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("override");
		expect(r.agentConfig.agentFileRoot).toBe(
			path.join(REPO_ROOT, ".flywheel", "agents"),
		);
	});

	it('reserved agentName:"generic" still resolves to shipped-generic', () => {
		const r = dispatcher.dispatchByName("generic");
		expect(r.matchMethod).toBe("shipped-generic");
		expect(r.agentConfig.nodeName).toBe("general");
		expect(r.agentConfig.label).toBe("通用执行");
	});

	it("loading the real config emits NO FLY-1335 empty-labels warning", () => {
		// Meaningful only alongside the ConfigLoader fixture test proving the
		// warning CAN fire (mutation partner — see ConfigLoader.test.ts).
		const fly1335Warnings = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes("match.labels is empty"),
		);
		expect(fly1335Warnings).toEqual([]);
	});
});
