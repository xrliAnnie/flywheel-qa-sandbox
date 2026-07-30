import { FenceViolation } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { provisionAgentRecipient } from "../enqueue.js";
import {
	reattachAgent,
	registerAgentTx,
	type SessionEvidenceProbe,
} from "../registration.js";
import type { RegisteredAgent, SessionBinding } from "../types.js";
import {
	type EngineFixture,
	makeEngineFixture,
	testSessionBinding,
} from "./helpers.js";

function liveProbe(
	binding: SessionBinding,
	overrides: Partial<SessionEvidenceProbe> = {},
): SessionEvidenceProbe {
	return {
		processStart: () => ({
			status: "present" as const,
			startIdentity: binding.pidStart,
		}),
		sessionOwner: () => ({
			pid: binding.pid,
			pidStart: binding.pidStart,
		}),
		...overrides,
	};
}

function registerLead(
	fixture: EngineFixture,
	instanceId = "instance-1",
): RegisteredAgent {
	return fixture.kernel.write("test.register-lead", (tx) =>
		registerAgentTx(tx, fixture.runtime, "lead-a", {
			kind: "lead",
			leadId: "lead-a",
			instanceId,
			sessionBinding: testSessionBinding(instanceId),
		}),
	);
}

describe("generation-scoped session reattach", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("reattaches an idle lead only when process, start-time, session, and host epoch all match", () => {
		fixture = makeEngineFixture();
		const expected = registerLead(fixture);
		fixture.kernel.write("test.offline", (tx) => {
			tx.run("UPDATE agents SET state='offline' WHERE agent_id='lead-a'");
		});

		expect(
			reattachAgent({
				kernel: fixture.kernel,
				runtime: fixture.runtime,
				expected,
				hostEpoch: "test-host-epoch",
				probe: liveProbe(expected.sessionBinding),
			}),
		).toEqual(expected);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM agents WHERE agent_id='lead-a'",
					)?.state,
			),
		).toBe("online");
	});

	it.each([
		["wrong instance", { instanceId: "instance-other" }],
		["wrong generation", { generation: 2 }],
	])("rejects a %s without changing durable identity", (_label, override) => {
		fixture = makeEngineFixture();
		const current = registerLead(fixture);
		const expected = { ...current, ...override } as RegisteredAgent;

		expect(() =>
			reattachAgent({
				kernel: fixture?.kernel as EngineFixture["kernel"],
				runtime: fixture?.runtime as EngineFixture["runtime"],
				expected,
				hostEpoch: "test-host-epoch",
				probe: liveProbe(current.sessionBinding),
			}),
		).toThrow(FenceViolation);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ generation: number; instance_id: string }>(
					"SELECT generation,instance_id FROM agents WHERE agent_id='lead-a'",
				),
			),
		).toEqual({ generation: 1, instance_id: "instance-1" });
	});

	it("rejects stale PID start-time evidence", () => {
		fixture = makeEngineFixture();
		const expected = registerLead(fixture);
		expect(() =>
			reattachAgent({
				kernel: fixture?.kernel as EngineFixture["kernel"],
				runtime: fixture?.runtime as EngineFixture["runtime"],
				expected,
				hostEpoch: "test-host-epoch",
				probe: liveProbe(expected.sessionBinding, {
					processStart: () => ({
						status: "present",
						startIdentity: "reused-pid-start",
					}),
				}),
			}),
		).toThrow(/process start identity/);
	});

	it("rejects session/socket reuse by a different process incarnation", () => {
		fixture = makeEngineFixture();
		const expected = registerLead(fixture);
		expect(() =>
			reattachAgent({
				kernel: fixture?.kernel as EngineFixture["kernel"],
				runtime: fixture?.runtime as EngineFixture["runtime"],
				expected,
				hostEpoch: "test-host-epoch",
				probe: liveProbe(expected.sessionBinding, {
					sessionOwner: () => ({
						pid: expected.sessionBinding.pid + 1,
						pidStart: "different-process-start",
					}),
				}),
			}),
		).toThrow(/session owner/);
	});

	it("rejects a stale host epoch", () => {
		fixture = makeEngineFixture();
		const expected = registerLead(fixture);
		expect(() =>
			reattachAgent({
				kernel: fixture?.kernel as EngineFixture["kernel"],
				runtime: fixture?.runtime as EngineFixture["runtime"],
				expected,
				hostEpoch: "new-host-epoch",
				probe: liveProbe(expected.sessionBinding),
			}),
		).toThrow(/host epoch/);
	});

	it("rejects provisioned null-binding rows", () => {
		fixture = makeEngineFixture();
		provisionAgentRecipient(fixture.kernel, "lead-a", "lead");
		const binding = testSessionBinding("instance-1");
		expect(() =>
			reattachAgent({
				kernel: fixture?.kernel as EngineFixture["kernel"],
				runtime: fixture?.runtime as EngineFixture["runtime"],
				expected: {
					kind: "lead",
					agentId: "lead-a",
					instanceId: "instance-1",
					generation: 0,
					sessionBinding: binding,
				},
				hostEpoch: "test-host-epoch",
				probe: liveProbe(binding),
			}),
		).toThrow(/not reattachable/);
	});

	it("loses its exact-binding CAS when a concurrent generation takeover wins", () => {
		fixture = makeEngineFixture();
		const expected = registerLead(fixture);
		let replaced = false;
		const probe = liveProbe(expected.sessionBinding, {
			processStart: () => {
				if (!replaced) {
					replaced = true;
					fixture?.kernel.write("test.concurrent-takeover", (tx) =>
						registerAgentTx(
							tx,
							fixture?.runtime as EngineFixture["runtime"],
							"lead-a",
							{
								kind: "lead",
								leadId: "lead-a",
								instanceId: "instance-2",
								sessionBinding: testSessionBinding("instance-2"),
							},
							{
								agentId: "lead-a",
								generation: 1,
								confirmedAbsentAt: fixture?.clock.nowIso() as string,
							},
						),
					);
				}
				return {
					status: "present",
					startIdentity: expected.sessionBinding.pidStart,
				};
			},
		});

		expect(() =>
			reattachAgent({
				kernel: fixture?.kernel as EngineFixture["kernel"],
				runtime: fixture?.runtime as EngineFixture["runtime"],
				expected,
				hostEpoch: "test-host-epoch",
				probe,
			}),
		).toThrow(/binding changed during reattach/);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{
					generation: number;
					instance_id: string;
					session_binding: string;
				}>(
					"SELECT generation,instance_id,session_binding FROM agents WHERE agent_id='lead-a'",
				),
			),
		).toEqual({
			generation: 2,
			instance_id: "instance-2",
			session_binding: JSON.stringify({
				v: 1,
				host_epoch: "test-host-epoch",
				session_id: "session-instance-2",
				pid: 10_001,
				pid_start: "test-start-instance-2",
			}),
		});
	});
});
