import { describe, expect, it, vi } from "vitest";
import { resolveBrowserEgressTarget } from "../browser-egress.js";

describe("native browser egress destination", () => {
	it("pins a public address once and refuses private answers including mixed DNS", async () => {
		const lookup = vi
			.fn()
			.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
		const target = await resolveBrowserEgressTarget(
			"https://example.com/report",
			{ lookup },
		);
		expect(target).toMatchObject({
			hostname: "example.com",
			address: "93.184.216.34",
			family: 4,
			port: 443,
		});
		expect(lookup).toHaveBeenCalledTimes(1);
		lookup.mockResolvedValue([
			{ address: "93.184.216.34", family: 4 },
			{ address: "127.0.0.1", family: 4 },
		]);
		await expect(
			resolveBrowserEgressTarget("https://example.com/report", { lookup }),
		).rejects.toThrow(/egress/);
	});
});

it.each([
	"http://127.0.0.1",
	"http://127.1",
	"http://2130706433",
	"http://0x7f000001",
	"http://0177.0.0.1",
	"http://10.0.0.1",
	"http://172.16.0.1",
	"http://192.168.1.1",
	"http://169.254.169.254",
	"http://100.100.100.200",
	"http://0.0.0.0",
	"http://224.0.0.1",
	"http://255.255.255.255",
	"http://[::1]",
	"http://[::ffff:127.0.0.1]",
	"http://[::ffff:7f00:1]",
	"http://[fc00::1]",
	"http://[fe80::1]",
	"http://[64:ff9b::7f00:1]",
	"http://[2002:7f00:1::]",
	"http://[2001:db8::1]",
	"file:///tmp/fixture",
	"chrome://settings",
	"chrome-extension://foo",
	"devtools://foo",
	"javascript:1",
	"data:text/plain,test",
	"ftp://example.com",
	"https://user:pass@example.com",
	"https://@example.com",
	"https://example.com\\@localhost",
	"https://example.com/\n",
	"http://168.63.129.16",
])("refuses forbidden navigation %s without DNS", async (raw) => {
	const lookup = vi
		.fn()
		.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	await expect(resolveBrowserEgressTarget(raw, { lookup })).rejects.toThrow(
		/egress/,
	);
	expect(lookup).not.toHaveBeenCalled();
});
it("re-resolves each new connection and rejects a rebinding second answer", async () => {
	const lookup = vi
		.fn()
		.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
		.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
	await expect(
		resolveBrowserEgressTarget("https://example.com", { lookup }),
	).resolves.toMatchObject({ address: "93.184.216.34" });
	await expect(
		resolveBrowserEgressTarget("https://example.com", { lookup }),
	).rejects.toThrow(/egress/);
});
it("allows ordinary global IPv6 but rejects empty/malformed DNS and abort after lookup", async () => {
	await expect(
		resolveBrowserEgressTarget("https://[2606:4700:4700::1111]"),
	).resolves.toMatchObject({ family: 6 });
	for (const rows of [
		[],
		[{ address: "invalid", family: 4 }],
		[{ address: "127.0.0.1", family: 6 }],
	])
		await expect(
			resolveBrowserEgressTarget("https://example.com", {
				lookup: async () => rows,
			}),
		).rejects.toThrow(/egress/);
	const abort = new AbortController();
	await expect(
		resolveBrowserEgressTarget("https://example.com", {
			signal: abort.signal,
			lookup: async () => {
				abort.abort();
				return [{ address: "93.184.216.34", family: 4 }];
			},
		}),
	).rejects.toThrow(/egress/);
});

it("allows only exact trusted local QA origin with a pinned loopback and protects admin/CDP ports", async () => {
	const policy = {
		localQaTargets: [
			{ origin: "http://localhost:4312", address: "127.0.0.1" as const },
		],
		protectedPorts: [9876, 9222],
	};
	const lookup = vi.fn();
	await expect(
		resolveBrowserEgressTarget("http://localhost:4312/report", {
			policy,
			lookup,
		}),
	).resolves.toMatchObject({ address: "127.0.0.1", port: 4312 });
	expect(lookup).not.toHaveBeenCalled();
	for (const url of [
		"http://localhost:4313",
		"http://127.0.0.1:4312",
		"http://localhost:9876",
		"http://localhost:9222",
	])
		await expect(
			resolveBrowserEgressTarget(url, {
				policy,
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			}),
		).rejects.toThrow(/egress/);
	for (const origin of [
		"http://localhost:9876",
		"http://localhost:9222",
		"http://example.com:4312",
		"http://localhost:4312/path",
	])
		await expect(
			resolveBrowserEgressTarget("http://localhost:4312", {
				policy: {
					...policy,
					localQaTargets: [{ origin, address: "127.0.0.1" }],
				},
			}),
		).rejects.toThrow(/egress/);
	await expect(
		resolveBrowserEgressTarget("http://localhost:4312", {
			policy: { ...policy, protectedPorts: [] },
		}),
	).rejects.toThrow(/egress/);
});

it("cancels a stalled DNS lookup without waiting for its provider to resolve", async () => {
	const controller = new AbortController();
	const result = resolveBrowserEgressTarget("https://example.com", {
		signal: controller.signal,
		lookup: () => new Promise(() => {}),
	}).then(
		() => "allowed",
		() => "rejected",
	);
	await Promise.resolve();
	controller.abort();
	expect(
		await Promise.race([
			result,
			new Promise((resolve) => setTimeout(() => resolve("stalled"), 30)),
		]),
	).toBe("rejected");
});
