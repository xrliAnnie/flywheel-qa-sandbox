import { describe, expect, it, vi } from "vitest";
import {
	createTmuxRescueClient,
	parseTmuxSocketInspection,
} from "../tmux-rescue-client.js";

const SOCKET = "/private/tmp/tmux-501/default";

describe("Bridge tmux rescue CLI client", () => {
	it("accepts only the exhaustive inspect schema", () => {
		expect(
			parseTmuxSocketInspection(
				JSON.stringify({
					verdict: "reachable",
					socketPresent: true,
					socketPath: SOCKET,
					reachablePid: 123,
					candidatePids: [],
					scanComplete: true,
				}),
			),
		).toMatchObject({ verdict: "reachable", reachablePid: 123 });
		for (const malformed of [
			"not json",
			JSON.stringify({ verdict: "maybe" }),
			JSON.stringify({
				verdict: "dead",
				socketPresent: false,
				socketPath: SOCKET,
				candidatePids: ["bad"],
				scanComplete: true,
			}),
		]) {
			expect(() => parseTmuxSocketInspection(malformed)).toThrow();
		}
	});

	it("uses explicit CLI/socket argv and bounded exec", async () => {
		const exec = vi.fn().mockResolvedValue({
			stdout: JSON.stringify({
				verdict: "dead",
				socketPresent: false,
				socketPath: SOCKET,
				candidatePids: [],
				scanComplete: true,
			}),
			stderr: "",
		});
		const client = createTmuxRescueClient({
			cliPath: "/runtime/tmux-server-rescue",
			socketPath: SOCKET,
			exec,
		});
		expect((await client.inspect()).verdict).toBe("dead");
		expect(exec).toHaveBeenCalledWith(
			"/runtime/tmux-server-rescue",
			["inspect", SOCKET],
			expect.objectContaining({ timeout: 10_000, encoding: "utf8" }),
		);
	});

	it("recover is true only for a restored original server", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: '{"action":"rescued","reachablePid":7}',
			})
			.mockResolvedValueOnce({ stdout: '{"action":"hold_unknown"}' });
		const client = createTmuxRescueClient({
			cliPath: "/runtime/tmux-server-rescue",
			socketPath: SOCKET,
			exec,
		});
		expect(await client.recover()).toBe(true);
		expect(await client.recover()).toBe(false);
	});
});
