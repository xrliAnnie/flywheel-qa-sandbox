import { describe, expect, it, vi } from "vitest";
import { createLeadTargetLockClient } from "../target-lock-client.js";

vi.mock("../runtime-authority.js", () => ({
	resolveLeadCapabilityRuntimeAuthority: (options: {
		authority?: { kind: string; leaseFence?: string };
		assertActivationCurrent: () => unknown;
	}) => ({
		authority: options.authority ?? {
			kind: "carrier",
			carrierClaim: "carrier-secret",
		},
		authoritySecret: options.authority?.leaseFence ?? "carrier-secret",
		trusted: { assertActivationCurrent: options.assertActivationCurrent },
	}),
}));
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const input = () => ({
	operationId: "linear.issue.update",
	requestId,
	targetKey: "flywheel:linear:fly-2886",
	deadline: Date.now() + 15_000,
	signal: new AbortController().signal,
});
function fixture(enabled: boolean | "absent", voice = false) {
	const calls: string[] = [];
	let mode = "disabled";
	let configured: boolean | "absent" = enabled;
	const current = vi.fn(() => ({
		lead:
			configured === "absent"
				? {}
				: { voiceBackground: { enabled: configured } },
	}));
	const fetchImpl = vi.fn(async (url: URL | string) => {
		const action = new URL(url).pathname.split("/").at(-1)!;
		calls.push(action);
		return new Response(
			JSON.stringify({
				requestId,
				status: action === "policy" ? mode : "target_pending_reconcile",
			}),
		);
	});
	const client = createLeadTargetLockClient({
		activationId: voice
			? "voice:11111111-1111-4111-8111-111111111111"
			: "resident:1",
		env: {
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_LEAD_ID: "eng",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
			FLYWHEEL_API_TOKEN: "test-api-secret",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
		},
		...(voice
			? {
					authority: {
						kind: "voice_session" as const,
						sessionId: "11111111-1111-4111-8111-111111111111",
						leaseFence: "lease-secret",
					},
				}
			: {}),
		assertActivationCurrent: current as never,
		fetchImpl: fetchImpl as never,
	});
	return {
		client,
		calls,
		fetchImpl,
		current,
		setMode: (value: string) => {
			mode = value;
		},
		setEnabled: (value: boolean | "absent") => {
			configured = value;
		},
	};
}
describe("resident target-lock rollback policy", () => {
	it("does not acquire locks for a disabled Lead with no outstanding writes", async () => {
		const f = fixture(false);
		expect(await f.client.acquire(input())).toEqual({ status: "unguarded" });
		expect(await f.client.acquire(input())).toEqual({ status: "unguarded" });
		// No cached shortcut: draining can begin after any enable→disable cycle.
		expect(f.calls).toEqual(["policy", "policy"]);
	});
	it("keeps a Lead that never configured voiceBackground on the pre-voice path with no Bridge call", async () => {
		const f = fixture("absent");
		expect(f.client.participates?.()).toBe(false);
		expect(await f.client.acquire(input())).toEqual({ status: "unguarded" });
		expect(f.calls).toEqual([]);
	});
	it("enters draining after an enable→disable cycle even when the resident never wrote while enabled", async () => {
		const f = fixture(false);
		expect(await f.client.acquire(input())).toEqual({ status: "unguarded" });
		f.setEnabled(true);
		// The voice session leaves an unknown row; the resident makes no write meanwhile.
		f.setEnabled(false);
		f.setMode("draining");
		expect(await f.client.acquire(input())).toEqual({
			status: "target_pending_reconcile",
		});
		expect(f.calls).toEqual(["policy", "policy", "acquire"]);
	});
	it("participates for voice and for any configured resident Lead", () => {
		expect(fixture(false).client.participates?.()).toBe(true);
		expect(fixture(true).client.participates?.()).toBe(true);
		expect(fixture("absent", true).client.participates?.()).toBe(true);
	});
	it("continues checking outstanding targets while draining", async () => {
		const f = fixture(false);
		f.setMode("draining");
		expect(await f.client.acquire(input())).toEqual({
			status: "target_pending_reconcile",
		});
		expect(await f.client.acquire(input())).toEqual({
			status: "target_pending_reconcile",
		});
		expect(f.calls).toEqual(["policy", "acquire", "policy", "acquire"]);
	});
	it("never applies the resident disabled shortcut to voice", async () => {
		const f = fixture(false, true);
		expect(await f.client.acquire(input())).toEqual({
			status: "target_pending_reconcile",
		});
		expect(f.calls).toEqual(["acquire"]);
	});
	it("fails closed if the read-only policy lookup cannot be verified", async () => {
		const f = fixture(false);
		f.setMode("unknown");
		await expect(f.client.acquire(input())).rejects.toThrow(
			"target_lock_unavailable",
		);
		expect(f.calls).toEqual(["policy"]);
	});
	it("rechecks authority on every disabled-policy lookup", async () => {
		const f = fixture(false);
		await f.client.acquire(input());
		f.current.mockImplementation(() => {
			throw new Error("revoked");
		});
		await expect(f.client.acquire(input())).rejects.toThrow("revoked");
	});
});

it("retains only a matched settlement ticket after activation revocation", async () => {
	const f = fixture(true, true);
	const fence = "20000000-0000-4000-8000-000000000001";
	f.fetchImpl.mockImplementation(async (url) => {
		const action = new URL(url).pathname.split("/").at(-1)!;
		f.calls.push(action);
		return new Response(
			JSON.stringify({
				requestId,
				status: action === "acquire" ? "acquired" : "released",
				fence,
			}),
		);
	});
	await f.client.acquire(input());
	f.current.mockImplementation(() => {
		throw new Error("revoked");
	});
	const { deadline: _deadline, ...terminal } = input();
	await expect(
		f.client.release({ ...terminal, fence, outcome: "succeeded" }),
	).resolves.toBeUndefined();
	await expect(
		f.client.release({
			...terminal,
			fence: "30000000-0000-4000-8000-000000000001",
			outcome: "succeeded",
		}),
	).rejects.toThrow();
	await expect(f.client.acquire(input())).rejects.toThrow("revoked");
	expect(f.calls).toEqual(["acquire", "release"]);
});

it("records a voice founder-only notice at the fixed Bridge endpoint and requires its correlated receipt", async () => {
	const f = fixture(true, true);
	f.fetchImpl.mockImplementationOnce(
		async () =>
			new Response(
				JSON.stringify({
					requestId,
					status: "recorded",
					receiptId: "lead-event:17",
				}),
			),
	);
	expect(
		await f.client.recordFounderDenial!({
			operationId: "bridge.merge",
			requestId,
		}),
	).toBe("lead-event:17");
	const call = f.fetchImpl.mock.calls[0]!;
	expect(new URL(call[0]).pathname).toBe(
		"/api/lead-capabilities/target-lock/founder-denial",
	);
	f.fetchImpl.mockImplementationOnce(
		async () => new Response(JSON.stringify({ requestId, status: "recorded" })),
	);
	await expect(
		f.client.recordFounderDenial!({ operationId: "bridge.merge", requestId }),
	).rejects.toThrow();
	const resident = fixture(false);
	await expect(
		resident.client.recordFounderDenial!({
			operationId: "bridge.merge",
			requestId,
		}),
	).rejects.toThrow();
	expect(resident.fetchImpl).not.toHaveBeenCalled();
});
