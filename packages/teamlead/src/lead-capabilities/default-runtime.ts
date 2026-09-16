import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexLeadRuntimeConfig } from "../lead-backends/codex/codex-lead-runtime.js";
import type { SqliteJournalStore } from "../lead-backends/codex/SqliteJournalStore.js";
import { resolveLeadMenus } from "../workflow-menu.js";
import { LeadArtifactStore } from "./artifacts.js";
import { leadCredentialAliases } from "./credential-paths.js";
import { verifyLeadDeployment } from "./deployment.js";
import { preparePinnedNativeSkillHome } from "./native-home.js";
import { leadModelWritableRoot } from "./permission-profile.js";
import { createLeadCapabilityContext } from "./runtime-context.js";
import { startLeadRuntimeParent } from "./runtime-factory.js";
import { discoverLeadRuleSources } from "./skill-discovery.js";

/** Actual launcher composition. No model inputs, source overrides or production activation bypasses. */
export async function startDefaultLeadCapabilityParent(input: {
	config: CodexLeadRuntimeConfig;
	journal: SqliteJournalStore;
	carrierInstanceId: string;
}) {
	const { config } = input;
	if (config.capabilityBundleVersion !== 2 || !config.fullAccessProjectRoot)
		throw new Error("default_capability_configuration_invalid");
	const deploymentRoot = realpathSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
	);
	const env: NodeJS.ProcessEnv = Object.freeze({
		...process.env,
		FLYWHEEL_PROJECT_NAME: config.projectName,
		FLYWHEEL_LEAD_ID: config.leadId,
		FLYWHEEL_LEAD_IDENTITY_DIGEST: config.identityDigest,
		FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: input.carrierInstanceId,
		FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
		FLYWHEEL_CODEX_LEAD_PROJECT_DIR: config.fullAccessProjectRoot,
		FLYWHEEL_BRIDGE_URL: config.bridgeUrl,
		FLYWHEEL_API_TOKEN: config.apiToken,
	});
	const trusted = createLeadCapabilityContext(env);
	const row = trusted.assertActivationCurrent();
	const projectRoot = trusted.projectRoot;
	if (projectRoot !== realpathSync(config.fullAccessProjectRoot))
		throw new Error("default_capability_project_changed");
	const home = realpathSync(env.HOME!);
	const deployment = () =>
		verifyLeadDeployment({
			checkoutRoot: deploymentRoot,
			deployedShaPath: join(home, ".flywheel/deployed-sha"),
		});
	const baseline = deployment();
	const deploymentIdentity = (value: ReturnType<typeof verifyLeadDeployment>) =>
		JSON.stringify({
			checkoutRoot: value.checkoutRoot,
			headSha: value.headSha,
			entrySha256: value.entrySha256,
		});
	const initialDeployment = deploymentIdentity(baseline);
	const codexPath = realpathSync(config.codexBin),
		nodePath = realpathSync(process.execPath);
	if (
		[codexPath, nodePath].some(
			(path) => path === projectRoot || path.startsWith(`${projectRoot}/`),
		)
	)
		throw new Error("default_capability_executable_in_workspace");
	const version = execFileSync(codexPath, ["--version"], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 4096,
		stdio: ["ignore", "pipe", "ignore"],
		env: { PATH: "/usr/bin:/bin", HOME: home },
	})
		.trim()
		.replace(/^codex-cli\s+/, "");
	const linearToken = env.LINEAR_API_KEY;
	if (!linearToken) throw new Error("default_capability_linear_unavailable");
	const secrets = [
		config.apiToken,
		config.botToken,
		input.carrierInstanceId,
		linearToken,
		env.CONTEXT7_API_KEY ?? "",
		env.GH_TOKEN ?? "",
		env.GITHUB_TOKEN ?? "",
	].filter(Boolean);
	const activationId = randomUUID();
	let closed = false;
	const owned: Array<{ path: string; dev: number; ino: number }> = [];
	const directory = (parent: string, prefix: string) => {
		const path = realpathSync(mkdtempSync(join(parent, prefix)));
		const stat = lstatSync(path);
		owned.push({ path, dev: stat.dev, ino: stat.ino });
		return path;
	};
	let native: ReturnType<typeof preparePinnedNativeSkillHome> | undefined;
	let artifacts: LeadArtifactStore | undefined;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		let failed = false;
		const actions = [
			() => artifacts?.close(),
			() => native?.close(),
			...owned
				.slice()
				.reverse()
				.map((item) => () => {
					if (existsSync(item.path)) {
						const now = lstatSync(item.path);
						if (
							!now.isSymbolicLink() &&
							now.dev === item.dev &&
							now.ino === item.ino
						)
							rmSync(item.path, { recursive: true });
					}
				}),
		];
		for (const action of actions) {
			try {
				action();
			} catch {
				failed = true;
			}
		}
		if (failed) throw new Error("default_capability_cleanup_failed");
	};
	try {
		const writableRoot = leadModelWritableRoot({ projectRoot, deploymentRoot });
		if (!existsSync(writableRoot)) mkdirSync(writableRoot, { mode: 0o700 });
		if (realpathSync(writableRoot) !== writableRoot)
			throw new Error("default_capability_workspace_invalid");
		// Short private root avoids the platform UDS pathname limit; no provider secrets are written here.
		const activationRoot = directory(realpathSync("/tmp"), "fw-cap-");
		const artifactRoot = directory(projectRoot, ".flywheel-artifacts-");
		const modelTempRoot = directory(writableRoot, ".flywheel-model-");
		native = preparePinnedNativeSkillHome({
			codexHome: realpathSync(config.codexHome),
			codexVersion: version,
			secrets,
		});
		const current = () => {
			if (closed) throw new Error("default_capability_closed");
			const now = trusted.assertActivationCurrent();
			if (now.identity.identityDigest !== row.identity.identityDigest)
				throw new Error("default_capability_identity_changed");
			native!.assertCurrent();
			for (const item of owned) {
				const stat = lstatSync(item.path);
				if (
					stat.isSymbolicLink() ||
					stat.dev !== item.dev ||
					stat.ino !== item.ino
				)
					throw new Error("default_capability_directory_changed");
			}
		};
		artifacts = new LeadArtifactStore({
			projectRoot,
			artifactRoot,
			assertCurrent: current,
		});
		const discover = () =>
			discoverLeadRuleSources({
				homeDir: home,
				workspaceDir: join(home, ".flywheel/lead-workspace", config.leadId),
				scriptsDir: join(deploymentRoot, "packages/teamlead/scripts"),
				projectRoot,
				leadId: config.leadId,
				backend: "codex-app-server",
				role: "dept",
				commBackend:
					(env.FLYWHEEL_COMM_BACKEND ?? "mailbox").trim().toLowerCase() ===
					"commdb"
						? "commdb"
						: "mailbox",
				hasSummaryDuty: row.identity.hasSummaryDuty === true,
				inboxEnabled: existsSync(
					join(deploymentRoot, "packages/inbox-mcp/dist"),
				),
				screencaptureEnabled: env.LEAD_DISABLE_SCREENCAPTURE_SKILL !== "1",
			});
		const sources = discover();
		const menus = () =>
			resolveLeadMenus({ projectRoot, leadId: config.leadId }).map(
				(menu) => menu.shape,
			);
		const adopted = menus();
		const assertPreparedCurrent = async () => {
			current();
			if (
				deploymentIdentity(deployment()) !== initialDeployment ||
				JSON.stringify(discover()) !== JSON.stringify(sources) ||
				JSON.stringify(menus()) !== JSON.stringify(adopted)
			)
				throw new Error("default_capability_preparation_changed");
		};
		const require = createRequire(import.meta.url);
		const parent = await startLeadRuntimeParent({
			env,
			activationId,
			linearToken,
			context7ApiKey: env.CONTEXT7_API_KEY,
			artifacts,
			secrets,
			sources: {
				sourceRevision: baseline.headSha,
				records: sources.records,
				skillInventory: sources.skillInventory,
			},
			adoptedMenuShapes: adopted,
			assertPreparedCurrent,
			browser: {
				packageRoot: dirname(
					require.resolve("chrome-devtools-mcp/package.json"),
				),
				nodeExecutable: nodePath,
				chromeExecutable:
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				projectRoot,
				qaParentRoot: activationRoot,
				egress: () => ({ protectedPorts: [], localQaTargets: [] }),
				revokeQaIdentity: async () => {
					/* No external identity is minted. Provider close invalidates generation/profile. */
				},
			},
			parent: {
				journal: input.journal,
				activationRoot,
				codexHome: realpathSync(config.codexHome),
				artifactRoot,
				modelTempRoot,
				nodePath,
				codexPath,
				codexVersion: version,
				proxyEntryPath: join(
					deploymentRoot,
					"packages/teamlead/dist/lead-backends/codex/capability-mcp-entry.js",
				),
				permissionProfile: {
					deploymentRoot,
					projectRoot,
					readPaths: [
						deploymentRoot,
						nodePath,
						codexPath,
						join(realpathSync(config.codexHome), "skills"),
					],
					credentialPaths: leadCredentialAliases(
						env,
						realpathSync(config.codexHome),
					),
				},
				verifyDeployment: async () => {
					await assertPreparedCurrent();
				},
			},
		});
		return {
			...parent,
			close: async () => {
				try {
					await parent.close();
				} finally {
					cleanup();
				}
			},
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}
