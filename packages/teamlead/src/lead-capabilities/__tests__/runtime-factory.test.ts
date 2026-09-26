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
import { startBrowserProvider } from "../browser-provider.js";
import { LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { recordActualLeadRuleSources } from "../rule-sources.js";
import {
	assertRuntimeHandlerCoverage,
	startLeadRuntimeParent,
	startLeadRuntimeProviders,
} from "../runtime-factory.js";
import type { LeadCapabilityParentOptions } from "../runtime-parent.js";

const state = vi.hoisted(() => ({
	events: [] as string[],
	fail: "",
	/** Provider-specific startup error messages (FLY-2886 §14.1). */
	failures: {} as Record<string, string>,
	current: true,
	closeFailure: "",
	omit: false,
	parent: undefined as LeadCapabilityParentOptions | undefined,
	parentFailure: false,
	identity: "1".repeat(64),
	voiceEnabled: false,
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
					codexVoiceActions: state.voiceEnabled,
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
	if (state.failures[id]) throw new Error(state.failures[id]);
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
	startBrowserProvider: vi.fn(async () => {
		state.events.push("start:browser");
		if (state.fail === "browser" || state.failures.browser)
			throw new Error("browser_start_failed");
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
	}),
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
	state.failures = {};
	state.current = true;
	state.closeFailure = "";
	state.omit = false;
	state.parent = undefined;
	state.parentFailure = false;
	state.identity = "1".repeat(64);
	state.voiceEnabled = false;
});

it.each([false, true, "identity"] as const)(
	"connects the public manifest and outbound path to the parent, failure=%s",
	async (failure) => {
		const options = fixture();
		state.voiceEnabled = failure === false;
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
			codexVersion: "0.154.0",
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
			expect(state.parent?.manifest.operationIds).toEqual(
				expect.arrayContaining([
					"voice.session.start",
					"voice.session.status",
					"voice.session.stop",
				]),
			);
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
		expect(state.parent?.manifest.nativeSkillBaseline?.codexVersion).toBe(
			"0.154.0",
		);
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

it("browser off starts no browser provider and retains restricted model egress", async () => {
	const session = await startLeadRuntimeProviders({
		...fixture(),
		browserMode: "off",
	});
	try {
		expect(state.events).not.toContain("start:browser");
		expect(
			[...session.handlers.keys()].some((id) => id.startsWith("browser.")),
		).toBe(false);
		expect(session.integrationIds).not.toContain("browser");
		expect(session.browserGeneration).toBeUndefined();
		expect((await fetch(`http://127.0.0.1:${session.proxyPort}/`)).status).toBe(
			403,
		);
	} finally {
		await session.close();
	}
	await expect(
		fetch(`http://127.0.0.1:${session.proxyPort}/`),
	).rejects.toThrow();
});

it.each(["founder_chrome", "isolated"] as const)(
	"passes trusted %s mode to the provider",
	async (browserMode) => {
		const session = await startLeadRuntimeProviders({
			...fixture(),
			browserMode,
		});
		try {
			expect(startBrowserProvider).toHaveBeenLastCalledWith(
				expect.objectContaining({ mode: browserMode }),
			);
		} finally {
			await session.close();
		}
	},
);

it.each(["founder_chrome", "isolated", "off"] as const)(
	"assembles provider, manifest and MCP consistently for %s",
	async (browserMode) => {
		const options = fixture();
		const session = await startLeadRuntimeParent({
			...options,
			browserMode,
			operations: LEAD_CAPABILITY_CATALOG.filter(
				(row) =>
					row.classification !== "reserved" &&
					!(browserMode === "off" && row.credentialConsumer === "browser"),
			),
			sources: {
				sourceRevision: "head-fixture",
				records: options.ruleRecords,
				skillInventory: [],
			},
			adoptedMenuShapes: ["implement"],
			assertPreparedCurrent: async () => {},
			parent: {
				journal: {} as never,
				activationRoot: "/fixture/activation",
				codexHome: "/fixture/home",
				artifactRoot: "/fixture/artifacts",
				modelTempRoot: "/fixture/temp",
				nodePath: process.execPath,
				codexPath: "/fixture/codex",
				proxyEntryPath: "/fixture/proxy",
				codexVersion: "0.154.0",
				permissionProfile: {
					deploymentRoot: "/fixture/deploy",
					projectRoot: "/fixture/work",
					readPaths: [],
					credentialPaths: ["/fixture/auth"],
				},
				verifyDeployment: async () => {},
			},
		});
		try {
			const manifest = state.parent!.manifest;
			expect(manifest.browserMode).toBe(browserMode);
			expect(
				manifest.operationIds.some((id) => id.startsWith("browser.")),
			).toBe(browserMode !== "off");
			expect(manifest.integrations.some((row) => row.id === "browser")).toBe(
				browserMode !== "off",
			);
			const mcp = buildCodexLeadMcpArgv({
				capabilityV2: {
					nodePath: process.execPath,
					proxyEntryPath: "/fixture/proxy.js",
					socketPath: "/tmp/fixture.sock",
					manifestPath: "/fixture/manifest.json",
					manifest,
				},
			});
			expect(mcp.included).toEqual(
				browserMode === "off"
					? ["lead_actions"]
					: ["lead_actions", "chrome_devtools"],
			);
		} finally {
			await session.close();
		}
	},
);

// ---------------------------------------------------------------------------
// FLY-2886 plan v12 §14.1: voice parents assemble per integration.
// ---------------------------------------------------------------------------
const OMIT = { integrationFailurePolicy: "omit_integration" as const };
const voiceParent = {
	journal: {} as never,
	activationRoot: "/fixture/activation",
	codexHome: "/fixture/home",
	artifactRoot: "/fixture/artifacts",
	modelTempRoot: "/fixture/temp",
	nodePath: process.execPath,
	codexPath: "/fixture/codex",
	proxyEntryPath: "/fixture/proxy",
	codexVersion: "0.154.0",
	permissionProfile: {
		deploymentRoot: "/fixture/deploy",
		projectRoot: "/fixture/work",
		readPaths: [],
		credentialPaths: ["/fixture/auth"],
	},
	verifyDeployment: async () => {},
};
const voiceOperations = (browserMode: "founder_chrome" | "isolated" | "off") =>
	LEAD_CAPABILITY_CATALOG.filter(
		(row) =>
			row.classification !== "reserved" &&
			!(browserMode === "off" && row.credentialConsumer === "browser"),
	);
function withoutGithubCredential(options: ReturnType<typeof fixture>) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "no-gh-home-")));
	roots.push(home);
	const { GH_TOKEN: _token, ...env } = options.env;
	return { ...options, env: { ...env, HOME: home, GH_CONFIG_DIR: home } };
}

it("omit_integration keeps every other capability when optional providers fail, one reason each", async () => {
	state.failures = {
		gbrain: "gbrain_host_unverified",
		context7: "baseline_drift",
		"xiaohongshu-mcp": "upstream_http_unavailable",
	};
	const session = await startLeadRuntimeProviders({ ...fixture(), ...OMIT });
	try {
		expect(session.unavailableIntegrations).toEqual([
			{ id: "context7", reason: "baseline_drift" },
			{ id: "gbrain", reason: "host_config_unverified" },
			{ id: "xiaohongshu-mcp", reason: "provider_start_failed" },
		]);
		const ids = [...session.handlers.keys()];
		expect(ids.filter((id) => id.startsWith("docs."))).toEqual([]);
		expect(session.handlers.has("knowledge.get_page")).toBe(false);
		expect(session.handlers.has("xiaohongshu.list_feeds")).toBe(false);
		for (const kept of [
			"linear.issue.get",
			"github.pr.view",
			"patrol.snapshot",
			"browser.click",
			"start_runner",
			"memory.search",
		])
			expect(session.handlers.has(kept)).toBe(true);
		expect(session.integrationIds).toEqual([
			"bridge",
			"discord",
			"linear",
			"github",
			"browser",
		]);
		expect(session.upstreamIntegrations).toEqual([]);
		// A failed provider cleans up after itself; nothing else is torn down.
		expect(state.events.filter((e) => e.startsWith("close:"))).toEqual([]);
	} finally {
		await session.close();
	}
	expect(state.events.filter((e) => e.startsWith("close:"))).toEqual([
		"close:browser",
	]);
});

it("omit_integration records missing Linear and GitHub credentials and drops only their groups", async () => {
	const options = withoutGithubCredential({
		...fixture(),
		linearToken: undefined as unknown as string,
	});
	const session = await startLeadRuntimeProviders({ ...options, ...OMIT });
	try {
		expect(session.unavailableIntegrations).toEqual([
			{ id: "github", reason: "credential_missing" },
			{ id: "linear", reason: "credential_missing" },
		]);
		const ids = [...session.handlers.keys()];
		expect(ids.filter((id) => id.startsWith("linear."))).toEqual([]);
		// Patrol snapshots use the GitHub client, so they go with it (requires).
		for (const gone of [
			"github.pr.view",
			"github.pr.list",
			"patrol.snapshot",
			"patrol.judgment.record",
		])
			expect(session.handlers.has(gone)).toBe(false);
		expect(session.handlers.has("knowledge.get_page")).toBe(true);
		expect(session.secrets).not.toContain(undefined);
		expect(session.integrationIds).not.toContain("linear");
		expect(session.integrationIds).not.toContain("github");
	} finally {
		await session.close();
	}
});

it("omit_integration drops browser operations instead of minting rejection handlers", async () => {
	state.failures = { browser: "browser_start_failed" };
	const session = await startLeadRuntimeProviders({
		...fixture(),
		...OMIT,
		browserMode: "founder_chrome",
	});
	try {
		expect(session.unavailableIntegrations).toEqual([
			{ id: "browser", reason: "provider_start_failed" },
		]);
		expect(
			[...session.handlers.keys()].some((id) => id.startsWith("browser.")),
		).toBe(false);
		expect(session.browserGeneration).toBeUndefined();
		expect(session.integrationIds).not.toContain("browser");
		// Model egress still goes through the restricted proxy.
		expect((await fetch(`http://127.0.0.1:${session.proxyPort}/`)).status).toBe(
			403,
		);
	} finally {
		await session.close();
	}
});

it("fail_closed (the resident default) still fails the whole activation on one provider", async () => {
	state.failures = { gbrain: "gbrain_host_unverified" };
	await expect(startLeadRuntimeProviders(fixture())).rejects.toThrow(
		"gbrain_host_unverified",
	);
	await expect(
		startLeadRuntimeProviders({
			...fixture(),
			linearToken: undefined as unknown as string,
		}),
	).rejects.toThrow();
	state.failures = {};
	const session = await startLeadRuntimeProviders(fixture());
	try {
		expect(session.unavailableIntegrations).toBeUndefined();
	} finally {
		await session.close();
	}
});

it("omit_integration still fails closed when an available integration leaves an operation unhandled", async () => {
	state.omit = true;
	state.failures = { context7: "baseline_drift" };
	await expect(
		startLeadRuntimeProviders({ ...fixture(), ...OMIT }),
	).rejects.toThrow("runtime_handler_coverage_incomplete");
});

it("coverage: each checked operation is handled, denied or owned by an unavailable integration", () => {
	const handler = { execute: async () => ({ status: "unknown" as const }) };
	const all = new Map(
		LEAD_CAPABILITY_CATALOG.filter(
			(row) => row.classification !== "reserved" && !row.unconditionalDenial,
		).map((row) => [row.operationId, handler]),
	);
	expect(() =>
		assertRuntimeHandlerCoverage({ handlers: all, omitted: new Set() }),
	).not.toThrow();
	const docs = ["docs.library.resolve", "docs.lookup"];
	const partial = new Map(all);
	for (const id of docs) partial.delete(id);
	expect(() =>
		assertRuntimeHandlerCoverage({ handlers: partial, omitted: new Set() }),
	).toThrow("runtime_handler_coverage_incomplete");
	expect(() =>
		assertRuntimeHandlerCoverage({ handlers: partial, omitted: new Set(docs) }),
	).not.toThrow();
	expect(() =>
		assertRuntimeHandlerCoverage({ handlers: all, omitted: new Set(docs) }),
	).toThrow("invalid_runtime_handler");
	const noBrowser = new Map(
		[...all].filter(([id]) => !id.startsWith("browser.")),
	);
	expect(() =>
		assertRuntimeHandlerCoverage({
			handlers: noBrowser,
			omitted: new Set(),
			browserMode: "off",
		}),
	).not.toThrow();
	expect(() =>
		assertRuntimeHandlerCoverage({ handlers: noBrowser, omitted: new Set() }),
	).toThrow("runtime_handler_coverage_incomplete");
	expect(() =>
		assertRuntimeHandlerCoverage({
			handlers: new Map([...all, ["bridge.merge", handler]]),
			omitted: new Set(),
		}),
	).toThrow("invalid_runtime_handler");
});

it.each(["founder_chrome", "off"] as const)(
	"voice parent (%s) publishes unavailableIntegrations and a consistent manifest/MCP",
	async (browserMode) => {
		state.failures = {
			gbrain: "gbrain_host_unverified",
			context7: "baseline_drift",
			...(browserMode === "founder_chrome"
				? { browser: "browser_start_failed" }
				: {}),
		};
		const options = fixture();
		const session = await startLeadRuntimeParent({
			...options,
			...OMIT,
			linearToken: undefined as unknown as string,
			browserMode,
			operations: voiceOperations(browserMode),
			sources: {
				sourceRevision: "head-fixture",
				records: options.ruleRecords,
				skillInventory: [],
			},
			adoptedMenuShapes: ["implement"],
			assertPreparedCurrent: async () => {},
			parent: voiceParent,
		});
		try {
			const manifest = state.parent!.manifest;
			expect(manifest.unavailableIntegrations).toEqual([
				...(browserMode === "founder_chrome"
					? [{ id: "browser", reason: "provider_start_failed" }]
					: []),
				{ id: "context7", reason: "baseline_drift" },
				{ id: "gbrain", reason: "host_config_unverified" },
				{ id: "linear", reason: "credential_missing" },
			]);
			expect(manifest.browserMode).toBe(browserMode);
			expect(manifest.browserGeneration).toBeUndefined();
			expect(manifest.integrations.map((row) => row.id).sort()).toEqual([
				"bridge",
				"discord",
				"github",
				"xiaohongshu-mcp",
			]);
			for (const prefix of ["linear.", "docs.", "browser."])
				expect(manifest.operationIds.some((id) => id.startsWith(prefix))).toBe(
					false,
				);
			expect(manifest.operationIds).not.toContain("knowledge.get_page");
			expect(manifest.operationIds).toContain("github.pr.view");
			const mcp = buildCodexLeadMcpArgv({
				capabilityV2: {
					nodePath: process.execPath,
					proxyEntryPath: "/fixture/proxy.js",
					socketPath: "/tmp/fixture.sock",
					manifestPath: "/fixture/manifest.json",
					manifest,
				},
			});
			expect(mcp.included).toEqual(["lead_actions"]);
		} finally {
			await session.close();
		}
	},
);

it("a resident (fail_closed) manifest carries no unavailableIntegrations field", async () => {
	const options = fixture();
	const session = await startLeadRuntimeParent({
		...options,
		sources: {
			sourceRevision: "head-fixture",
			records: options.ruleRecords,
			skillInventory: [],
		},
		adoptedMenuShapes: ["implement"],
		assertPreparedCurrent: async () => {},
		parent: voiceParent,
	});
	try {
		expect(state.parent!.manifest).not.toHaveProperty(
			"unavailableIntegrations",
		);
	} finally {
		await session.close();
	}
});

it("an unavailable integration keeps none of its operations: reads, writes, denials or management (review R1#3)", async () => {
	state.failures = {
		gbrain: "gbrain_host_unverified",
		"xiaohongshu-mcp": "upstream_http_unavailable",
		context7: "baseline_drift",
	};
	authority.enabled = true;
	const options = withoutGithubCredential({
		...fixture(),
		linearToken: undefined as unknown as string,
	});
	const session = await startLeadRuntimeProviders({ ...options, ...OMIT });
	try {
		const unavailable = new Set(
			session.unavailableIntegrations!.map((row) => row.id),
		);
		expect([...unavailable].sort()).toEqual([
			"context7",
			"gbrain",
			"github",
			"linear",
			"xiaohongshu-mcp",
		]);
		const leaked = [...session.handlers.keys()].filter((id) =>
			unavailable.has(
				LEAD_CAPABILITY_CATALOG.find((row) => row.operationId === id)!
					.credentialConsumer as never,
			),
		);
		expect(leaked).toEqual([]);
		for (const id of [
			"knowledge.put_page",
			"xiaohongshu.publish_content",
			"xiaohongshu.write.prepare",
			"github.pr.edit",
			"patrol.snapshot",
		])
			expect(session.handlers.has(id)).toBe(false);
		// Core capabilities remain.
		for (const id of ["start_runner", "bridge.read", "memory.search"])
			expect(session.handlers.has(id)).toBe(true);
	} finally {
		await session.close();
	}
});

it("the voice manifest drops an unavailable integration's unconditional denials too (review R2#3)", async () => {
	const options = withoutGithubCredential(fixture());
	const session = await startLeadRuntimeParent({
		...options,
		...OMIT,
		browserMode: "off",
		operations: voiceOperations("off"),
		sources: {
			sourceRevision: "head-fixture",
			records: options.ruleRecords,
			skillInventory: [],
		},
		adoptedMenuShapes: ["implement"],
		assertPreparedCurrent: async () => {},
		parent: voiceParent,
	});
	try {
		const manifest = state.parent!.manifest;
		expect(manifest.unavailableIntegrations).toEqual([
			{ id: "github", reason: "credential_missing" },
		]);
		const githubOwned = LEAD_CAPABILITY_CATALOG.filter(
			(row) => row.credentialConsumer === "github",
		).map((row) => row.operationId);
		expect(
			manifest.operationIds.filter((id) => githubOwned.includes(id)),
		).toEqual([]);
		for (const id of [
			"github.pr.create",
			"github.issue.comment",
			"git.feature.push",
		])
			expect(manifest.operationIds).not.toContain(id);
	} finally {
		await session.close();
	}
});
