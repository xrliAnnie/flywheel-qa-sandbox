import { afterEach, expect, it, vi } from "vitest";
import {
	createBridgeXhsNotificationClients,
	createBridgeXhsWriteClient,
} from "../parent-client-policy.js";

vi.mock("../../lead-capabilities/runtime-context.js", () => ({
	createLeadCapabilityContext: () => {
		throw Error("Bridge must not acquire a Lead carrier");
	},
}));
const state = vi.hoisted(() => ({
	changed: false,
	unsafeSocket: false,
	calls: [] as string[],
	configs: [] as {
		assertCurrent(): void;
		scope: unknown;
		authorityUid: number;
		socketPath: string;
	}[],
}));
vi.mock("node:fs", () => ({
	lstatSync: (path: string) => ({
		isDirectory: () => path !== "/socket",
		isSocket: () => path === "/socket",
		uid: state.unsafeSocket ? 501 : 0,
		gid: 451,
		nlink: 1,
		mode: path === "/socket" ? 0o660 : 0o755,
	}),
}));
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: (path: string) => {
		if (state.changed) throw Error("changed");
		if (
			path === "/Library/Application Support/Flywheel/Xhs/installation.metadata"
		)
			return Buffer.from(
				`version=1\nmanifest_sha256=${"f".repeat(64)}\nbootstrap_sha256=${"a".repeat(64)}\n`,
			);
		return Buffer.from(path);
	},
	readRootReceipt: () => Buffer.from("receipt"),
}));
vi.mock("../boundary-acceptance.js", () => ({
	verifyBoundaryAcceptance: () => {},
}));
vi.mock("../authority-config.js", () => ({
	parseAuthorityConfig: () => ({
		modelUid: 501,
		serviceUid: 450,
		boundaryProbe: { path: "/probe", sha256: "e".repeat(64) },
		serviceGid: 450,
		ingressGid: 451,
		ingressSocket: "/socket",
		registry: [{ projectId: "project", leadId: "lead" }],
		providerConfig: { path: "/provider", sha256: "a".repeat(64) },
		peerHelper: { path: "/helper", sha256: "b".repeat(64) },
		acceptancePath: "/acceptance",
		acceptancePublicKey: "key",
	}),
	verifyProviderConfigBinding: () => ({
		providerBinary: { sha256: "c".repeat(64) },
		toolSchemaDigest: "d".repeat(64),
	}),
}));
vi.mock("../authority-client.js", () => ({
	XhsAuthorityClient: class {
		constructor(
			readonly options: {
				assertCurrent(): void;
				scope: unknown;
				authorityUid: number;
				socketPath: string;
			},
		) {
			state.configs.push(options);
		}
		async call(action: string) {
			this.options.assertCurrent();
			state.calls.push(action);
			return {};
		}
	},
}));
afterEach(() => {
	vi.restoreAllMocks();
	state.changed = false;
	state.unsafeSocket = false;
	state.calls = [];
	state.configs = [];
});
it("uses root scopes without a Lead carrier and exposes only notification operations", async () => {
	vi.spyOn(process, "getuid").mockReturnValue(501);
	vi.spyOn(process, "getgroups").mockReturnValue([20, 451]);
	const [entry] = createBridgeXhsNotificationClients("/policy");
	expect(state.configs[0]).toMatchObject({
		authorityUid: 0,
		socketPath: "/socket",
	});
	expect(entry?.scope).toEqual({ projectId: "project", leadId: "lead" });
	expect(state.configs[0]?.scope).toEqual({
		projectId: "project",
		leadId: "lead",
		activationId: "bridge-xhs-notifications",
	});
	await entry!.client.call("notifications", {});
	await expect(entry!.client.call("execute" as never, {})).rejects.toThrow();
	expect(state.calls).toEqual(["notifications"]);
	state.changed = true;
	await expect(
		entry!.client.call("notification_ack", { eventId: "x" }),
	).rejects.toThrow();
	expect(state.calls).toEqual(["notifications"]);
});

it("requires the route current guard and immutable root scope for Bridge writes", async () => {
	vi.spyOn(process, "getuid").mockReturnValue(501);
	vi.spyOn(process, "getgroups").mockReturnValue([20, 451]);
	let current = true,
		checks = 0;
	const scope = {
		projectId: "project",
		leadId: "lead",
		activationId: "activation",
	};
	const client = createBridgeXhsWriteClient({
		policyPath: "/policy",
		scope,
		assertCurrent: () => {
			checks++;
			if (!current) throw Error("stale");
		},
	});
	expect(state.configs[0]).toMatchObject({
		authorityUid: 0,
		socketPath: "/socket",
	});
	scope.leadId = "mutated";
	await client.call("status", {});
	expect(state.configs[0]?.scope).toEqual({
		projectId: "project",
		leadId: "lead",
		activationId: "activation",
	});
	expect(checks).toBeGreaterThanOrEqual(2);
	current = false;
	await expect(client.call("execute", {})).rejects.toThrow();
	expect(state.calls).toEqual(["status"]);
});

it("refuses model-owned ingress before constructing a root-peer transport and on recheck", async () => {
	vi.spyOn(process, "getuid").mockReturnValue(501);
	vi.spyOn(process, "getgroups").mockReturnValue([20, 451]);
	state.unsafeSocket = true;
	expect(() => createBridgeXhsNotificationClients("/policy")).toThrow(
		"authority_client_policy_unavailable",
	);
	expect(state.configs).toHaveLength(0);
	state.unsafeSocket = false;
	const [entry] = createBridgeXhsNotificationClients("/policy");
	state.unsafeSocket = true;
	await expect(entry!.client.call("notifications", {})).rejects.toThrow();
	expect(state.calls).toEqual([]);
});
