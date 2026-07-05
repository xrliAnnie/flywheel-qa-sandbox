import { describe, expect, it, vi } from "vitest";
import {
	type DerivedToolContext,
	GatewayDispatcher,
	type GatewayTool,
	type ModelToolArgs,
} from "../GatewayDispatcher.js";

/** A dispatcher wired with spy handlers + injectable preflights. */
function makeDispatcher(opts?: {
	shipAllowed?: boolean;
	lifecycleAllowed?: boolean;
	shipThrows?: boolean;
	deriveThrows?: boolean;
	/** Authority the runtime derives (model args must NOT override this). */
	derivedExecId?: string;
}) {
	const shipHandler = vi.fn(async () => "shipped");
	const lifecycleHandler = vi.fn(async () => "lifecycled");
	const nonReservedHandler = vi.fn(async () => "did-thing");

	const tools: GatewayTool[] = [
		{
			name: "relay_ship_decision",
			kind: "reserved_ship",
			description: "ship",
			handler: shipHandler,
		},
		{
			name: "request_runner_lifecycle",
			kind: "reserved_lifecycle",
			description: "lifecycle",
			handler: lifecycleHandler,
		},
		{
			name: "read_runner_tmux",
			kind: "non_reserved",
			description: "read",
			handler: nonReservedHandler,
		},
	];

	const deriveContext = vi.fn(
		(tool: GatewayTool, _args: ModelToolArgs): DerivedToolContext => {
			if (opts?.deriveThrows) throw new Error("ambiguous target");
			return {
				tool: tool.name,
				kind: tool.kind,
				// Authority is RUNTIME-derived — fixed regardless of model args.
				authority: { execId: opts?.derivedExecId ?? "real-exec-1" },
			};
		},
	);

	const preflightShip = vi.fn(() => {
		if (opts?.shipThrows) throw new Error("verify boom");
		return { allowed: opts?.shipAllowed ?? true, reason: "approved" };
	});
	const preflightLifecycle = vi.fn(() => ({
		allowed: opts?.lifecycleAllowed ?? true,
		reason: "consent_ok",
	}));

	const d = new GatewayDispatcher({
		tools,
		deriveContext,
		preflightShip,
		preflightLifecycle,
	});
	return {
		d,
		shipHandler,
		lifecycleHandler,
		nonReservedHandler,
		deriveContext,
		preflightShip,
		preflightLifecycle,
	};
}

describe("GatewayDispatcher (FLY-245 Phase C — three-layer dispatch guard)", () => {
	it("rejects a duplicate tool registration at construction", () => {
		const t: GatewayTool = {
			name: "dup",
			kind: "non_reserved",
			description: "",
			handler: async () => null,
		};
		expect(
			() =>
				new GatewayDispatcher({
					tools: [t, t],
					deriveContext: (tool) => ({
						tool: tool.name,
						kind: tool.kind,
						authority: {},
					}),
					preflightShip: () => ({ allowed: true, reason: "" }),
					preflightLifecycle: () => ({ allowed: true, reason: "" }),
				}),
		).toThrow(/duplicate tool/);
	});

	it("reservedToolNames lists only the founder-gated tools", () => {
		const { d } = makeDispatcher();
		expect(d.reservedToolNames().sort()).toEqual([
			"relay_ship_decision",
			"request_runner_lifecycle",
		]);
	});

	it("fail-closed on an unknown tool (no handler reached)", async () => {
		const { d } = makeDispatcher();
		const r = await d.dispatch("evil_tool", {});
		expect(r).toEqual({ ok: false, reason: "unknown_tool" });
	});

	it("reserved_ship: preflight reject → handler NEVER called", async () => {
		const { d, shipHandler, preflightShip } = makeDispatcher({
			shipAllowed: false,
		});
		const r = await d.dispatch("relay_ship_decision", {});
		expect(r.ok).toBe(false);
		expect(preflightShip).toHaveBeenCalledOnce();
		expect(shipHandler).not.toHaveBeenCalled();
	});

	it("reserved_ship: preflight allow → handler called with DERIVED context", async () => {
		const { d, shipHandler } = makeDispatcher({ shipAllowed: true });
		const r = await d.dispatch("relay_ship_decision", {});
		expect(r).toMatchObject({ ok: true, result: "shipped" });
		expect(shipHandler).toHaveBeenCalledOnce();
	});

	it("reserved_lifecycle: preflight reject → handler NEVER called", async () => {
		const { d, lifecycleHandler } = makeDispatcher({ lifecycleAllowed: false });
		const r = await d.dispatch("request_runner_lifecycle", {});
		expect(r.ok).toBe(false);
		expect(lifecycleHandler).not.toHaveBeenCalled();
	});

	it("non_reserved: NO preflight, handler called directly", async () => {
		const { d, nonReservedHandler, preflightShip, preflightLifecycle } =
			makeDispatcher();
		const r = await d.dispatch("read_runner_tmux", {});
		expect(r).toMatchObject({ ok: true, result: "did-thing" });
		expect(nonReservedHandler).toHaveBeenCalledOnce();
		expect(preflightShip).not.toHaveBeenCalled();
		expect(preflightLifecycle).not.toHaveBeenCalled();
	});

	it("authority is runtime-DERIVED — model args cannot override execId", async () => {
		const { d, shipHandler, preflightShip } = makeDispatcher({
			derivedExecId: "real-exec-1",
		});
		await d.dispatch("relay_ship_decision", {
			execId: "attacker-supplied",
			prHead: "deadbeef",
		});
		// Preflight + handler both see the DERIVED authority, never the model's.
		const derivedSeen = preflightShip.mock.calls[0][0];
		expect(derivedSeen.authority.execId).toBe("real-exec-1");
		const handlerDerived = shipHandler.mock.calls[0][1];
		expect(handlerDerived.authority.execId).toBe("real-exec-1");
	});

	it("fail-closed when context derivation throws (ambiguous target)", async () => {
		const { d, shipHandler } = makeDispatcher({ deriveThrows: true });
		const r = await d.dispatch("relay_ship_decision", {});
		expect(r).toEqual({ ok: false, reason: "context_derivation_failed" });
		expect(shipHandler).not.toHaveBeenCalled();
	});

	it("fail-closed when a preflight THROWS (treated as deny)", async () => {
		const { d, shipHandler } = makeDispatcher({ shipThrows: true });
		const r = await d.dispatch("relay_ship_decision", {});
		expect(r).toEqual({ ok: false, reason: "preflight_threw" });
		expect(shipHandler).not.toHaveBeenCalled();
	});
});
