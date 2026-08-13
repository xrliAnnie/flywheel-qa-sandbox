import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nudgeLeadInboxBestEffort } from "../lead-inbox-nudge.js";

describe("FLY-1373 lead inbox doorbell", () => {
	it("posts the target Lead and project with bearer auth", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));

		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876/",
			leadId: "flywheel-eng-lead",
			project: "flywheel",
			apiToken: "bridge-token",
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("http://127.0.0.1:9876/api/lead-inbox/nudge");
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer bridge-token",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			leadId: "flywheel-eng-lead",
			project: "flywheel",
		});
	});

	it("is best-effort when the Bridge is unavailable", async () => {
		const warn = vi.fn();
		await expect(
			nudgeLeadInboxBestEffort({
				bridgeUrl: "http://127.0.0.1:9876",
				leadId: "lead-a",
				fetchImpl: async () => {
					throw new Error("connection refused");
				},
				warn,
			}),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("connection refused"),
		);
	});

	it.each([401, 403])(
		"reloads the Bridge token once after a %s response",
		async (status) => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(new Response(null, { status }))
				.mockResolvedValueOnce(new Response(null, { status: 202 }));
			const resolveApiToken = vi.fn(() => "rotated-token");
			const warn = vi.fn();

			await nudgeLeadInboxBestEffort({
				bridgeUrl: "http://127.0.0.1:9876",
				leadId: "flywheel-eng-lead",
				apiToken: "stale-token",
				resolveApiToken,
				fetchImpl,
				warn,
			});

			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(resolveApiToken).toHaveBeenCalledOnce();
			expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
				Authorization: "Bearer stale-token",
			});
			expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
				Authorization: "Bearer rotated-token",
			});
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it("reloads TEAMLEAD_API_TOKEN from the live env file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1374-nudge-"));
		const apiTokenFile = join(dir, ".env");
		writeFileSync(
			apiTokenFile,
			"OTHER=value\nexport TEAMLEAD_API_TOKEN='rotated-from-file'\n",
		);
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(new Response(null, { status: 202 }));

		try {
			await nudgeLeadInboxBestEffort({
				bridgeUrl: "http://127.0.0.1:9876",
				leadId: "flywheel-eng-lead",
				apiToken: "stale-token",
				apiTokenFile,
				fetchImpl,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer rotated-from-file",
		});
	});

	it("warns once when the token-reloaded retry is still unauthorized", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const warn = vi.fn();

		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876",
			leadId: "flywheel-eng-lead",
			apiToken: "stale-token",
			resolveApiToken: () => "still-wrong-token",
			fetchImpl,
			warn,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("returned 403"));
	});

	it("does not reload or retry for a non-auth HTTP failure", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
		const resolveApiToken = vi.fn(() => "rotated-token");
		const warn = vi.fn();

		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876",
			leadId: "flywheel-eng-lead",
			apiToken: "stale-token",
			resolveApiToken,
			fetchImpl,
			warn,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(resolveApiToken).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("returned 500"));
	});

	it("FLY-1715: ingest is normalized, used when master is absent, and never triggers master reload", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
		const resolveApiToken = vi.fn(() => "must-not-be-read");
		const warn = vi.fn();

		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876",
			leadId: "flywheel-eng-lead",
			ingestToken: "  ingest-token  ",
			resolveApiToken,
			fetchImpl,
			warn,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer ingest-token",
		});
		expect(resolveApiToken).not.toHaveBeenCalled();
	});

	it("FLY-1715: master is preferred over ingest and blank credentials never trigger disk reload", async () => {
		const masterFetch = vi.fn(async () => new Response(null, { status: 202 }));
		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876",
			leadId: "flywheel-eng-lead",
			apiToken: " master-token ",
			ingestToken: "ingest-token",
			fetchImpl: masterFetch,
		});
		expect(masterFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer master-token",
		});

		const noCredentialFetch = vi.fn(
			async () => new Response(null, { status: 401 }),
		);
		const resolveApiToken = vi.fn(() => "must-not-be-read");
		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876",
			leadId: "flywheel-eng-lead",
			apiToken: "  ",
			ingestToken: "",
			resolveApiToken,
			fetchImpl: noCredentialFetch,
			warn: () => {},
		});
		expect(resolveApiToken).not.toHaveBeenCalled();
	});
});
