import { describe, expect, it, vi } from "vitest";
import {
	parsePersonaActivationView,
	readPersonaActivation,
} from "../persona-activation-client.js";

const digest = "a".repeat(64);

describe("persona activation client", () => {
	it("uses only master bearer GET inputs and parses a closed decision union", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						kind: "pre-m0",
						contractDigest: digest,
						a0Digest: "b".repeat(64),
						revision: "3",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		await expect(
			readPersonaActivation({
				baseUrl: "http://localhost:9876/",
				token: "master",
				projectName: "raya",
				leadId: "raya",
				fetchFn,
			}),
		).resolves.toMatchObject({ kind: "pre-m0", revision: "3" });
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/lead-persona/activation?projectName=raya&leadId=raya",
			expect.objectContaining({
				method: "GET",
				headers: { Authorization: "Bearer master" },
			}),
		);
	});

	it.each([
		{
			kind: "pre-m0",
			contractDigest: digest,
			a0Digest: digest,
			revision: "1",
			phase: "ready",
		},
		{ kind: "post-m0", contractDigest: digest },
		{ kind: "ready" },
	])("rejects incomplete or caller-injected authority %#", (value) => {
		expect(() => parsePersonaActivationView(value)).toThrow(
			"persona_activation_response_invalid",
		);
	});

	it("turns auth and network failures into closed errors", async () => {
		await expect(
			readPersonaActivation({
				baseUrl: "http://localhost:9876",
				token: "",
				projectName: "raya",
				leadId: "raya",
			}),
		).rejects.toThrow("persona_activation_token_missing");
		await expect(
			readPersonaActivation({
				baseUrl: "http://localhost:9876",
				token: "master",
				projectName: "raya",
				leadId: "raya",
				fetchFn: vi.fn(async () => {
					throw new Error("offline");
				}),
			}),
		).rejects.toThrow("persona_activation_unavailable");
	});
});
