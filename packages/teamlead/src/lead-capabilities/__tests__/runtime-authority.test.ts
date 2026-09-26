import { expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn());
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: (env: NodeJS.ProcessEnv) => {
		context(env);
		return { assertActivationCurrent: () => "resident" };
	},
}));
const { resolveLeadCapabilityRuntimeAuthority } = await import(
	"../runtime-authority.js"
);

it("keeps the pre-union resident path: registry context without a carrier claim until authority is read", () => {
	const resolved = resolveLeadCapabilityRuntimeAuthority({
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
	});
	// Handlers that only need the trusted registry context construct as before.
	const { trusted } = resolved;
	expect(trusted.assertActivationCurrent()).toBe("resident");
	expect(context).toHaveBeenCalledOnce();
	// Consumers that put an authority on the wire still fail closed.
	expect(() => resolved.authority).toThrow("capability_authority_missing");
	expect(() => resolved.authoritySecret).toThrow(
		"capability_authority_missing",
	);
});

it("derives the carrier authority from the resident environment", () => {
	const resolved = resolveLeadCapabilityRuntimeAuthority({
		env: { FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier-1" },
	});
	expect(resolved.authority).toEqual({
		kind: "carrier",
		carrierClaim: "carrier-1",
	});
	expect(resolved.authoritySecret).toBe("carrier-1");
});

it("uses the explicit voice authority and its trusted activation check", () => {
	const assertActivationCurrent = vi.fn(() => "voice" as never);
	const resolved = resolveLeadCapabilityRuntimeAuthority({
		env: {},
		authority: {
			kind: "voice_session",
			sessionId: "11111111-1111-4111-8111-111111111111",
			leaseFence: "fence-1",
		},
		assertActivationCurrent,
	});
	expect(resolved.authority.kind).toBe("voice_session");
	expect(resolved.authoritySecret).toBe("fence-1");
	expect(resolved.trusted.assertActivationCurrent).toBe(
		assertActivationCurrent,
	);
});
