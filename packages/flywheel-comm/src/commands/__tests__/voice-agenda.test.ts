import { describe, expect, it } from "vitest";
import { runVoiceAgendaCommand } from "../voice-agenda.js";

const REQUEST = "018f47d2-7b64-7b42-a3df-123456789abc";
const KEY = "k3yk3yk3yk3yk3yk3yk3yk3y";
const ENV = {
	FLYWHEEL_BRIDGE_URL: "http://bridge.test/",
	FLYWHEEL_INGEST_TOKEN: "ingest",
	FLYWHEEL_LEAD_ID: "raya",
};

function harness(status = 200) {
	const calls: Array<{
		url: string;
		body: Record<string, unknown>;
		auth: string;
	}> = [];
	const out: string[] = [];
	const err: string[] = [];
	return {
		calls,
		out,
		err,
		run: (args: string[], env: Record<string, string | undefined> = ENV) =>
			runVoiceAgendaCommand(args, {
				env,
				nextId: () => "client-1",
				stdout: (line) => out.push(line),
				stderr: (line) => err.push(line),
				fetchImpl: (async (url: string, init: RequestInit) => {
					calls.push({
						url,
						body: JSON.parse(String(init.body)),
						auth: String(
							(init.headers as Record<string, string>).Authorization,
						),
					});
					return new Response(JSON.stringify({ ok: status < 400 }), {
						status,
					});
				}) as unknown as typeof fetch,
			}),
	};
}

describe("flywheel-comm voice agenda", () => {
	it("say posts the words bound to the request, item and order", async () => {
		const h = harness();
		const code = await h.run([
			"agenda",
			"say",
			"--request",
			REQUEST,
			"--key",
			KEY,
			"--item",
			"blocked:I1:t",
			"--order",
			"blocked:I1:t,approve:I2:t",
			"--text",
			"两件事，先说受阻那张。",
		]);
		expect(code).toBe(0);
		expect(h.calls).toEqual([
			{
				url: "http://bridge.test/api/voice/agenda/lead/results",
				auth: "Bearer ingest",
				body: {
					requestId: REQUEST,
					leadId: "raya",
					answerKey: KEY,
					clientResultId: "client-1",
					kind: "say",
					itemKey: "blocked:I1:t",
					order: ["blocked:I1:t", "approve:I2:t"],
					text: "两件事，先说受阻那张。",
				},
			},
		]);
	});

	it("say --item none sends a null item", async () => {
		const h = harness();
		await h.run([
			"agenda",
			"say",
			"--request",
			REQUEST,
			"--key",
			KEY,
			"--item",
			"none",
			"--text",
			"我在。",
		]);
		expect(h.calls[0]?.body.itemKey).toBeNull();
	});

	it("close requires evidence for resolved and forbids spoken text", async () => {
		const h = harness();
		expect(
			await h.run([
				"agenda",
				"close",
				"--request",
				REQUEST,
				"--key",
				KEY,
				"--item",
				"blocked:I1:t",
				"--disposition",
				"resolved",
				"--reason",
				"她授权了",
			]),
		).toBe(64);
		expect(
			await h.run([
				"agenda",
				"close",
				"--request",
				REQUEST,
				"--key",
				KEY,
				"--item",
				"blocked:I1:t",
				"--disposition",
				"approved",
				"--reason",
				"x",
			]),
		).toBe(64);
		expect(h.calls).toEqual([]);
		expect(
			await h.run([
				"agenda",
				"close",
				"--request",
				REQUEST,
				"--key",
				KEY,
				"--item",
				"approve:I2:t",
				"--disposition",
				"decision_recorded",
				"--reason",
				"她口头批了，还差在 thread 点",
			]),
		).toBe(0);
		expect(h.calls[0]?.body).toMatchObject({
			kind: "close",
			disposition: "decision_recorded",
			itemKey: "approve:I2:t",
		});
	});

	it("refuses an answer without the delivery key, and has no urgent command", async () => {
		const h = harness();
		expect(
			await h.run([
				"agenda",
				"say",
				"--request",
				REQUEST,
				"--item",
				"none",
				"--text",
				"hi",
			]),
		).toBe(64);
		expect(
			await h.run([
				"agenda",
				"urgent",
				"--channel",
				"100000000000000009",
				"--message",
				"600000000000000001",
				"--reason",
				"security",
			]),
		).toBe(64);
		expect(h.calls).toEqual([]);
	});

	it("reports a Bridge refusal and missing identity or credentials", async () => {
		const refused = harness(403);
		expect(
			await refused.run([
				"agenda",
				"say",
				"--request",
				REQUEST,
				"--key",
				KEY,
				"--item",
				"none",
				"--text",
				"hi",
			]),
		).toBe(2);
		expect(refused.err.join("")).toContain("HTTP 403");
		const h = harness();
		expect(
			await h.run(
				[
					"agenda",
					"say",
					"--request",
					REQUEST,
					"--key",
					KEY,
					"--item",
					"none",
					"--text",
					"hi",
				],
				{ FLYWHEEL_BRIDGE_URL: "http://bridge.test" },
			),
		).toBe(64);
		expect(
			await h.run(
				[
					"agenda",
					"say",
					"--request",
					REQUEST,
					"--key",
					KEY,
					"--item",
					"none",
					"--text",
					"hi",
				],
				{ FLYWHEEL_LEAD_ID: "raya" },
			),
		).toBe(1);
		expect(
			await h.run([
				"agenda",
				"say",
				"--request",
				"not-a-uuid",
				"--item",
				"none",
				"--text",
				"hi",
			]),
		).toBe(64);
	});
});
