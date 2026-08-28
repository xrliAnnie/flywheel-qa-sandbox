import { describe, expect, it, vi } from "vitest";
import { runAlertTicketCommand } from "../alert-ticket.js";

function response(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("flywheel-comm alert-ticket", () => {
	it.each([
		[
			"ack",
			["ack", "--message-id", "root-1"],
			{ action: "ack", messageId: "root-1" },
		],
		[
			"resolve",
			["resolve", "--event-id", "evt-1"],
			{ action: "resolve", eventId: "evt-1" },
		],
		[
			"handoff",
			["handoff", "--event-id", "evt-1", "--to", "eng-lead"],
			{ action: "handoff", eventId: "evt-1", to: "eng-lead" },
		],
	] as const)(
		"posts the %s transition with only the duty bearer",
		async (_name, argv, body) => {
			const fetchImpl = vi.fn(async () => response(200, { ok: true }));
			const code = await runAlertTicketCommand([...argv], {
				env: {
					FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
					FLYWHEEL_BRIDGE_URL: "http://bridge.test/",
					TEAMLEAD_API_TOKEN: "shared-must-not-leak",
				},
				fetchImpl,
				writeStdout: () => {},
				writeStderr: () => {},
			});
			expect(code).toBe(0);
			expect(fetchImpl).toHaveBeenCalledWith(
				"http://bridge.test/duty/alert-tickets/transition",
				expect.objectContaining({
					method: "POST",
					headers: {
						Authorization: "Bearer duty-secret",
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			);
		},
	);

	it("gets a bounded outstanding batch from a since cursor and prints JSON", async () => {
		const stdout: string[] = [];
		const fetchImpl = vi.fn(async () =>
			response(200, { tickets: [{ event_id: "evt-1", resolved: true }] }),
		);
		const code = await runAlertTicketCommand(
			["outstanding", "--json", "--limit", "17", "--since", "opaque-0"],
			{
				env: {
					FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
					BRIDGE_URL: "http://bridge.test",
				},
				fetchImpl,
				writeStdout: (line) => stdout.push(line),
				writeStderr: () => {},
			},
		);
		expect(code).toBe(0);
		expect(JSON.parse(stdout.join(""))).toEqual({
			tickets: [{ event_id: "evt-1", resolved: true }],
		});
		expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({ method: "GET" }),
		);
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(
			"http://bridge.test/duty/alert-tickets/outstanding?limit=17&since=opaque-0",
		);
	});

	it("allows resolve to finish its serial Discord cleanup without widening other requests", async () => {
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => new AbortController().signal);
		const opts = {
			env: {
				FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
				FLYWHEEL_BRIDGE_URL: "http://bridge.test",
			},
			fetchImpl: vi.fn(async () => response(200, { ok: true })),
			writeStdout: () => {},
			writeStderr: () => {},
		};

		expect(
			await runAlertTicketCommand(["resolve", "--event-id", "evt-1"], opts),
		).toBe(0);
		expect(timeout).toHaveBeenLastCalledWith(30_000);

		expect(
			await runAlertTicketCommand(["ack", "--event-id", "evt-1"], opts),
		).toBe(0);
		expect(timeout).toHaveBeenLastCalledWith(5_000);
		timeout.mockRestore();
	});

	it.each([
		[400, 3],
		[403, 3],
		[409, 3],
		[404, 4],
		[503, 5],
	] as const)("maps HTTP %i to exit %i", async (status, expected) => {
		const code = await runAlertTicketCommand(["ack", "--event-id", "evt-1"], {
			env: {
				FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
				FLYWHEEL_BRIDGE_URL: "http://bridge.test",
			},
			fetchImpl: vi.fn(async () => response(status, { error: "nope" })),
			writeStdout: () => {},
			writeStderr: () => {},
		});
		expect(code).toBe(expected);
	});

	it("retries an ACK 404 three times when --wait 30 is requested", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(response(404, { error: "ticket_not_found" }))
			.mockResolvedValueOnce(response(404, { error: "ticket_not_found" }))
			.mockResolvedValueOnce(response(404, { error: "ticket_not_found" }))
			.mockResolvedValueOnce(response(200, { action: "ack" }));
		const delay = vi.fn(async () => {});
		const code = await runAlertTicketCommand(
			["ack", "--message-id", "root-1", "--wait", "30"],
			{
				env: {
					FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
					FLYWHEEL_BRIDGE_URL: "http://bridge.test",
				},
				fetchImpl,
				delay,
				writeStdout: () => {},
				writeStderr: () => {},
			},
		);
		expect(code).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(delay).toHaveBeenCalledTimes(3);
		expect(delay).toHaveBeenCalledWith(10_000);
	});

	it("rejects ambiguous locators and missing duty configuration before fetch", async () => {
		const fetchImpl = vi.fn();
		expect(
			await runAlertTicketCommand(
				["resolve", "--message-id", "root", "--event-id", "evt"],
				{
					env: { FLYWHEEL_ALERT_DUTY_TOKEN: "duty" },
					fetchImpl,
					writeStdout: () => {},
					writeStderr: () => {},
				},
			),
		).toBe(2);
		expect(
			await runAlertTicketCommand(["outstanding"], {
				env: { FLYWHEEL_BRIDGE_URL: "http://bridge.test" },
				fetchImpl,
				writeStdout: () => {},
				writeStderr: () => {},
			}),
		).toBe(5);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
