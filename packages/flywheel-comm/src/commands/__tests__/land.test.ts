import { describe, expect, it, vi } from "vitest";
import { runLandCommand } from "../land.js";

const ARGS = [
	"reclose",
	"--operation",
	"land:one",
	"--expected-generation",
	"3",
	"--expected-head",
	"a".repeat(40),
	"--reason",
	"retry closeout evidence",
	"--request-id",
	"11111111-1111-4111-8111-111111111111",
];

describe("flywheel-comm land reclose", () => {
	it("uses the native peer transport for a Claude Lead without sending a bearer", async () => {
		const peerJson = vi.fn(async () => ({
			requestId: "11111111-1111-4111-8111-111111111111",
			ok: true,
			operation: { state: "partial", resume_generation: 4 },
		}));
		const log = vi.fn();
		await expect(
			runLandCommand(ARGS, {
				env: {
					FLYWHEEL_PROJECT_NAME: "flywheel",
					FLYWHEEL_LEAD_ID: "flywheel-eng-lead",
					FLYWHEEL_RECLOSE_PEER_SOCKET: "/private/peer.sock",
				},
				authorizeLead: () => ({
					disposition: "lease_validated",
					identityDigest: "b".repeat(64),
				}),
				peerJson,
				log,
				errorLog: vi.fn(),
			}),
		).resolves.toBe(0);
		expect(peerJson).toHaveBeenCalledWith(
			"/private/peer.sock",
			expect.objectContaining({
				method: "land.reclose",
				operationId: "land:one",
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
			}),
		);
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({ state: "partial", resume_generation: 4 }),
		);
	});

	it("uses the Codex carrier on the token-authenticated HTTP route", async () => {
		const httpJson = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ state: "partial", resume_generation: 4 }),
		}));
		await expect(
			runLandCommand(ARGS, {
				env: {
					TEAMLEAD_API_TOKEN: "master-secret",
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
					FLYWHEEL_PROJECT_NAME: "flywheel",
					FLYWHEEL_LEAD_ID: "flywheel-eng-lead",
					FLYWHEEL_LEAD_CAPABILITY_ACTIVATION:
						"11111111-1111-4111-8111-111111111112",
				},
				authorizeLead: () => ({
					disposition: "carrier_passthrough",
					identityDigest: "b".repeat(64),
					carrierClaim: "private-carrier",
				}),
				httpJson,
				log: vi.fn(),
				errorLog: vi.fn(),
			}),
		).resolves.toBe(0);
		expect(httpJson).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/lifecycle/land/land%3Aone/resume",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer master-secret",
					"X-Flywheel-Lead-Context": expect.any(String),
				}),
				body: JSON.stringify({
					mode: "closeout_only",
					expectedResumeGeneration: 3,
					expectedApprovedHead: "a".repeat(40),
					reason: "retry closeout evidence",
					requestId: "11111111-1111-4111-8111-111111111111",
				}),
			}),
		);
	});

	it("fails closed without current Lead identity or an exact tuple", async () => {
		const httpJson = vi.fn();
		const peerJson = vi.fn();
		const errorLog = vi.fn();
		expect(
			await runLandCommand(["reclose", "--operation", "land:one"], {
				env: {},
				httpJson,
				peerJson,
				log: vi.fn(),
				errorLog,
			}),
		).toBe(1);
		expect(httpJson).not.toHaveBeenCalled();
		expect(peerJson).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalled();
	});
});
