/**
 * FLY-1006 S7 — /eleven config resolution: byte-compat when absent, fail-fast
 * with fix guidance when malformed (assistant/config.ts discipline).
 */
import { describe, expect, it } from "vitest";
import { resolveElevenConfig } from "../eleven/config.js";

const ENV = { ELEVENLABS_API_KEY: "xi-key" } as NodeJS.ProcessEnv;

describe("resolveElevenConfig (FLY-1006 S7)", () => {
	it("absent block = OFF (null) — daemon byte-compat with FLY-967", () => {
		expect(resolveElevenConfig([], ENV)).toBe(null);
		expect(resolveElevenConfig([{ huddle: {} }], ENV)).toBe(null);
		expect(resolveElevenConfig(undefined, ENV)).toBe(null);
	});

	it("agentId is required with runbook guidance", () => {
		expect(() =>
			resolveElevenConfig([{ huddle: { eleven: {} } }], ENV),
		).toThrow(/agentId.*m1-rig/s);
	});

	it("missing api key env fails fast at load, not mid-session", () => {
		expect(() =>
			resolveElevenConfig(
				[{ huddle: { eleven: { agentId: "agent_x" } } }],
				{} as NodeJS.ProcessEnv,
			),
		).toThrow(/ELEVENLABS_API_KEY/);
	});

	it("defaults + explicit fields resolve", () => {
		const cfg = resolveElevenConfig(
			[
				{
					huddle: {
						eleven: {
							agentId: "agent_x",
							voiceId: "v1",
							waitingCuePath: "/tmp/cue.wav",
						},
					},
				},
			],
			ENV,
		);
		expect(cfg).toMatchObject({
			commandName: "eleven",
			agentId: "agent_x",
			apiKeyEnv: "ELEVENLABS_API_KEY",
			shimHealthUrl: "http://127.0.0.1:8980/health",
			voiceId: "v1",
			waitingCuePath: "/tmp/cue.wav",
		});
	});
});
