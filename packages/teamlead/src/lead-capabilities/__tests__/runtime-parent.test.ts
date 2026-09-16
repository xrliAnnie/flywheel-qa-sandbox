import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestLeadOperation } from "flywheel-comm/lead-operation-client";
import { parse } from "smol-toml";
import { expect, it, vi } from "vitest";
import { browserFacadeSchemaDigest } from "../../lead-backends/codex/browser-capability-proxy.js";
import type { HttpPost } from "../../lead-backends/codex/CodexOutboundSender.js";
import { LeadJournal } from "../../lead-backends/codex/LeadJournal.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import {
	type LeadOperationContext,
	leadOperationInputDigest,
} from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { leadCredentialAliases } from "../credential-paths.js";
import { createLeadCapabilityManifest } from "../manifest.js";
import { verifyModelIsolation } from "../model-isolation.js";
import { renderLeadPermissionProfile } from "../permission-profile.js";
import { startLeadCapabilityParent } from "../runtime-parent.js";

vi.mock("../model-isolation.js", () => ({
	verifyModelIsolation: vi.fn(async () => {}),
}));

it("verifies before listen, serves the real broker and closes without owning the shared journal", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lp-")));
	mkdirSync(join(root, "a"), { mode: 0o700 });
	mkdirSync(join(root, "home"), { mode: 0o700 });
	writeFileSync(join(root, "home", "auth.json"), "synthetic-credential", {
		mode: 0o600,
	});
	mkdirSync(join(root, "private"), { mode: 0o700 });
	symlinkSync(join(root, "private"), join(root, "credentials"));
	mkdirSync(join(root, "project"), { mode: 0o700 });
	mkdirSync(join(root, "project", "tmp"), { mode: 0o700 });
	let journal = new SqliteJournalStore(join(root, "journal.db"));
	const interrupted = {
		projectName: "demo",
		leadId: "product",
		operationId: "discord.thread.reply",
		requestId: "22222222-2222-4222-8222-222222222222",
		activationId: "old-activation",
		inputDigest: leadOperationInputDigest({
			threadId: "123",
			text: "interrupted",
		}),
		now: 1,
	};
	journal.operationReceipts.prepare(interrupted);
	journal.operationReceipts.transition({
		...interrupted,
		from: "prepared",
		to: "dispatched",
	});
	const prepared = {
		...interrupted,
		requestId: "33333333-3333-4333-8333-333333333333",
		activationId: "activation",
	};
	journal.operationReceipts.prepare(prepared);
	const foreign = { ...interrupted, leadId: "other" };
	journal.operationReceipts.prepare(foreign);
	// Simulate abrupt loss: close SQLite directly, without broker graceful shutdown.
	journal.close();
	journal = new SqliteJournalStore(join(root, "journal.db"));
	const order: string[] = [];
	let observedContext: string | undefined;
	vi.mocked(verifyModelIsolation).mockImplementation(async (input) => {
		expect(existsSync(join(root, "home", "config.toml"))).toBe(true);
		expect(existsSync(input.pins.brokerSocket)).toBe(false);
		expect(input.codexExecutable).toBe("/opt/codex");
		expect(input.credentialProbePath).toBe(join(root, "home", "auth.json"));
		await input.assertCurrent();
		order.push("model-verified");
	});
	const rulePath = join(root, "rule.md");
	writeFileSync(rulePath, "Verified rule");
	const skillPath = join(root, "skill.md"),
		skillText =
			"---\nname: delivery\ndescription: Deliver reports.\n---\nUse typed report tools.\n";
	writeFileSync(skillPath, skillText);
	const manifest = createLeadCapabilityManifest({
		projectName: "demo",
		leadId: "product",
		identityDigest: "a".repeat(64),
		backend: "codex-app-server",
		profile: "full-access",
		activationId: "activation",
		browserGeneration: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sourceRevision: "sha",
		operations: [
			getLeadCapability("browser.list_pages")!,
			getLeadCapability("discord.thread.reply")!,
			getLeadCapability("git.feature.push")!,
		],
		ruleSources: [
			{
				path: rulePath,
				sha256: createHash("sha256").update("Verified rule").digest("hex"),
			},
		],
		skillSources: [
			{
				name: "delivery",
				path: skillPath,
				sha256: createHash("sha256").update(skillText).digest("hex"),
			},
		],
		skillGaps: [
			{
				sourceId: "skill/deep-research",
				reason: "authenticated_research_not_available",
			},
		],
		integrations: [
			{
				id: "browser",
				version: "1.9.0",
				toolSchemaDigest: browserFacadeSchemaDigest(["list_pages"]),
			},
		],
	});
	const closeProvider = vi.fn(async () => {
		order.push("provider-close");
	});
	let started!: () => void;
	const outboundStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const outboundTransport: HttpPost = async (request) => {
		started();
		return new Promise((_, reject) =>
			request.signal!.addEventListener(
				"abort",
				() => reject(new Error("cancelled")),
				{ once: true },
			),
		);
	};
	const options = {
		modelEnv: { HOME: root },
		outboundTransport,
		manifest,
		journal,
		activationRoot: join(root, "a"),
		codexHome: join(root, "home"),
		artifactRoot: join(root, "artifacts"),
		modelTempRoot: join(root, "project", "tmp"),
		nodePath: process.execPath,
		codexPath: "/opt/codex",
		proxyEntryPath: "/opt/flywheel/capability-mcp-entry.js",
		handlers: new Map([
			[
				"discord.thread.reply",
				{
					authorize: async () => {},
					execute: async () => {
						throw new Error("must_not_redispatch");
					},
					reconcile: async () => ({
						status: "succeeded" as const,
						providerRef: "message:123",
						data: {
							threadId: "123",
							messageId: "123",
							receiptId: "reconciled",
							observedAt: "2026-09-14T00:00:00.000Z",
						},
					}),
				},
			],
			[
				"browser.list_pages",
				{
					authorize: async (
						_input: Record<string, unknown>,
						context: LeadOperationContext,
					) => {
						observedContext = context.deliveryContext;
					},
					execute: async () => ({
						status: "succeeded" as const,
						data: { content: [{ type: "text", text: "page" }] },
					}),
				},
			],
		]),
		permissionProfile: {
			deploymentRoot: "/opt/flywheel",
			projectRoot: join(root, "project"),
			readPaths: [],
			credentialPaths: [join(root, "credentials")],
			proxyPort: 32189,
		},
		secrets: ["secret-canary"],
		assertCurrent: async () => {},
		verifyDeployment: async ({
			permissionProfile,
		}: {
			permissionProfile: { credentialPaths: readonly string[] };
		}) => {
			expect(permissionProfile.credentialPaths).toContain(join(root, ".ssh"));
			expect(permissionProfile.credentialPaths).toContain(
				"/opt/flywheel/packages/teamlead/.env",
			);
			expect(existsSync(join(root, "home", "config.toml"))).toBe(true);
			order.push("verified");
		},
		closeProviders: closeProvider,
	};
	let parent: Awaited<ReturnType<typeof startLeadCapabilityParent>> | undefined;
	try {
		parent = await startLeadCapabilityParent(options);
		const key = (r: typeof interrupted) => ({
			projectName: r.projectName,
			leadId: r.leadId,
			operationId: r.operationId,
			requestId: r.requestId,
		});
		expect(journal.operationReceipts.get(key(interrupted))?.state).toBe(
			"unknown",
		);
		expect(journal.operationReceipts.get(key(prepared))?.state).toBe("unknown");
		expect(journal.operationReceipts.get(key(foreign))?.state).toBe("prepared");

		expect(
			readFileSync(join(root, "home/skills/delivery/SKILL.md"), "utf8"),
		).toBe(skillText);
		expect(parent.baseInstructions).toContain("Verified rule");
		expect(parent.baseInstructions).toContain(
			"skill/deep-research: authenticated_research_not_available",
		);
		expect(parent.baseInstructions).toContain(
			"delegate to an authorized Runner or interactive research",
		);
		expect(parent.baseInstructions).toContain("manual fallback");
		expect(parent.skillGaps).toEqual(manifest.skillGaps);
		expect(order).toEqual(["model-verified", "verified"]);
		const config = parse(
			renderLeadPermissionProfile({
				...options.permissionProfile,
				credentialPaths: [
					...leadCredentialAliases({ HOME: root }, options.codexHome),
					join(root, "credentials"),
					join(root, "private"),
					"/opt/flywheel/.env",
					"/opt/flywheel/packages/teamlead/.env",
				].sort(),
				artifactRoot: options.artifactRoot,
				brokerSocket: parent.pins.brokerSocket,
			}),
		);
		Object.assign(
			config,
			parse(parent.mcp.argv.filter((_, i) => i % 2 === 1).join("\n")),
		);
		await expect(parent.verifyEffectiveConfig(config)).resolves.toBeUndefined();
		await expect(
			parent.verifyEffectiveConfig({
				...config,
				mcp_servers: {
					...(config.mcp_servers as object),
					planted: { command: "/usr/bin/true" },
				},
			}),
		).rejects.toThrow("capability_effective_mcp_mismatch");
		await expect(
			parent.verifyEffectiveConfig({
				...config,
				default_permissions: "foreign",
			}),
		).rejects.toThrow();
		expect(existsSync(parent.pins.brokerSocket)).toBe(true);
		expect(
			(
				await requestLeadOperation(parent.pins.brokerSocket, {
					schemaVersion: 1,
					operationId: "git.feature.push",
					requestId: "11111111-1111-4111-8111-111111111111",
					input: {},
				})
			).errorCode,
		).toBe("lead_runner_owned_operation");
		const entries = new LeadJournal({ store: journal });
		const entry = entries.accept({
			idempotencyKey: "inbound-1",
			source: "discord",
			payload: "fake-model-context",
		}).entry;
		expect(() => parent!.enterDeliveryContext(entry.id)).toThrow();
		entries.toDispatching(entry.id, "correlation");
		const release = parent.enterDeliveryContext(entry.id);
		expect(
			await requestLeadOperation(parent.pins.brokerSocket, {
				schemaVersion: 1,
				operationId: interrupted.operationId,
				requestId: interrupted.requestId,
				input: { threadId: "123", text: "interrupted" },
			}),
		).toMatchObject({ status: "succeeded", resourceRefs: ["message:123"] });
		expect(() => parent!.enterDeliveryContext(entry.id)).toThrow();
		const result = await requestLeadOperation(parent.pins.brokerSocket, {
			schemaVersion: 1,
			operationId: "browser.list_pages",
			requestId: "123e4567-e89b-42d3-a456-426614174000",
			input: { generation: manifest.browserGeneration, arguments: {} },
		});
		expect(result.status).toBe("succeeded");
		expect(observedContext).toBe(entry.id);
		release();
		release();
		mkdirSync(join(root, ".codex-new-lead"));
		await expect(parent.assertCurrent()).rejects.toThrow(
			"credential_source_changed",
		);
		rmSync(join(root, ".codex-new-lead"), { recursive: true });
		await expect(parent.assertCurrent()).resolves.toBeUndefined();
		const pending = parent
			.outboundPost({ url: "unused", headers: {}, body: "{}" })
			.then(
				() => "sent",
				() => "cancelled",
			);
		await outboundStarted;
		await parent.close();
		expect(await pending).toBe("cancelled");
		await parent.close();
		expect(existsSync(parent.pins.brokerSocket)).toBe(false);
		expect(closeProvider).toHaveBeenCalledOnce();
		expect(() =>
			journal.operationReceipts.get({
				projectName: "demo",
				leadId: "product",
				operationId: "browser.list_pages",
				requestId: "123e4567-e89b-42d3-a456-426614174000",
			}),
		).not.toThrow();
		await expect(
			startLeadCapabilityParent({
				...options,
				verifyDeployment: async () => {
					throw new Error("isolation_unproven");
				},
			}),
		).rejects.toThrow("isolation_unproven");
		expect(closeProvider).toHaveBeenCalledTimes(2);
		await expect(
			startLeadCapabilityParent({
				...options,
				modelTempRoot: join(root, "home"),
			}),
		).rejects.toThrow("model_temp_outside_workspace");
		vi.mocked(verifyModelIsolation).mockRejectedValueOnce(
			new Error("model_isolation_unproven"),
		);
		const deployment = vi.fn(async () => {});
		await expect(
			startLeadCapabilityParent({ ...options, verifyDeployment: deployment }),
		).rejects.toThrow("model_isolation_unproven");
		expect(deployment).not.toHaveBeenCalled();
		expect(closeProvider).toHaveBeenCalledTimes(4);
	} finally {
		await parent?.close();
		journal.close();
		rmSync(root, { recursive: true, force: true });
	}
});
