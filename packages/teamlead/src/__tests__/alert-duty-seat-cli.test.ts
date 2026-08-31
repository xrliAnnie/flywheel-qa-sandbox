import { describe, expect, it, vi } from "vitest";
import {
	buildAlertDutySeatReport,
	queryAlertDutySeat,
	runAlertDutySeatCli,
} from "../alert-duty-seat-cli.js";

describe("queryAlertDutySeat", () => {
	it("returns the dispatcher bot id from the Bridge seat probe", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ dispatcherBotUserId: "dispatcher-1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await expect(
			queryAlertDutySeat(
				"http://127.0.0.1:9876",
				fetchImpl,
				"shared-api-token",
			),
		).resolves.toEqual({ dispatcherBotUserId: "dispatcher-1" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/alert-duty/seat",
			{
				headers: { Authorization: "Bearer shared-api-token" },
				signal: expect.any(AbortSignal),
			},
		);
	});

	it("combines the roster seat decision with the Bridge dispatcher", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ dispatcherBotUserId: "dispatcher-1" }), {
					status: 200,
				}),
		);
		await expect(
			buildAlertDutySeatReport({
				leadId: "claude-infra-bot-lead",
				projectName: "flywheel",
				projects: [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "claude-infra-bot-lead",
								alertChannel: "alerts-1",
							},
						],
					},
				],
				env: {},
				bridgeUrl: "http://127.0.0.1:9876",
				fetchImpl,
			}),
		).resolves.toEqual({
			isDutySeat: true,
			alertChannelId: "alerts-1",
			dispatcherBotUserId: "dispatcher-1",
		});
	});

	it("prints a usable seat report and degrades an unreachable Bridge to null", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runAlertDutySeatCli(
			[
				"--lead-id",
				"claude-infra-bot-lead",
				"--project",
				"flywheel",
				"--bridge-url",
				"http://bridge.test",
			],
			{
				env: {},
				loadProjects: () => [
					{
						projectName: "flywheel",
						leads: [
							{
								agentId: "claude-infra-bot-lead",
								alertChannel: "alerts-1",
							},
						],
					},
				],
				fetchImpl: vi.fn(async () => {
					throw new Error("bridge unreachable");
				}),
				writeStdout: (line) => stdout.push(line),
				writeStderr: (line) => stderr.push(line),
			},
		);
		expect(code).toBe(0);
		expect(JSON.parse(stdout.join(""))).toEqual({
			isDutySeat: true,
			alertChannelId: "alerts-1",
			dispatcherBotUserId: null,
		});
		expect(stderr.join("")).toContain("bridge unreachable");
	});

	it("returns usage status when required locators are missing", async () => {
		const stderr: string[] = [];
		await expect(
			runAlertDutySeatCli([], {
				env: {},
				loadProjects: () => [],
				writeStdout: () => {},
				writeStderr: (line) => stderr.push(line),
			}),
		).resolves.toBe(2);
		expect(stderr.join("")).toContain("--lead-id");
	});
});
