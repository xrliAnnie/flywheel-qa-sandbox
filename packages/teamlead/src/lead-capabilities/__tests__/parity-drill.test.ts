import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LinearSdk } from "@linear/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Octokit } from "@octokit/rest";
import { requestLeadOperation } from "flywheel-comm/lead-operation-client";
import { expect, it, vi } from "vitest";
import { browserFacadeSchemaDigest } from "../../lead-backends/codex/browser-capability-proxy.js";
import { createCapabilityTuiRuntime } from "../../lead-backends/codex/capability-tui-runtime.js";
import type { CodexLeadTuiRuntimeConfig } from "../../lead-backends/codex/codex-lead-tui-runtime.js";
import { LeadJournal } from "../../lead-backends/codex/LeadJournal.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadArtifactStore } from "../artifacts.js";
import { decodeAttachmentUpload } from "../attachment-upload.js";
import type { LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createArtifactTextHandler } from "../handlers/artifact-text.js";
import { createBridgeAttachmentHandlers } from "../handlers/bridge-attachments.js";
import {
	createBridgeReadHandlers,
	createInboxBatchAckHandlers,
	createPatrolHandlers,
	createRunnerBridgeHandlers,
} from "../handlers/bridge-read.js";
import { createContext7Handlers } from "../handlers/context7.js";
import { createDiscordHandlers } from "../handlers/discord.js";
import { createGithubHandlers } from "../handlers/github.js";
import { createLinearHandlers } from "../handlers/linear.js";
import { createReportDeliverHandlers } from "../handlers/report-deliver.js";
import { createReportPublishHandlers } from "../handlers/report-publish.js";
import { createReportVerifyHandlers } from "../handlers/report-verify.js";
import { createUpstreamReadAdapter } from "../handlers/upstream-read.js";
import { createUpstreamWriteDenials } from "../handlers/upstream-write-denials.js";
import { createLeadCapabilityManifest } from "../manifest.js";
import { readManifestInstructions } from "../manifest-instructions.js";
import { installManifestSkills } from "../manifest-skills.js";
import {
	type LeadCapabilityParent,
	startLeadCapabilityParent,
} from "../runtime-parent.js";

// Host isolation is tested by the separate Seatbelt canary outside this runner.
// These are explicit process/provider boundaries, never a production bypass.
vi.mock("../model-isolation.js", () => ({
	verifyModelIsolation: vi.fn(async () => {}),
}));

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => ({
			project: { projectRepo: "fixture/repo" },
			lead: { agentId: "lead" },
		}),
	}),
}));

it("drives one isolated issue through the TUI owner, real parent, UDS and durable receipts", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pd-")));
	const activationId = randomUUID(),
		executionId = randomUUID(),
		issueId = "FLY-2519";
	const threadId = "222222222222222222",
		parentId = "111111111111111111";
	const trace: unknown[] = [],
		effects: string[] = [];
	let current = true,
		parent!: LeadCapabilityParent,
		journal!: SqliteJournalStore;
	for (const name of ["activation", "home", "project", "credentials", "deploy"])
		mkdirSync(join(root, name), { mode: 0o700 });
	mkdirSync(join(root, "project", "tmp"), { mode: 0o700 });
	const rule = join(root, "rule.md");
	writeFileSync(rule, "Isolated issue fixture. Use native capabilities only.");
	const skillPath = join(root, "skill.md");
	const skillText =
		"---\nname: issue-fixture\ndescription: Isolated issue instructions.\n---\nUse typed tools for FLY-2519.\n";
	writeFileSync(skillPath, skillText);
	const skillSource = {
		name: "issue-fixture",
		path: skillPath,
		sha256: createHash("sha256").update(skillText).digest("hex"),
	};
	const binding = {
		issueId,
		projectName: "fixture",
		leadId: "lead",
		parentId,
		threadId,
		revision: "1",
	};
	const assertCurrent = async () => {
		if (!current) throw new Error("fixture_activation_revoked");
	};
	const observedAt = () => new Date().toISOString();
	const handlers = new Map<string, LeadOperationHandler>();

	for (const [name, handler] of createDiscordHandlers({
		policy: () => ({
			projectName: "fixture",
			leadId: "lead",
			revision: "1",
			parentChannelIds: new Set([parentId]),
		}),
		bindingForIssue: (id) => (id === issueId ? binding : null),
		bindingForThread: (id) => (id === threadId ? binding : null),
		authorizeIssue: async (value) => {
			if (value.issueId !== issueId) throw new Error("fixture_issue_denied");
		},
		botToken: () => "SYNTHETIC_BOT_SECRET",
		lookupParent: async () => ({ state: "resolved", parentId }),
		messageFetcher: {
			fetchThreadMessages: async () => [
				{
					id: "333333333333333333",
					authorId: "444444444444444444",
					content: `QA report for ${issueId}`,
					ts: observedAt(),
					isBot: false,
				},
			],
			fetchMessage: async () => null,
		},
		outboundSender: {
			enqueue: async (args) => args.idempotencyKey,
			deliverWithResult: async () => {
				effects.push("discord-reply");
				return { messageId: "555555555555555555", deduped: false };
			},
			getDeliveryStatus: () => ({
				status: "sent",
				messageId: "555555555555555555",
			}),
		},
	}))
		handlers.set(name, handler);
	const issue = {
		id: issueId,
		identifier: issueId,
		team: Promise.resolve({ id: "team" }),
		project: Promise.resolve({ id: "project" }),
		labels: async () => ({
			nodes: [{ name: "Fixture" }],
			pageInfo: { hasNextPage: false },
		}),
	};
	for (const [name, handler] of createLinearHandlers({
		client: {
			issue: async (id: string) => {
				if (id !== issueId) throw new Error("fixture_issue_denied");
				return issue;
			},
			createComment: async () => {
				effects.push("linear-comment");
				return {
					success: true,
					comment: Promise.resolve({
						id: "comment",
						url: "https://linear.app/fixture/comment",
					}),
				};
			},
		} as unknown as LinearSdk,
		policy: () => ({
			teamId: "team",
			projectId: "project",
			createLabelIds: [],
			assignableUserIds: new Set(),
			mutableStateIds: new Set(),
			mutableLabelIds: new Set(),
		}),
		authorizeLabels: async (labels) => {
			expect(labels).toEqual(["Fixture"]);
		},
	}))
		handlers.set(name, handler);
	handlers.set("browser.list_pages", {
		authorize: assertCurrent,
		execute: async () => {
			effects.push("browser-fixture");
			return {
				status: "succeeded",
				data: { content: [{ type: "text", text: "Fixture QA report page" }] },
			};
		},
	});
	const providerTrace: unknown[] = [];
	const bridgeOptions = {
		env: {
			FLYWHEEL_PROJECT_NAME: "fixture",
			FLYWHEEL_LEAD_ID: "lead",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
			FLYWHEEL_API_TOKEN: "SYNTHETIC_API_SECRET",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "SYNTHETIC_CARRIER",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:31997",
		},
		activationId,
		fetchImpl: async (url: unknown, init?: RequestInit) => {
			const envelope = JSON.parse(init!.body as string);
			expect(envelope.activationId).toBe(activationId);
			providerTrace.push({
				url: String(url),
				operationId: envelope.operationId,
				requestId: envelope.requestId,
				input: envelope.input,
			});
			let data: unknown;
			if (envelope.operationId === "start_runner") {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/runners",
				);
				expect(envelope.input.issueId).toBe(issueId);
				effects.push("runner-start");
				data = {
					result: {
						outcome: "started",
						executionId,
						issueId,
						idempotencyKey: envelope.input.idempotencyKey,
						source: "isolated-service",
						sourceRef: null,
					},
					receiptId: envelope.requestId,
					observedAt: observedAt(),
				};
			} else if (envelope.operationId === "bridge.read") {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/read",
				);
				data = {
					result: { resource: "health", status: "ready" },
					receiptId: envelope.requestId,
					observedAt: observedAt(),
				};
			} else if (envelope.operationId === "terminal.status") {
				expect(envelope.input.executionId).toBe(executionId);
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/read",
				);
				data = {
					execution: { executionId, status: "running" },
					observedSessionId: "$1:%2",
					receiptId: envelope.requestId,
					observedAt: observedAt(),
				};
			} else if (envelope.operationId === "inbox.batch.ack") {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/inbox-batch-ack",
				);
				effects.push("inbox-ack");
				data = {
					batchId: envelope.input.batchId,
					receiptId: envelope.requestId,
					observedAt: observedAt(),
				};
			} else throw new Error("unexpected_fixture_bridge_request");
			return Response.json({
				requestId: envelope.requestId,
				status: "succeeded",
				resourceRefs:
					envelope.operationId === "start_runner"
						? [`runner-execution:${executionId}`]
						: envelope.operationId === "inbox.batch.ack"
							? [`inbox-batch:${envelope.requestId}`]
							: [],
				data,
			});
		},
	};
	for (const group of [
		createRunnerBridgeHandlers(bridgeOptions),
		createBridgeReadHandlers(bridgeOptions),
		createInboxBatchAckHandlers(bridgeOptions),
	])
		for (const [id, handler] of group) handlers.set(id, handler);
	const githubCalls: Array<{ method: string; number: number }> = [];
	let githubBindingCurrent = true;
	for (const [id, handler] of createGithubHandlers({
		client: {
			rest: {
				pulls: {
					get: async (args: {
						owner: string;
						repo: string;
						pull_number: number;
					}) => {
						expect([args.owner, args.repo, args.pull_number]).toEqual([
							"fixture",
							"repo",
							7,
						]);
						githubCalls.push({ method: "pulls.get", number: args.pull_number });
						return {
							data: {
								number: 7,
								title: issueId,
								draft: false,
								html_url: "https://github.com/fixture/repo/pull/7",
								head: { sha: "b".repeat(40) },
								base: { ref: "main", repo: { full_name: "fixture/repo" } },
							},
						};
					},
				},
				issues: {
					createComment: async (args: {
						owner: string;
						repo: string;
						issue_number: number;
						body: string;
					}) => {
						expect([
							args.owner,
							args.repo,
							args.issue_number,
							args.body,
						]).toEqual(["fixture", "repo", 7, issueId]);
						githubCalls.push({
							method: "issues.createComment",
							number: args.issue_number,
						});
						return {
							data: {
								id: 43,
								html_url:
									"https://github.com/fixture/repo/pull/7#issuecomment-43",
							},
						};
					},
				},
			},
		} as unknown as Octokit,
		policy: () => ({
			projectName: "fixture",
			leadId: "lead",
			owner: "fixture",
			repo: "repo",
			revision: "1",
		}),
		authorizeTarget: async (target) => {
			if (target.number !== 7 || !githubBindingCurrent)
				throw Error("fixture_pr_not_owned");
		},
		assertWriteTargetCurrent: () => {
			if (!githubBindingCurrent) throw Error("fixture_pr_not_owned");
		},
	}))
		handlers.set(id, handler);
	// Real adapters consume captured schemas; only the upstream SDK transport is a fixture.
	mkdirSync(join(root, "upstream-artifacts"), { mode: 0o700 });
	const upstreamArtifacts = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot: join(root, "upstream-artifacts"),
		assertCurrent: () => {
			if (!current) throw Error("fixture_activation_revoked");
		},
	});
	const attachmentCalls: string[] = [];
	let wrongAttachmentReceipt = false;
	for (const [id, handler] of createBridgeAttachmentHandlers({
		env: bridgeOptions.env,
		activationId,
		store: upstreamArtifacts,
		secrets: [],
		fetchImpl: async (url, init) => {
			if (String(url).endsWith("/attachments")) {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/discord/attachments",
				);
				const decoded = decodeAttachmentUpload(
					Buffer.from(init!.body as Uint8Array),
				);
				const body = decoded.envelope as {
					activationId: string;
					requestId: string;
					input: { threadId: string };
					receiptOnly: boolean;
				};
				expect(body.activationId).toBe(activationId);
				expect(body.input.threadId).toBe(threadId);
				expect(body.receiptOnly).toBe(false);
				expect(decoded.files[0]!.data.toString()).toBe(issueId);
				attachmentCalls.push("send");
				return Response.json({
					requestId: body.requestId,
					status: "succeeded",
					resourceRefs: ["discord-message:777777777777777777"],
					data: {
						messageId: "777777777777777777",
						receiptId: body.requestId,
						observedAt: observedAt(),
					},
				});
			}
			expect(String(url)).toBe(
				"http://127.0.0.1:31997/api/lead-capabilities/discord",
			);
			const body = JSON.parse(init!.body as string);
			expect(body.activationId).toBe(activationId);
			expect(body.input.threadId).toBe(threadId);
			attachmentCalls.push("get");
			return new Response(issueId, {
				headers: {
					"content-length": String(Buffer.byteLength(issueId)),
					"x-flywheel-request-id": wrongAttachmentReceipt
						? randomUUID()
						: body.requestId,
					"x-flywheel-artifact-mime": "text/plain",
					"x-flywheel-artifact-sha256": createHash("sha256")
						.update(issueId)
						.digest("hex"),
				},
			});
		},
	}))
		handlers.set(id, handler);
	const patrolCalls: string[] = [];
	const patrolText = "# Lead Patrol Snapshot\nproject: fixture\nlead: lead\n";
	const patrolSha = createHash("sha256").update(patrolText).digest("hex");
	const patrolFilename = "20260914T010101Z-tick1.md";
	let patrolEvidence = "";
	for (const [id, handler] of createPatrolHandlers({
		env: bridgeOptions.env,
		activationId,
		artifacts: upstreamArtifacts,
		secrets: [],
		githubClient: {
			request: async (route: string) => {
				patrolCalls.push(route);
				return { data: route.endsWith("/pulls") ? [] : { workflow_runs: [] } };
			},
		} as unknown as Octokit,
		fetchImpl: async (url, init) => {
			const body = JSON.parse(init!.body as string);
			expect(body.activationId).toBe(activationId);
			patrolCalls.push(body.operationId);
			if (body.operationId === "patrol.snapshot") {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/patrol-snapshot",
				);
				patrolEvidence = `patrol_${body.requestId}`;
				return Response.json({
					requestId: body.requestId,
					status: "succeeded",
					resourceRefs: [`patrol:${patrolFilename}:${patrolSha}`],
					data: {
						path: `/private/bridge/${patrolFilename}`,
						text: patrolText,
						sha256: patrolSha,
						steps: Array.from({ length: 6 }, (_, i) => ({
							step: i + 1,
							status: "unknown",
						})),
						evidenceHandle: patrolEvidence,
						observedAt: observedAt(),
					},
				});
			}
			expect(String(url)).toBe(
				"http://127.0.0.1:31997/api/lead-capabilities/patrol-judgment",
			);
			expect(body.input.executionId).toBe(executionId);
			expect(body.input.evidenceHandle).toBe(patrolEvidence);
			return Response.json({
				requestId: body.requestId,
				status: "succeeded",
				resourceRefs: [
					`pj:${patrolFilename}:${patrolSha}:${"a".repeat(64)}:0.0.0`,
				],
				data: {
					judgmentId: body.requestId,
					complete: true,
					gates: [1, 2, 3].map((gate) => ({ gate, passed: true, exitCode: 0 })),
					reportSha256: patrolSha,
					receiptId: body.requestId,
					observedAt: observedAt(),
				},
			});
		},
	}))
		handlers.set(id, handler);
	const reportId = "c".repeat(32);
	const reportCalls: Array<{ operationId: string; requestId: string }> = [];
	const reportOptions = {
		env: bridgeOptions.env,
		activationId,
		store: upstreamArtifacts,
		secrets: ["SYNTHETIC_API_SECRET"],
		fetchImpl: async (url: unknown, init?: RequestInit) => {
			const body = JSON.parse(init!.body as string);
			const cap = body.capability;
			expect(cap.activationId).toBe(activationId);
			reportCalls.push({
				operationId: cap.operationId,
				requestId: cap.requestId,
			});
			if (cap.operationId === "report.publish") {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/reports/publish",
				);
				expect(body.html).toBe(`<html>${issueId}</html>`);
				expect(cap.issueId).toBe(issueId);
				return Response.json({
					requestId: cap.requestId,
					reportId,
					url: `https://fw-reports-a1b2c3.vercel.app/r/${reportId}/`,
				});
			}
			expect(cap.reportId).toBe(reportId);
			let data: unknown, refs: string[];
			if (cap.operationId === "report.verify") {
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/reports/verify",
				);
				data = {
					reportId,
					httpStatus: 200,
					cspValid: true,
					nonceValid: true,
					receiptId: cap.requestId,
					observedAt: observedAt(),
				};
				refs = [reportId];
			} else {
				expect(cap.operationId).toBe("report.deliver");
				expect(String(url)).toBe(
					"http://127.0.0.1:31997/api/lead-capabilities/reports/deliver",
				);
				expect(cap.issueId).toBe(issueId);
				data = {
					reportId,
					messageId: "666666666666666666",
					channelId: threadId,
					delivery: "link-only",
					receiptId: cap.requestId,
					observedAt: observedAt(),
				};
				refs = ["666666666666666666"];
			}
			return Response.json({
				requestId: cap.requestId,
				status: "succeeded",
				resourceRefs: refs,
				data,
			});
		},
	};
	handlers.set(
		"artifact.text.create",
		createArtifactTextHandler({
			projectName: "fixture",
			leadId: "lead",
			activationId,
			store: upstreamArtifacts,
			secrets: ["SYNTHETIC_API_SECRET"],
			assertCurrent: () => {
				if (!current) throw Error("fixture_activation_revoked");
			},
		}),
	);
	for (const group of [
		createReportPublishHandlers(reportOptions),
		createReportVerifyHandlers(reportOptions),
		createReportDeliverHandlers(reportOptions),
	])
		for (const [id, handler] of group) handlers.set(id, handler);
	const upstreamAdapters: Array<{ close(): void }> = [];
	const upstreamCalls: Array<{ serverId: string; name: string }> = [];
	const upstreamStates = new Map<string, { drift: boolean }>();
	for (const serverId of ["gbrain", "xiaohongshu-mcp", "context7"] as const) {
		const snapshot = JSON.parse(
			readFileSync(
				resolve(
					`../../engineering/doc/FLY-2519-codex-lead-parity/upstream-${serverId}-schema.json`,
				),
				"utf8",
			),
		);
		const state = { drift: false };
		upstreamStates.set(serverId, state);
		const client = {
			getServerVersion: () => snapshot.serverInfo,
			listTools: async () => ({ tools: state.drift ? [] : snapshot.tools }),
			callTool: async (args: {
				name: string;
				arguments: Record<string, unknown>;
			}) => {
				upstreamCalls.push({ serverId, name: args.name });
				if (args.name === "get_feed_detail")
					expect(args.arguments.xsec_token).toBe("SYNTHETIC_XSEC");
				return {
					content: [
						{
							type: "text",
							text:
								serverId === "xiaohongshu-mcp"
									? JSON.stringify({
											feeds: [{ id: "feed", xsecToken: "SYNTHETIC_XSEC" }],
										})
									: `Fixture evidence for ${issueId}`,
						},
					],
				};
			},
		} as unknown as Client;
		const options = {
			env: bridgeOptions.env,
			activationId,
			client,
			secrets: ["SYNTHETIC_API_SECRET"],
		};
		if (serverId === "context7") {
			for (const [id, handler] of createContext7Handlers(options))
				handlers.set(id, handler);
		} else {
			const adapter = createUpstreamReadAdapter({
				...options,
				serverId,
				artifacts: upstreamArtifacts,
			});
			upstreamAdapters.push(adapter);
			for (const [id, handler] of adapter.handlers) handlers.set(id, handler);
		}
	}
	for (const [id, handler] of createUpstreamWriteDenials(bridgeOptions))
		handlers.set(id, handler);
	const operations = [
		"discord.message.attachments.get",
		"discord.message.attachments.send",
		"patrol.snapshot",
		"patrol.judgment.record",
		"artifact.text.create",
		"report.publish",
		"report.verify",
		"report.deliver",
		"github.pr.view",
		"github.pr.comment",
		"knowledge.search",
		"knowledge.delete_page",
		"xiaohongshu.list_feeds",
		"xiaohongshu.get_feed_detail",
		"xiaohongshu.publish_content",
		"docs.lookup",
		"start_runner",
		"bridge.read",
		"terminal.status",
		"inbox.batch.ack",
		"discord.thread.resolve",
		"discord.thread.read",
		"browser.list_pages",
		"linear.comment.create",
		"discord.thread.reply",
	];
	const manifest = createLeadCapabilityManifest({
		projectName: "fixture",
		leadId: "lead",
		identityDigest: "a".repeat(64),
		backend: "codex-app-server",
		profile: "full-access",
		activationId,
		browserGeneration: randomUUID(),
		sourceRevision: "fixture",
		operations: operations.map((id) => getLeadCapability(id)!),
		ruleSources: [
			{
				path: rule,
				sha256: createHash("sha256").update(readFileSync(rule)).digest("hex"),
			},
		],
		skillSources: [skillSource],
		integrations: [
			{
				id: "browser",
				version: "1.9.0",
				toolSchemaDigest: browserFacadeSchemaDigest(["list_pages"]),
			},
		],
	});
	const runtime = createCapabilityTuiRuntime(
		{
			capabilityBundleVersion: 2,
			carrierInstanceId: "SYNTHETIC_CARRIER",
			journalDbPath: join(root, "journal.db"),
			projectName: "fixture",
			leadId: "lead",
		} as CodexLeadTuiRuntimeConfig,
		{},
		{ info: () => {}, warn: () => {}, error: () => {} },
		{
			parent: async (input) => {
				journal = input.journal;
				parent = await startLeadCapabilityParent({
					manifest,
					journal,
					activationRoot: join(root, "activation"),
					codexHome: join(root, "home"),
					artifactRoot: join(root, "artifacts"),
					modelTempRoot: join(root, "project", "tmp"),
					nodePath: process.execPath,
					codexPath: "/fixture/codex",
					proxyEntryPath: "/fixture/proxy.js",
					modelEnv: { HOME: root },
					handlers,
					secrets: [
						"SYNTHETIC_BOT_SECRET",
						"SYNTHETIC_CARRIER",
						"SYNTHETIC_API_SECRET",
					],
					permissionProfile: {
						deploymentRoot: join(root, "deploy"),
						projectRoot: join(root, "project"),
						readPaths: [],
						credentialPaths: [join(root, "credentials")],
						proxyPort: 31999,
					},
					assertCurrent,
					verifyDeployment: async () => {},
					closeProviders: async () => {
						for (const adapter of upstreamAdapters) adapter.close();
						upstreamArtifacts.close();
						effects.push("providers-close");
					},
				});
				return parent;
			},
			server: async () => ({
				socketPath: join(root, "fixture-app.sock"),
				receipt: {
					transport: "app_server_socket",
					pid: process.pid,
					binarySha256: "0".repeat(64),
					argvSha256: "0".repeat(64),
					envSha256: "0".repeat(64),
				},
				assertCurrent,
				close: async () => {},
			}),
			generation: (_config, _logger, deps) => () => ({
				start: async () => {
					expect(deps.capabilitySession!.parent).toBe(parent);
					expect(deps.capabilitySession!.journal).toBe(journal);
				},
				stop: async () => {},
				onConnectionLost: () => () => {},
			}),
			killWindow: () => {},
		},
	);
	try {
		await runtime.start();
		expect(parent.baseInstructions).toContain(readFileSync(rule, "utf8"));
		expect(
			readFileSync(
				join(root, "home", "skills", "issue-fixture", "SKILL.md"),
				"utf8",
			),
		).toBe(skillText);
		expect(parent.skillSources.configured).toHaveLength(1);
		expect(() =>
			readManifestInstructions([{ path: rule, sha256: "0".repeat(64) }], []),
		).toThrow();
		const wrongSkillHome = join(root, "wrong-skill-home");
		mkdirSync(wrongSkillHome, { mode: 0o700 });
		expect(() =>
			installManifestSkills({
				codexHome: wrongSkillHome,
				sources: [{ ...skillSource, sha256: "0".repeat(64) }],
				secrets: [],
			}),
		).toThrow();
		expect(existsSync(join(wrongSkillHome, "skills"))).toBe(false);
		const sourceChecks = {
			activationId,
			issueId,
			rules: {
				sha256: manifest.ruleSources[0]!.sha256,
				loaded: true,
				wrongDigestRejected: true,
			},
			skills: {
				sha256: skillSource.sha256,
				installed: true,
				wrongDigestRejected: true,
				scope: "single_fixture_adapter",
			},
		};
		const entries = new LeadJournal({ store: journal });
		const entry = entries.accept({
			idempotencyKey: `issue:${issueId}`,
			source: "discord",
			payload: JSON.stringify({ issueId, threadId, executionId }),
		}).entry;
		entries.toDispatching(entry.id, executionId);
		const release = parent.enterDeliveryContext(entry.id);
		const call = async (
			operationId: string,
			input: unknown,
			requestId = randomUUID(),
		) => {
			const request = { schemaVersion: 1, operationId, requestId, input };
			const result = await requestLeadOperation(
				parent.pins.brokerSocket,
				request,
			);
			trace.push({ request, result });
			return result;
		};
		const requestId = randomUUID(),
			input = {
				issueId,
				taskCategory: "implement",
				idempotencyKey: "fixture-issue",
			};
		const started = await call("start_runner", input, requestId);
		expect(started).toMatchObject({ status: "succeeded" });
		expect(await call("start_runner", input, requestId)).toMatchObject({
			status: "succeeded",
			resourceRefs: started.resourceRefs,
		});
		expect(
			(
				await call(
					"start_runner",
					{ ...input, idempotencyKey: "changed" },
					requestId,
				)
			).status,
		).toBe("rejected");
		expect(effects.filter((e) => e === "runner-start")).toHaveLength(1);
		expect((await call("discord.thread.resolve", { issueId })).status).toBe(
			"succeeded",
		);
		expect(
			(await call("discord.thread.read", { threadId, limit: 10 })).status,
		).toBe("succeeded");
		expect(
			(
				await call("browser.list_pages", {
					generation: manifest.browserGeneration,
					arguments: {},
				})
			).status,
		).toBe("succeeded");
		expect(
			(
				await call("linear.comment.create", {
					issueId,
					body: "Fixture browser step completed",
				})
			).status,
		).toBe("succeeded");
		expect(
			(
				await call("discord.thread.reply", {
					threadId,
					text: "Fixture issue evidence recorded",
				})
			).status,
		).toBe("succeeded");
		expect(
			(await call("discord.thread.resolve", { issueId: "FLY-999999" })).status,
		).toBe("rejected");
		expect(
			(await call("bridge.read", { request: { resource: "health" } })).status,
		).toBe("succeeded");
		expect((await call("terminal.status", { executionId })).status).toBe(
			"succeeded",
		);
		const ackId = randomUUID();
		expect(
			(await call("inbox.batch.ack", { batchId: executionId }, ackId)).status,
		).toBe("succeeded");
		expect(
			(await call("inbox.batch.ack", { batchId: executionId }, ackId)).status,
		).toBe("succeeded");
		expect(effects.filter((effect) => effect === "inbox-ack")).toHaveLength(1);
		const beforeInvalid = providerTrace.length;
		for (const [id, input] of [
			["bridge.read", { request: { resource: "health", path: "/api/config" } }],
			["terminal.status", { executionId, command: "invalid" }],
			["inbox.batch.ack", { batchId: executionId, token: "invalid" }],
		] as const)
			expect((await call(id, input)).status).toBe("rejected");
		expect(providerTrace).toHaveLength(beforeInvalid);
		expect(await call("github.pr.view", { number: 7 })).toMatchObject({
			status: "succeeded",
			data: { pullRequest: { number: 7, head: "b".repeat(40) } },
		});
		const commentRequestId = randomUUID();
		for (let repeat = 0; repeat < 2; repeat++)
			expect(
				(
					await call(
						"github.pr.comment",
						{ number: 7, body: issueId },
						commentRequestId,
					)
				).status,
			).toBe("succeeded");
		expect(
			githubCalls.filter((entry) => entry.method === "issues.createComment"),
		).toHaveLength(1);
		const beforeWrongPr = githubCalls.length;
		for (const input of [{ number: 8 }, { number: 7, repo: "foreign" }])
			expect((await call("github.pr.view", input)).status).toBe("rejected");
		githubBindingCurrent = false;
		expect(
			(await call("github.pr.comment", { number: 7, body: issueId })).status,
		).toBe("rejected");
		expect(githubCalls).toHaveLength(beforeWrongPr);
		expect((await call("knowledge.search", { query: issueId })).status).toBe(
			"succeeded",
		);
		const feeds = await call("xiaohongshu.list_feeds", {});
		expect(feeds.status).toBe("succeeded");
		const feed = JSON.parse(
			(feeds.data as { result: { content: Array<{ text: string }> } }).result
				.content[0]!.text,
		).feeds[0];
		expect(feed.resourceHandle).toEqual(expect.any(String));
		expect(
			(
				await call("xiaohongshu.get_feed_detail", {
					feed_id: "feed",
					resourceHandle: feed.resourceHandle,
				})
			).status,
		).toBe("succeeded");
		const beforeForeign = upstreamCalls.length;
		expect(
			(
				await call("xiaohongshu.get_feed_detail", {
					feed_id: "foreign",
					resourceHandle: feed.resourceHandle,
				})
			).status,
		).not.toBe("succeeded");
		expect(upstreamCalls).toHaveLength(beforeForeign);
		expect(
			(
				await call("docs.lookup", {
					libraryId: "/fixture/library",
					query: issueId,
				})
			).status,
		).toBe("succeeded");
		for (const [id, input, code] of [
			["knowledge.delete_page", { slug: "fixture" }, "unclassified_write"],
			[
				"xiaohongshu.publish_content",
				{ title: issueId, content: "fixture", artifactHandles: ["fixture"] },
				"founder_write_gate_absent",
			],
		] as const) {
			const deniedId = randomUUID();
			for (let repeat = 0; repeat < 2; repeat++)
				expect(await call(id, input, deniedId)).toMatchObject({
					status: "rejected",
					errorCode: code,
				});
			expect(
				journal.operationReceipts.get({
					projectName: "fixture",
					leadId: "lead",
					operationId: id,
					requestId: deniedId,
				}),
			).toMatchObject({ state: "rejected", errorCode: code });
		}
		const beforeDrift = upstreamCalls.length;
		for (const [serverId, id, input] of [
			["gbrain", "knowledge.search", { query: issueId }],
			["xiaohongshu-mcp", "xiaohongshu.list_feeds", {}],
			[
				"context7",
				"docs.lookup",
				{ libraryId: "/fixture/library", query: issueId },
			],
		] as const) {
			upstreamStates.get(serverId)!.drift = true;
			expect(await call(id, input)).toMatchObject({
				status: "unknown",
				errorCode: "baseline_drift",
			});
		}
		expect(upstreamCalls).toHaveLength(beforeDrift);
		expect(upstreamCalls).toEqual([
			{ serverId: "gbrain", name: "search" },
			{ serverId: "xiaohongshu-mcp", name: "list_feeds" },
			{ serverId: "xiaohongshu-mcp", name: "get_feed_detail" },
			{ serverId: "context7", name: "query-docs" },
		]);
		const artifact = await call("artifact.text.create", {
			mimeType: "text/html",
			text: `<html>${issueId}</html>`,
		});
		expect(artifact.status).toBe("succeeded");
		const publishInput = {
			artifactHandle: (artifact.data as { artifactHandle: string })
				.artifactHandle,
			issueId,
			title: issueId,
		};
		const publishId = randomUUID();
		for (let repeat = 0; repeat < 2; repeat++)
			expect(
				(await call("report.publish", publishInput, publishId)).status,
			).toBe("succeeded");
		expect(reportCalls.map((entry) => entry.operationId)).toEqual([
			"report.publish",
		]);
		expect((await call("report.verify", { reportId })).status).toBe(
			"succeeded",
		);
		const deliverId = randomUUID();
		for (let repeat = 0; repeat < 2; repeat++)
			expect(
				(await call("report.deliver", { reportId, issueId }, deliverId)).status,
			).toBe("succeeded");
		const beforeBadReport = reportCalls.length;
		for (const [id, input] of [
			["report.publish", { ...publishInput, path: "/private/report.html" }],
			["report.verify", { reportId, url: "https://foreign.invalid" }],
			["report.deliver", { reportId, issueId, channelId: parentId }],
			[
				"artifact.text.create",
				{ mimeType: "application/octet-stream", text: "invalid text MIME" },
			],
		] as const)
			expect((await call(id, input)).status).toBe("rejected");
		expect(reportCalls).toHaveLength(beforeBadReport);
		expect(reportCalls.map((entry) => entry.operationId)).toEqual([
			"report.publish",
			"report.verify",
			"report.deliver",
		]);
		const attachmentInput = {
			threadId,
			messageId: "333333333333333333",
			attachmentId: "888888888888888888",
		};
		const attachment = await call(
			"discord.message.attachments.get",
			attachmentInput,
		);
		expect(attachment.status).toBe("succeeded");
		const attachmentHandle = (attachment.data as { artifactHandle: string })
			.artifactHandle;
		expect(
			(await upstreamArtifacts.read(attachmentHandle)).data.toString(),
		).toBe(issueId);
		const sendAttachmentId = randomUUID();
		for (let repeat = 0; repeat < 2; repeat++)
			expect(
				(
					await call(
						"discord.message.attachments.send",
						{
							threadId,
							artifactHandles: [attachmentHandle],
							text: issueId,
						},
						sendAttachmentId,
					)
				).status,
			).toBe("succeeded");
		expect(attachmentCalls).toEqual(["get", "send"]);
		wrongAttachmentReceipt = true;
		expect(
			(await call("discord.message.attachments.get", attachmentInput)).status,
		).toBe("unknown");
		const beforeBadAttachment = attachmentCalls.length;
		expect(
			(
				await call("discord.message.attachments.send", {
					threadId,
					artifactHandles: ["foreign"],
					text: issueId,
				})
			).status,
		).not.toBe("succeeded");
		expect(
			(
				await call("discord.message.attachments.get", {
					...attachmentInput,
					url: "https://foreign.invalid",
				})
			).status,
		).toBe("rejected");
		expect(attachmentCalls).toHaveLength(beforeBadAttachment);
		const snapshot = await call("patrol.snapshot", { tickId: "1" });
		expect(snapshot.status).toBe("succeeded");
		const patrolHandle = (snapshot.data as { artifactHandle: string })
			.artifactHandle;
		expect((await upstreamArtifacts.read(patrolHandle)).data.toString()).toBe(
			patrolText,
		);
		expect(JSON.stringify(snapshot)).not.toContain("/private/bridge");
		const judgmentInput = {
			tickId: "1",
			executionId,
			step: 1,
			judgment: "healthy",
			evidenceHandle: patrolHandle,
		};
		const judgmentRequestId = randomUUID();
		for (let repeat = 0; repeat < 2; repeat++)
			expect(
				(await call("patrol.judgment.record", judgmentInput, judgmentRequestId))
					.status,
			).toBe("succeeded");
		const beforeBadPatrol = patrolCalls.length;
		expect(
			(
				await call("patrol.judgment.record", {
					...judgmentInput,
					evidenceHandle: "foreign",
				})
			).status,
		).toBe("rejected");
		expect(patrolCalls).toHaveLength(beforeBadPatrol);
		expect(
			patrolCalls.filter((value) => value === "patrol.judgment.record"),
		).toHaveLength(1);
		expect(
			(
				await call("discord.thread.read", {
					threadId: "999999999999999999",
					limit: 10,
				})
			).status,
		).toBe("rejected");
		const browserCallsBefore = effects.filter(
			(value) => value === "browser-fixture",
		).length;
		expect(
			(
				await call("browser.list_pages", {
					generation: manifest.browserGeneration,
					arguments: {},
					url: "https://foreign.invalid",
				})
			).status,
		).toBe("rejected");
		expect(effects.filter((value) => value === "browser-fixture")).toHaveLength(
			browserCallsBefore,
		);
		const writesBeforeRevocation = effects.length;
		current = false;
		expect(
			(
				await call("linear.comment.create", {
					issueId,
					body: "Must not write after revoke",
				})
			).status,
		).toBe("rejected");
		expect(effects).toHaveLength(writesBeforeRevocation);
		expect(JSON.stringify(trace)).not.toMatch(
			/SYNTHETIC_BOT_SECRET|SYNTHETIC_CARRIER|SYNTHETIC_API_SECRET|SYNTHETIC_XSEC/,
		);
		release();
		const socket = parent.pins.brokerSocket;
		await runtime.stop();
		expect(existsSync(socket)).toBe(false);
		expect(() => journal.getById("absent")).toThrow();
		const reopened = new SqliteJournalStore(join(root, "journal.db"));
		let persisted: ReturnType<SqliteJournalStore["operationReceipts"]["get"]>;
		try {
			persisted = reopened.operationReceipts.get({
				projectName: "fixture",
				leadId: "lead",
				operationId: "start_runner",
				requestId,
			});
			expect(persisted).toMatchObject({
				state: "succeeded",
				activationId,
				providerRef: `runner-execution:${executionId}`,
			});
		} finally {
			reopened.close();
		}

		expect(effects).toEqual([
			"runner-start",
			"browser-fixture",
			"linear-comment",
			"discord-reply",
			"inbox-ack",
			"providers-close",
		]);
		console.info(
			"FLY2519_PARITY_FIXTURE=" +
				JSON.stringify({
					schemaVersion: 1,
					scope: "fixture",
					issueId,
					executionId,
					activationId,
					threadId,
					realComponents: [
						"TUI lifecycle owner",
						"capability parent",
						"UDS broker",
						"SQLite operation receipts",
						"typed Discord handlers",
						"typed Linear handlers",
						"typed Bridge runner, read and inbox handlers",
						"typed knowledge, Xiaohongshu and Context7 adapters",
						"typed GitHub handlers",
						"artifact store and typed report handlers",
						"typed attachment handlers and patrol artifact projection",
					],
					fixtureBoundaries: [
						"parent assembly inputs",
						"registry authority",
						"runner service",
						"Bridge API responses",
						"attachment service and patrol helper/gate responses",
						"report publishing, verification and delivery service responses",
						"Discord API",
						"Linear SDK",
						"GitHub SDK and issue ownership authority",
						"upstream MCP SDK responses from captured schemas",
						"browser provider",
						"model isolation",
						"app-server process",
						"TUI generation/window",
					],
					sourceChecks,
					trace,
					providerTrace,
					upstreamCalls,
					githubCalls,
					reportCalls,
					attachmentCalls,
					patrolCalls,
					persisted,
					effects,
					cleanup: {
						brokerSocketRemoved: !existsSync(socket),
						journalClosed: true,
					},
					hostVerified: false,
					parityVerified: false,
				}),
		);
	} finally {
		await runtime.stop();
		for (const adapter of upstreamAdapters) adapter.close();
		upstreamArtifacts.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
