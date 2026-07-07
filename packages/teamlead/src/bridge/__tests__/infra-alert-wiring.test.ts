/**
 * FLY-927 (Task 1.1/1.5 wiring): integration coverage of the Router glue
 * against a REAL in-memory StateStore — the exact resolution chain plugin.ts
 * installs (sessions → resolveLeadForIssue → chat_threads → issue-thread leg).
 * Sweeps the WHOLE AlertEventType union so a future kind cannot silently
 * bypass the funnel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ALERT_EVENT_TYPES,
	type AlertEventType,
	type AlertPayload,
	type AlertResult,
} from "../../LeadAlertNotifier.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { buildInfraAlertRouting } from "../infra-alert-wiring.js";
import { ISSUE_PROGRESS_KINDS } from "../infra-event-router.js";

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "chan-eng",
				match: { labels: ["Flywheel"] },
				botToken: "eng-bot-token",
			},
		],
	},
] as unknown as ProjectEntry[];

const EXEC = "exec-927";

function payload(eventType: AlertEventType): AlertPayload {
	return {
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		eventId: `e-${eventType}`,
		eventType,
		title: "T",
		body: "B",
		severity: "warning",
		sessionKey: EXEC,
	};
}

describe("buildInfraAlertRouting (plugin glue, real StateStore)", () => {
	let store: StateStore;
	let rawSink: { alert: ReturnType<typeof vi.fn> };
	let fetchImpl: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "issue-uuid-927",
			issue_identifier: "FLY-927",
			issue_title: "t",
			issue_labels: JSON.stringify(["Flywheel"]),
			project_name: "flywheel",
			status: "running",
		});
		store.upsertChatThread("thread-927", "chan-eng", "issue-uuid-927");
		rawSink = {
			alert: vi.fn(async (): Promise<AlertResult> => ({ sent: true })),
		};
		fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => ({ id: "m-1" }),
			text: async () => "",
		}));
	});

	function makeSink(routing = true) {
		return buildInfraAlertRouting({
			store,
			projects,
			globalBotToken: "global-token",
			rawSink,
			routingEnabled: () => routing,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			sleepFn: async () => {},
			logger: () => {},
		});
	}

	it("FULL-UNION SWEEP (routing ON): progress kinds with a bound thread go to the thread; every other kind hits the raw sink", async () => {
		const sink = makeSink(true);
		for (const kind of ALERT_EVENT_TYPES) {
			rawSink.alert.mockClear();
			fetchImpl.mockClear();
			const result = await sink.alert(payload(kind));
			if (ISSUE_PROGRESS_KINDS.has(kind)) {
				expect(fetchImpl, `${kind} should deliver to the issue thread`)
					.toHaveBeenCalledTimes(1);
				expect(
					(fetchImpl.mock.calls[0] as unknown as [string])[0],
				).toContain("/channels/thread-927/messages");
				expect(rawSink.alert).not.toHaveBeenCalled();
				expect(result).toEqual({ sent: true });
			} else {
				expect(rawSink.alert, `${kind} should hit the raw sink`)
					.toHaveBeenCalledTimes(1);
				expect(fetchImpl).not.toHaveBeenCalled();
			}
		}
	});

	it("SENTINEL (routing OFF): every kind passes straight through to the raw sink", async () => {
		const sink = makeSink(false);
		for (const kind of ALERT_EVENT_TYPES) {
			rawSink.alert.mockClear();
			await sink.alert(payload(kind));
			expect(rawSink.alert).toHaveBeenCalledTimes(1);
			expect(fetchImpl).not.toHaveBeenCalled();
		}
	});

	it("progress kind WITHOUT a bound thread fail-safes to the raw sink", async () => {
		const sink = makeSink(true);
		const p = { ...payload("three_stage_stuck"), sessionKey: "no-such-exec" };
		await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledTimes(1);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("issue-thread delivery failure routes the ORIGINAL alert to the raw sink (never silent)", async () => {
		fetchImpl.mockImplementation(async () => ({
			ok: false,
			status: 403,
			headers: { get: () => null },
			text: async () => "forbidden",
		}));
		const sink = makeSink(true);
		const p = payload("three_stage_stuck");
		const result = await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(result).toEqual({ sent: true }); // the raw sink's result surfaces
	});

	it("thread post uses the owning lead's bot token", async () => {
		const sink = makeSink(true);
		await sink.alert(payload("three_stage_stuck"));
		const init = (
			fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		)[1];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot eng-bot-token",
		);
	});
});
