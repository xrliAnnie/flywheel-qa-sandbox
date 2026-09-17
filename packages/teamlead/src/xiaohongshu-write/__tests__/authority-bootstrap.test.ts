import { expect, it, vi } from "vitest";
import { startAuthorityFromConfig } from "../authority-bootstrap.js";
import type { startAuthorityService } from "../authority-service.js";
import type { ObserverPolicy } from "../observer.js";

const state = vi.hoisted(() => ({
	events: [] as string[],
	probePolls: 0,
	sourceOptions: [] as unknown[],
	badConfig: false,
	badKey: false,
	key: Buffer.alloc(32, 7),
	options: null as Parameters<typeof startAuthorityService>[0] | null,
	entry: {
		probeChannelId: undefined as string | undefined,
		projectId: "project",
		leadId: "lead",
		channelId: "12345678901234567",
		guildId: "12345678901234568",
		botId: "12345678901234569",
		founderId: "12345678901234570",
	},
}));
vi.mock("../authority-config.js", () => ({
	loadAuthorityConfig: async () => {
		state.events.push("config");
		if (state.badConfig) throw Error();
		return {
			serviceUid: 501,
			stateRoot: "/state",
			ledgerPath: "/state/db",
			botTokenPath: "/state/bot",
			permitKeyPath: "/state/key",
			enabled: false,
			artifactRoot: "/state/media",
			registry: [state.entry],
			provider: {
				accountBase: { providerGeneration: "generation" },
				providerSocket: "/private.sock",
			},
		};
	},
}));
vi.mock("../config-current.js", () => ({
	createAuthorityConfigCurrent: () => () => {},
}));
vi.mock("../trusted-files.js", () => ({
	readPrivateFile: (path: string) => {
		state.events.push(path);
		return path.endsWith("/key")
			? state.badKey
				? Buffer.alloc(31)
				: state.key
			: Buffer.from("private-bot");
	},
}));
vi.mock("../store.js", () => ({
	XhsWriteStore: class {
		constructor() {
			state.events.push("ledger");
		}
		setDispatchEnabled(value: boolean) {
			state.events.push(`enabled:${value}`);
		}
		close() {
			state.events.push("ledger-close");
		}
	},
}));
vi.mock("../artifacts.js", () => ({ XhsFrozenArtifactStore: class {} }));
vi.mock("../media-validator.js", () => ({
	createMediaValidator: () => () => {},
}));
vi.mock("../provider-client.js", () => ({ XhsProviderClient: class {} }));
vi.mock("../authority-service.js", () => ({
	startAuthorityService: async (
		options: Parameters<typeof startAuthorityService>[0],
	) => {
		state.events.push("service");
		state.options = options;
		return { close: async () => {}, closed: new Promise(() => {}) };
	},
}));
function reset() {
	state.events = [];
	state.probePolls = 0;
	state.sourceOptions = [];
	state.entry.probeChannelId = undefined;
	state.badConfig = false;
	state.badKey = false;
	state.key = Buffer.alloc(32, 7);
	state.options = null;
}
it("validates immutable configuration before reading secrets or opening the ledger", async () => {
	reset();
	state.badConfig = true;
	await expect(startAuthorityFromConfig("/root-policy")).rejects.toThrow(
		"authority_startup_unavailable",
	);
	expect(state.events).toEqual(["config"]);
});
it("rejects a non-32-byte permit key before starting the provider service", async () => {
	reset();
	state.badKey = true;
	await expect(startAuthorityFromConfig("/root-policy")).rejects.toThrow(
		"authority_startup_unavailable",
	);
	expect(state.events).not.toContain("service");
	expect(state.events).not.toContain("ledger");
});
it("passes private adapters and the root write setting into the owned service without provisioning", async () => {
	reset();
	await startAuthorityFromConfig("/root-policy");
	expect(state.events).toEqual([
		"config",
		"/state/key",
		"/state/bot",
		"ledger",
		"enabled:false",
		"service",
	]);
	expect(state.options!.key).toBe(state.key);
	expect(state.options!.observers(new AbortController().signal)).toHaveLength(
		1,
	);
	expect(typeof state.options!.transport).toBe("function");
});

vi.mock("../discord-source.js", () => ({
	DiscordXhsSource: class {
		constructor(options: unknown) {
			state.sourceOptions.push(options);
		}
		async preflight() {
			state.events.push("discord-preflight");
		}
		async send() {
			state.events.push("discord-send");
			return "card";
		}
	},
}));
it("uses only the registered card destination and defers Discord preflight until writing a card", async () => {
	reset();
	await startAuthorityFromConfig("/root-policy");
	expect(state.events).not.toContain("discord-preflight");
	const policy = state.entry as ObserverPolicy;
	expect(() =>
		state.options!.transport({ ...policy, channelId: "22345678901234567" }),
	).toThrow("founder_source_unavailable");
	const transport = state.options!.transport(policy);
	expect(await transport.send("card", [], { parse: [] })).toBe("card");
	expect(state.events.slice(-2)).toEqual(["discord-preflight", "discord-send"]);
});

vi.mock("../attachment-probe-cache.js", () => ({
	XhsAttachmentProbeCache: class {
		limit() {
			return 1024;
		}
		async poll() {
			state.probePolls++;
			return 1024;
		}
	},
}));
it("wires a configured dedicated probe to background polling and scope-specific caps without startup IO", async () => {
	reset();
	state.entry.probeChannelId = "22345678901234567";
	await startAuthorityFromConfig("/root-policy");
	expect(state.probePolls).toBe(0);
	expect(state.sourceOptions).toContainEqual(
		expect.objectContaining({
			channelId: state.entry.probeChannelId,
			purpose: "probe",
		}),
	);
	const options = state.options!;
	expect(typeof options.attachmentLimit).toBe("function");
	if (typeof options.attachmentLimit !== "function") throw Error();
	expect(options.attachmentLimit(state.entry)).toBe(1024);
	const signal = new AbortController().signal;
	const workers = options.observers(signal);
	expect(workers).toHaveLength(2);
	await workers.at(-1)!.poll(signal);
	expect(state.probePolls).toBe(1);
});
