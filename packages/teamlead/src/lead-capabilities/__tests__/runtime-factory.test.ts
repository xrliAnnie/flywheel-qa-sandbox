import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildCodexLeadMcpArgv } from "../../lead-backends/codex/buildCodexLeadMcpArgv.js";
import { LeadArtifactStore } from "../artifacts.js";
import { LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { recordActualLeadRuleSources } from "../rule-sources.js";
import {
	startLeadRuntimeParent,
	startLeadRuntimeProviders,
} from "../runtime-factory.js";
import type { LeadCapabilityParentOptions } from "../runtime-parent.js";

const state = vi.hoisted(() => ({
	events: [] as string[],
	fail: "",
	current: true,
	closeFailure: "",
	omit: false,
	parent: undefined as LeadCapabilityParentOptions | undefined,
	parentFailure: false,
	identity: "1".repeat(64),
}));
const authority = vi.hoisted(() => ({
	enabled: false,
	factory: vi.fn(),
	call: vi.fn(),
}));
vi.mock("../../xiaohongshu-write/parent-client-policy.js", () => ({
	createParentXhsAuthorityClient: (options: unknown) => {
		authority.factory(options);
		if (!authority.enabled) throw Error("authority_client_policy_unavailable");
		return { call: authority.call };
	},
}));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!state.current) throw new Error("stale");
			return {
				project: { projectName: "flywheel", projectRepo: "owner/repo" },
				lead: {
					agentId: "eng",
					summaryRole: "producer",
					backend: "codex-app-server",
					codexProfile: "full-access",
					codexCapabilityBundleVersion: 2,
					canSpawnRunners: true,
					codexRunnerActions: true,
				},
				identity: {
					projectName: "flywheel",
					leadId: "eng",
					backend: "codex-app-server",
					role: "dept",
					identityDigest: state.identity,
				},
			};
		},
	}),
}));
vi.mock("../runtime-parent.js", () => ({
	startLeadCapabilityParent: async (options: LeadCapabilityParentOptions) => {
		state.parent = options;
		if (state.parentFailure) throw new Error("parent_start_failed");
		return { close: options.closeProviders };
	},
}));
async function upstream(id: string) {
	state.events.push(`start:${id}`);
	if (state.fail === id) throw new Error("provider_start_failed");
	const handlers = new Map(
		LEAD_CAPABILITY_CATALOG.filter(
			(row) =>
				row.credentialConsumer === id &&
				row.classification === "read" &&
				!row.operationId.startsWith("xiaohongshu.write."),
		).map((row) => [
			row.operationId,
			{ execute: async () => ({ status: "unknown" as const }) },
		]),
	);
	if (state.omit && id === "gbrain") handlers.delete("knowledge.get_page");
	return {
		handlers,
		integration: { id, version: "fixture", toolSchemaDigest: "0".repeat(64) },
		close: async () => {
			state.events.push(`close:${id}`);
			if (state.closeFailure === id) throw new Error("cleanup_failed");
		},
	};
}
vi.mock("../gbrain-provider.js", () => ({
	startGbrainProvider: () => upstream("gbrain"),
}));
vi.mock("../xiaohongshu-provider.js", () => ({
	startXiaohongshuProvider: () => upstream("xiaohongshu-mcp"),
}));
vi.mock("../context7-provider.js", () => ({
	startContext7Provider: () => upstream("context7"),
}));
vi.mock("../browser-provider.js", () => ({
	startBrowserProvider: async () => {
		state.events.push("start:browser");
		if (state.fail === "browser") throw new Error("browser_start_failed");
		return {
			handlers: new Map(
				LEAD_CAPABILITY_CATALOG.filter(
					(row) => row.credentialConsumer === "browser",
				).map((row) => [
					row.operationId,
					{ execute: async () => ({ status: "unknown" as const }) },
				]),
			),
			generation: "123e4567-e89b-42d3-a456-426614174000",
			proxyPort: 19999,
			close: async () => {
				state.events.push("close:browser");
			},
		};
	},
}));
const roots: string[] = [];
afterEach(() => {
	authority.enabled = false;
	authority.factory.mockClear();
	authority.call.mockReset();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	state.events = [];
	state.fail = "";
	state.current = true;
	state.closeFailure = "";
	state.omit = false;
	state.parent = undefined;
	state.parentFailure = false;
	state.identity = "1".repeat(64);
});

it.each([false, true, "identity"] as const)(
	"connects the public manifest and outbound path to the parent, failure=%s",
	async (failure) => {
		const options = fixture();
		state.parentFailure = failure === true;
		let preparedChecks = 0;
		const parent = {
			journal: {} as LeadCapabilityParentOptions["journal"],
			activationRoot: "/fixture/activation",
			codexHome: "/fixture/home",
			artifactRoot: "/fixture/artifacts",
			modelTempRoot: "/fixture/temp",
			nodePath: process.execPath,
			codexPath: "/fixture/codex",
			proxyEntryPath: "/fixture/proxy",
			codexVersion: "0.153.2",
			permissionProfile: {
				deploymentRoot: "/fixture/deploy",
				projectRoot: "/fixture/work",
				readPaths: [],
				credentialPaths: ["/fixture/auth"],
			},
			verifyDeployment: async () => {},
		};
		const pending = startLeadRuntimeParent({
			...options,
			parent,
			sources: {
				sourceRevision: "head-fixture",
				records: options.ruleRecords,
				skillInventory: [],
			},
			adoptedMenuShapes: ["implement"],
			assertPreparedCurrent: async () => {
				if (++preparedChecks === 2 && failure === "identity")
					state.identity = "3".repeat(64);
			},
		});
		if (failure === "identity") {
			await expect(pending).rejects.toThrow("runtime_identity_changed");
			expect(state.parent).toBeUndefined();
			expect(state.events.slice(-4)).toEqual([
				"close:browser",
				"close:context7",
				"close:xiaohongshu-mcp",
				"close:gbrain",
			]);
			return;
		}
		if (failure) await expect(pending).rejects.toThrow("parent_start_failed");
		else {
			const session = await pending;
			await session.close();
		}
		// Exercise the real parent-facing MCP consumer, not only the producer shape.
		expect(() =>
			buildCodexLeadMcpArgv({
				capabilityV2: {
					nodePath: process.execPath,
					proxyEntryPath: "/fixture/proxy.js",
					socketPath: "/tmp/fixture.sock",
					manifestPath: "/fixture/manifest.json",
					manifest: state.parent!.manifest,
				},
			}),
		).not.toThrow();
		expect(state.parent?.manifest.operationIds).toContain("start_runner");
		expect(state.parent?.manifest.operationIds).toContain("git.feature.push");
		expect(state.parent?.manifest.nativeSkillBaseline?.sources).toHaveLength(6);
		expect(state.parent?.manifest.skillGaps).toEqual([
			{
				sourceId: "skill/research",
				reason: "missing_persona_skill_manual_fallback",
			},
		]);
		expect(
			state.parent?.manifest.integrations.find((row) => row.id === "browser")
				?.version,
		).toBe("1.9.0");
		expect(
			state.parent?.manifest.integrations.map((row) => row.id).sort(),
		).toEqual([
			"bridge",
			"browser",
			"context7",
			"discord",
			"gbrain",
			"github",
			"linear",
			"xiaohongshu-mcp",
		]);
		expect(JSON.stringify(state.parent?.manifest)).not.toContain(
			"BRIDGE_TOKEN",
		);
		expect(state.parent?.outboundTransport).toBeTypeOf("function");
		expect(state.events.slice(-4)).toEqual([
			"close:browser",
			"close:context7",
			"close:xiaohongshu-mcp",
			"close:gbrain",
		]);
	},
);
it("attempts all cleanup after one provider close rejects", async () => {
	const session = await startLeadRuntimeProviders(fixture());
	state.closeFailure = "context7";
	await expect(session.close()).rejects.toThrow(
		"runtime_provider_cleanup_failed",
	);
	expect(state.events.slice(-4)).toEqual([
		"close:browser",
		"close:context7",
		"close:xiaohongshu-mcp",
		"close:gbrain",
	]);
});

it("fails startup with cleanup instead of silently dropping a missing provider operation", async () => {
	state.omit = true;
	await expect(startLeadRuntimeProviders(fixture())).rejects.toThrow(
		"runtime_handler_coverage_incomplete",
	);
	expect(state.events.slice(-4)).toEqual([
		"close:browser",
		"close:context7",
		"close:xiaohongshu-mcp",
		"close:gbrain",
	]);
});

it("shutdown aborts an actual Bridge transport and also rejects receipt reconciliation", async () => {
	const options = fixture();
	let ready!: () => void;
	const fetched = new Promise<void>((resolve) => {
		ready = resolve;
	});
	options.fetchImpl.mockImplementation(() => {
		ready();
		return new Promise(() => {});
	});
	const session = await startLeadRuntimeProviders(options);
	const context = {
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		projectName: "flywheel",
		leadId: "eng",
		activationId: "activation",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	const pending = session.handlers
		.get("bridge.read")!
		.execute({ request: { resource: "health" } }, context);
	const rejected = expect(pending).rejects.toThrow("runtime_providers_closed");
	await fetched;
	await session.close();
	await rejected;
	expect(options.fetchImpl).toHaveBeenCalledOnce();
	await expect(
		session.handlers.get("start_runner")!.reconcile!({} as never, {}, context),
	).rejects.toThrow("runtime_providers_closed");
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "runtime-providers-")));
	roots.push(root);
	const artifactRoot = join(root, "artifacts");
	const rulePath = join(root, "rule.md");
	writeFileSync(rulePath, "Verified governance");
	const ruleRecords = recordActualLeadRuleSources([
		{ sourceId: "persona", layer: "persona", sourcePath: rulePath },
		{
			sourceId: "skill/research",
			layer: "skill",
			sourcePath: join(root, "missing-skill.md"),
		},
	]);
	mkdirSync(artifactRoot, { mode: 0o700 });
	const artifacts = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent() {},
	});
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		throw new Error("unexpected_network");
	});
	return {
		ruleRecords,
		env: {
			FLYWHEEL_API_TOKEN: "BRIDGE_TOKEN",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:18181",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "claim",
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_LEAD_ID: "eng",
			FLYWHEEL_PROJECTS_FILE: join(root, "projects.json"),
			GH_TOKEN: "GH_TOKEN_VALUE",
		},
		activationId: "activation",
		linearToken: "LINEAR_TOKEN",
		artifacts,
		secrets: ["BRIDGE_TOKEN"],
		fetchImpl,
		browser: {
			packageRoot: root,
			nodeExecutable: process.execPath,
			chromeExecutable: "/fixture/chrome",
			projectRoot: root,
			qaParentRoot: root,
			egress: () => ({ protectedPorts: [18181], localQaTargets: [] }),
			revokeQaIdentity: async () => {},
		},
	};
}
it("assembles every non-reserved operation and closes activation providers in reverse order", async () => {
	const options = fixture();
	const session = await startLeadRuntimeProviders(options);
	expect(
		LEAD_CAPABILITY_CATALOG.filter(
			(row) =>
				row.classification !== "reserved" &&
				!row.unconditionalDenial &&
				!session.handlers.has(row.operationId),
		),
	).toEqual([]);
	expect(options.fetchImpl).not.toHaveBeenCalled();
	expect(session.secrets).toEqual(
		expect.arrayContaining(["BRIDGE_TOKEN", "GH_TOKEN_VALUE", "LINEAR_TOKEN"]),
	);
	await session.close();
	await session.close();
	expect(state.events.slice(-4)).toEqual([
		"close:browser",
		"close:context7",
		"close:xiaohongshu-mcp",
		"close:gbrain",
	]);
	await expect(
		session.handlers.get("bridge.read")!.execute(
			{},
			{
				requestId: "123e4567-e89b-42d3-a456-426614174000",
				projectName: "flywheel",
				leadId: "eng",
				activationId: "activation",
				signal: new AbortController().signal,
				assertCurrent: async () => {},
			},
		),
	).rejects.toThrow("runtime_providers_closed");
});
it.each(["gbrain", "xiaohongshu-mcp", "context7"])(
	"cleans up earlier resources when %s startup fails",
	async (failure) => {
		state.fail = failure;
		await expect(startLeadRuntimeProviders(fixture())).rejects.toThrow(
			/start_failed/,
		);
		const started = state.events
			.filter((event) => event.startsWith("start:"))
			.slice(0, -1)
			.map((event) => event.slice(6));
		expect(state.events.filter((event) => event.startsWith("close:"))).toEqual(
			started.reverse().map((id) => `close:${id}`),
		);
	},
);

it("keeps non-browser capabilities available when native browser startup fails", async () => {
	state.fail = "browser";
	const options = fixture();
	const session = await startLeadRuntimeProviders(options);
	const context = {
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		projectName: "flywheel",
		leadId: "eng",
		activationId: "activation",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	try {
		const browser = [...session.handlers].filter(([id]) =>
			id.startsWith("browser."),
		);
		expect(browser).toHaveLength(21);
		for (const [, handler] of browser)
			expect(await handler.execute({}, context)).toMatchObject({
				status: "rejected",
				errorCode: "browser_unavailable",
			});
		expect(
			await session.handlers.get("knowledge.get_page")!.execute({}, context),
		).toEqual({ status: "unknown" });
		expect(
			await session.handlers.get("artifact.text.create")!.execute(
				{
					mimeType: "text/plain",
					text: "Browser unavailable; other capabilities remain active.",
				},
				context,
			),
		).toMatchObject({ status: "succeeded" });

		expect(state.events.filter((e) => e.startsWith("close:"))).toEqual([]);
		expect((await fetch(`http://127.0.0.1:${session.proxyPort}/`)).status).toBe(
			403,
		);
	} finally {
		await session.close();
	}
	await expect(
		fetch(`http://127.0.0.1:${session.proxyPort}/`),
	).rejects.toThrow();
	expect(state.events.filter((e) => e.startsWith("close:"))).toEqual([
		"close:context7",
		"close:xiaohongshu-mcp",
		"close:gbrain",
	]);
});

it("routes feed reads through the verified authority without reminting resource handles", async () => {
	const options = fixture();
	authority.enabled = true;
	const text = JSON.stringify({
		feeds: [
			{ id: "feed-a", resourceHandle: "123e4567-e89b-42d3-a456-426614174000" },
		],
		count: 1,
	});
	authority.call.mockResolvedValue({ text });
	const active = await startLeadRuntimeProviders(options);
	let forwarded: AbortSignal | undefined;
	try {
		const context = {
			requestId: "read-request",
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation",
			signal: new AbortController().signal,
			assertCurrent: async () => {},
		};
		expect(
			await active.handlers.get("xiaohongshu.list_feeds")!.execute({}, context),
		).toMatchObject({
			status: "succeeded",
			data: {
				result: { content: [{ type: "text", text }] },
				untrusted: true,
				receiptId: "read-request",
			},
		});
		expect(authority.call).toHaveBeenCalledWith(
			"list_feeds",
			{},
			expect.any(AbortSignal),
		);
		for (const [action, input] of [
			["search_feeds", { keyword: "query" }],
			["list_saved_content", {}],
			["list_collections", {}],
			["get_collection_content", { collection_id: "collection-a" }],
			[
				"get_feed_detail",
				{
					feed_id: "feed-a",
					resourceHandle: "00000000-0000-4000-8000-000000000001",
				},
			],
		] as const) {
			expect(
				await active.handlers
					.get(`xiaohongshu.${action}`)!
					.execute(input, context),
			).toMatchObject({ status: "succeeded" });
			expect(authority.call).toHaveBeenLastCalledWith(
				action,
				input,
				expect.any(AbortSignal),
			);
		}
		authority.call.mockResolvedValue({ loggedIn: false });
		expect(
			await active.handlers
				.get("xiaohongshu.check_login_status")!
				.execute({}, context),
		).toMatchObject({ status: "succeeded" });
		expect(authority.call).toHaveBeenLastCalledWith(
			"check_login_status",
			{},
			expect.any(AbortSignal),
		);
		authority.call.mockResolvedValue({
			loggedIn: false,
			image:
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==",
			expiresAt: Date.now() + 60000,
		});
		expect(
			await active.handlers
				.get("xiaohongshu.get_login_qrcode")!
				.execute({}, context),
		).toMatchObject({
			status: "succeeded",
			data: {
				result: {
					content: [
						expect.objectContaining({ type: "text" }),
						expect.objectContaining({ type: "image", mimeType: "image/png" }),
					],
				},
			},
		});
		expect(authority.call).toHaveBeenLastCalledWith(
			"get_login_qrcode",
			{},
			expect.any(AbortSignal),
		);
		forwarded = authority.call.mock.calls[0][2];
		expect(forwarded?.aborted).toBe(false);
		authority.call.mockRejectedValue(Error("private-error"));
		expect(
			await active.handlers.get("xiaohongshu.list_feeds")!.execute({}, context),
		).toMatchObject({ status: "unknown" });
	} finally {
		await active.close();
	}
	expect(forwarded?.aborted).toBe(true);
});
it("assembles receipt writes only through the verified authority client and keeps default denial", async () => {
	const options = fixture();
	authority.call.mockResolvedValue({
		kind: "attempt",
		attemptId: "123e4567-e89b-42d3-a456-426614174003",
		state: "succeeded",
	});
	const input = {
		proposalId: "123e4567-e89b-42d3-a456-426614174000",
		receiptId: "123e4567-e89b-42d3-a456-426614174001",
		expectedContentDigest: "a".repeat(64),
	};
	const context = {
		requestId: "123e4567-e89b-42d3-a456-426614174002",
		projectName: "flywheel",
		leadId: "eng",
		activationId: "activation",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	const denied = await startLeadRuntimeProviders(options);
	try {
		expect(
			await denied.handlers
				.get("xiaohongshu.like_feed")!
				.execute(input, context),
		).toMatchObject({
			status: "rejected",
			errorCode: "founder_write_gate_absent",
		});
	} finally {
		await denied.close();
	}
	authority.enabled = true;
	const active = await startLeadRuntimeProviders(options);
	try {
		expect(authority.factory).toHaveBeenLastCalledWith({
			policyPath: "/Library/Application Support/Flywheel/Xhs/policy.json",
			env: options.env,
			activationId: "activation",
		});
		expect(
			await active.handlers
				.get("xiaohongshu.like_feed")!
				.execute(input, context),
		).toMatchObject({ status: "succeeded" });
		expect(authority.call).toHaveBeenCalledTimes(1);
		expect(
			await active.handlers
				.get("xiaohongshu.delete_cookies")!
				.execute({}, context),
		).toMatchObject({ status: "rejected", errorCode: "unclassified_write" });
		expect(authority.call).toHaveBeenCalledTimes(1);
	} finally {
		await active.close();
	}
	await expect(
		active.handlers.get("xiaohongshu.like_feed")!.execute(input, context),
	).rejects.toThrow("runtime_providers_closed");
	expect(authority.call).toHaveBeenCalledTimes(1);
});
