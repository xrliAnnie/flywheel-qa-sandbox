import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
			"handoff",
			[
				"handoff",
				"--event-id",
				"evt-1",
				"--to",
				"eng-lead",
				"--reason",
				"contact_book",
				"--note",
				"owner confirmed",
			],
			{
				action: "handoff",
				eventId: "evt-1",
				to: "eng-lead",
				reason: "contact_book",
				note: "owner confirmed",
			},
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

	it("looks up either alert lane with the duty bearer", async () => {
		const stdout: string[] = [];
		const fetchImpl = vi.fn(async () =>
			response(200, {
				lane: "mailbox",
				correlationKey: "fw|lead|rate_limit|",
				eventId: "evt-lookup",
				kind: "rate_limit",
				ref: "alert-ticket lookup --event-id evt-lookup",
			}),
		);
		const code = await runAlertTicketCommand(
			["lookup", "--event-id", "evt-lookup", "--json"],
			{
				env: {
					FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
					FLYWHEEL_BRIDGE_URL: "http://bridge.test",
				},
				fetchImpl,
				writeStdout: (line) => stdout.push(line),
				writeStderr: () => {},
			},
		);

		expect(code).toBe(0);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://bridge.test/duty/alert-tickets/lookup?eventId=evt-lookup",
			expect.objectContaining({ method: "GET" }),
		);
		expect(JSON.parse(stdout.join(""))).toMatchObject({
			lane: "mailbox",
			eventId: "evt-lookup",
		});
	});

	it("resolves only after lookup and a validated runbook draft receipt", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2386-alert-resolve-"));
		const draftPath = join(stateRoot, "resolution.md");
		writeFileSync(
			draftPath,
			"## Signal\nQueue depth stayed high.\n\n## Diagnosis\nA worker lease was stale.\n\n## Action\nReclaimed the stale lease.\n\n## Verification\nQueue depth returned to zero.\n\n## Rollback\nRestore the lease row if needed.\n",
		);
		const order: string[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init) => {
			if (String(url).includes("/lookup?")) {
				order.push("lookup");
				return response(200, {
					lane: "mailbox",
					correlationKey: "fw|lead|bridge_abnormal_exit|",
					eventId: "evt-resolve",
					kind: "bridge_abnormal_exit",
					ref: "alert-ticket lookup --event-id evt-resolve",
				});
			}
			order.push("transition");
			return response(200, {
				ok: true,
				request: JSON.parse(String(init?.body)),
			});
		});
		const stdout: string[] = [];
		const code = await runAlertTicketCommand(
			["resolve", "--event-id", "evt-resolve", "--draft", draftPath],
			{
				env: {
					FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
					FLYWHEEL_BRIDGE_URL: "http://bridge.test",
					FLYWHEEL_STATE_DIR: stateRoot,
					FLYWHEEL_LEAD_ID: "claude-infra-bot-lead",
				},
				fetchImpl: fetchImpl as typeof fetch,
				writeStdout: (line) => stdout.push(line),
				writeStderr: () => {},
			},
		);

		expect(code).toBe(0);
		expect(order).toEqual(["lookup", "transition"]);
		const transition = fetchImpl.mock.calls[1];
		expect(transition?.[0]).toBe(
			"http://bridge.test/duty/alert-tickets/transition",
		);
		expect(JSON.parse(String(transition?.[1]?.body))).toEqual({
			action: "resolve",
			eventId: "evt-resolve",
			draftId: expect.stringMatching(
				/^runbook--bridge-abnormal-exit--[a-f0-9]{16}$/,
			),
		});
		expect(stdout.join("")).toContain("alert-ticket resolve: ok");
	});

	it("does not POST resolve when the runbook draft guard rejects the file", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2386-alert-reject-"));
		const draftPath = join(stateRoot, "unsafe.md");
		writeFileSync(draftPath, "Contact operator@example.com\n");
		const fetchImpl = vi.fn(async () =>
			response(200, {
				lane: "thread",
				correlationKey: "fw|lead|auth|",
				eventId: "evt-reject",
				kind: "auth",
				ref: "https://discord.test/thread",
			}),
		);
		const code = await runAlertTicketCommand(
			["resolve", "--event-id", "evt-reject", "--draft", draftPath],
			{
				env: {
					FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
					FLYWHEEL_BRIDGE_URL: "http://bridge.test",
					FLYWHEEL_STATE_DIR: stateRoot,
				},
				fetchImpl,
				writeStdout: () => {},
				writeStderr: () => {},
			},
		);

		expect(code).toBe(3);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/lookup?");
	});

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

	it("prints the board as JSON and carries a continuation cursor", async () => {
		const stdout: string[] = [];
		const fetchImpl = vi.fn(async () =>
			response(200, {
				totals: {
					unreviewed: 1,
					in_duty: 2,
					handed_off: 3,
					resolved_in_window: 4,
				},
				items: [],
				nextCursor: "page-2",
				truncated: true,
			}),
		);
		const code = await runAlertTicketCommand(
			[
				"board",
				"--json",
				"--resolved-since",
				"2026-09-01T00:00:00.000Z",
				"--limit",
				"40",
				"--cursor",
				"page-1",
			],
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
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
			"http://bridge.test/duty/alert-board?resolvedSince=2026-09-01T00%3A00%3A00.000Z&limit=40&cursor=page-1",
		);
		expect(JSON.parse(stdout.join(""))).toMatchObject({ nextCursor: "page-2" });
	});

	it("prints a human-readable two-lane board and its next cursor", async () => {
		const stdout: string[] = [];
		const code = await runAlertTicketCommand(["board"], {
			env: {
				FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
				BRIDGE_URL: "http://bridge.test",
			},
			fetchImpl: vi.fn(async () =>
				response(200, {
					totals: {
						unreviewed: 1,
						in_duty: 0,
						handed_off: 0,
						resolved_in_window: 0,
					},
					items: [
						{
							lane: "mailbox",
							kind: "rate_limit",
							state: "unreviewed",
							ownerRef: null,
							routeClass: "duty",
							handoffLetter: null,
							fireCount: 2,
							openedAt: "2026-09-06T12:00:00.000Z",
						},
					],
					nextCursor: "page-2",
					truncated: true,
				}),
			),
			writeStdout: (line) => stdout.push(line),
			writeStderr: () => {},
		});

		expect(code).toBe(0);
		expect(stdout.join("")).toContain(
			"unreviewed=1 in_duty=0 handed_off=0 resolved_in_window=0",
		);
		expect(stdout.join("")).toContain("mailbox\trate_limit\tunreviewed");
		expect(stdout.join("")).toContain("nextCursor=page-2");
	});

	it("allows resolve to finish its serial Discord cleanup without widening other requests", async () => {
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => new AbortController().signal);
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2386-alert-timeout-"));
		const draftPath = join(stateRoot, "resolution.md");
		writeFileSync(draftPath, "Mitigated and verified with rollback steps.\n");
		const opts = {
			env: {
				FLYWHEEL_ALERT_DUTY_TOKEN: "duty-secret",
				FLYWHEEL_BRIDGE_URL: "http://bridge.test",
				FLYWHEEL_STATE_DIR: stateRoot,
			},
			fetchImpl: vi.fn(async (url: string | URL | Request) =>
				String(url).includes("/lookup?")
					? response(200, {
							lane: "mailbox",
							correlationKey: "fw|lead|rate_limit|",
							eventId: "evt-1",
							kind: "rate_limit",
							ref: "alert-ticket lookup --event-id evt-1",
						})
					: response(200, { ok: true }),
			),
			writeStdout: () => {},
			writeStderr: () => {},
		};

		expect(
			await runAlertTicketCommand(
				["resolve", "--event-id", "evt-1", "--draft", draftPath],
				opts,
			),
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

	it("requires handoff reason and resolve draft before fetch", async () => {
		const fetchImpl = vi.fn();
		const opts = {
			env: {
				FLYWHEEL_ALERT_DUTY_TOKEN: "duty",
				FLYWHEEL_BRIDGE_URL: "http://bridge.test",
			},
			fetchImpl,
			writeStdout: () => {},
			writeStderr: () => {},
		};
		expect(
			await runAlertTicketCommand(
				["handoff", "--event-id", "evt", "--to", "lead-a"],
				opts,
			),
		).toBe(2);
		expect(
			await runAlertTicketCommand(["resolve", "--event-id", "evt"], opts),
		).toBe(2);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("prints the fixed duty-write-path diagnostic for server 503", async () => {
		const stderr: string[] = [];
		const code = await runAlertTicketCommand(["board"], {
			env: {
				FLYWHEEL_ALERT_DUTY_TOKEN: "duty",
				FLYWHEEL_BRIDGE_URL: "http://bridge.test",
			},
			fetchImpl: vi.fn(async () =>
				response(503, { error: "alert_duty_unconfigured" }),
			),
			writeStdout: () => {},
			writeStderr: (line) => stderr.push(line),
		});

		expect(code).toBe(5);
		expect(stderr.join("")).toBe(
			"alert-ticket: duty write path unconfigured on Bridge (FLYWHEEL_ALERT_DUTY_TOKEN)\n",
		);
	});
});
