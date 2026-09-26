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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { parseAndValidateProjects } from "../ProjectConfig.js";
import type { VoiceBackgroundBrowserMode } from "../ProjectConfig.js";
import { resolveLeadMenus } from "../workflow-menu.js";
import { SqliteJournalStore } from "../lead-backends/codex/SqliteJournalStore.js";
import { LeadArtifactStore } from "./artifacts.js";
import { leadCredentialAliases } from "./credential-paths.js";
import { verifyLeadDeployment } from "./deployment.js";
import { preparePinnedNativeSkillHome } from "./native-home.js";
import { leadModelWritableRoot } from "./permission-profile.js";
import { startLeadRuntimeParent } from "./runtime-factory.js";
import { discoverLeadRuleSources } from "./skill-discovery.js";
import { resolveVoiceBackgroundCapabilities } from "./voice-resolve.js";

export interface VoiceCapabilityParentInput {
	projectName: string;
	leadId: string;
	sessionId: string;
	leaseFence: string;
	browserMode: VoiceBackgroundBrowserMode;
	codexHome: string;
	codexBin: string;
	activationRoot: string;
	projectsPath: string;
	/** Synchronous local lease fence owned by the voice daemon. */
	assertLeaseCurrent(): void;
	env?: NodeJS.ProcessEnv;
}

/** Build one subscription-backed capability parent without claiming the resident carrier. */
export async function startVoiceCapabilityParent(
	input: VoiceCapabilityParentInput,
) {
	const sourceEnv = input.env ?? process.env;
	const hostHome = realpathSync(sourceEnv.HOME ?? homedir());
	const projectsPath = realpathSync(input.projectsPath);
	const initial = resolveLeadIdentityRow({
		projectsPath,
		homeDir: hostHome,
		projectName: input.projectName,
		leadId: input.leadId,
	});
	const resolution = resolveVoiceBackgroundCapabilities({
		project: initial.project,
		leadId: input.leadId,
		sessionId: input.sessionId,
		browserMode: input.browserMode,
	});
	const projectRoot = realpathSync(initial.project.projectRoot);
	const deploymentRoot = realpathSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
	);
	const activationRoot = realpathSync(input.activationRoot);
	const codexHome = realpathSync(input.codexHome);
	const codexPath = realpathSync(input.codexBin);
	const nodePath = realpathSync(process.execPath);
	const version = execFileSync(codexPath, ["--version"], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 4096,
		stdio: ["ignore", "pipe", "ignore"],
		env: { PATH: "/usr/bin:/bin", HOME: hostHome },
	})
		.trim()
		.replace(/^codex-cli\s+/, "");
	const env: NodeJS.ProcessEnv = Object.freeze({
		...sourceEnv,
		HOME: hostHome,
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_PROJECT_NAME: input.projectName,
		FLYWHEEL_LEAD_ID: input.leadId,
		FLYWHEEL_LEAD_IDENTITY_DIGEST: initial.identity.identityDigest,
		FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
		FLYWHEEL_CODEX_LEAD_PROJECT_DIR: projectRoot,
		FLYWHEEL_BRIDGE_URL:
			sourceEnv.FLYWHEEL_BRIDGE_URL ?? sourceEnv.BRIDGE_URL ?? "",
		FLYWHEEL_API_TOKEN:
			sourceEnv.FLYWHEEL_API_TOKEN ?? sourceEnv.TEAMLEAD_API_TOKEN ?? "",
	});
	const linearToken = env.LINEAR_API_KEY;
	if (!linearToken) throw new Error("voice_capability_linear_unavailable");
	const baseline = verifyLeadDeployment({
		checkoutRoot: deploymentRoot,
		deployedShaPath: join(hostHome, ".flywheel/deployed-sha"),
	});
	const deploymentIdentity = JSON.stringify({
		checkoutRoot: baseline.checkoutRoot,
		headSha: baseline.headSha,
		entrySha256: baseline.entrySha256,
	});
	const secrets = [
		env.FLYWHEEL_API_TOKEN ?? "",
		input.leaseFence,
		linearToken,
		env.CONTEXT7_API_KEY ?? "",
		env.GH_TOKEN ?? "",
		env.GITHUB_TOKEN ?? "",
	].filter(Boolean);
	let closed = false;
	const currentIdentity = () => {
		if (closed) throw new Error("voice_capability_closed");
		input.assertLeaseCurrent();
		const row = resolveLeadIdentityRow({
			projectsPath,
			homeDir: hostHome,
			projectName: input.projectName,
			leadId: input.leadId,
		});
		if (row.identity.identityDigest !== initial.identity.identityDigest)
			throw new Error("voice_capability_identity_changed");
		resolveVoiceBackgroundCapabilities({
			project: row.project,
			leadId: input.leadId,
			sessionId: input.sessionId,
			browserMode: input.browserMode,
		});
		return row;
	};
	currentIdentity();
	const writableRoot = leadModelWritableRoot({ projectRoot, deploymentRoot });
	if (!existsSync(writableRoot)) mkdirSync(writableRoot, { mode: 0o700 });
	const artifactRoot = realpathSync(
		mkdtempSync(join(projectRoot, ".flywheel-artifacts-")),
	);
	const modelTempRoot = realpathSync(
		mkdtempSync(join(writableRoot, ".flywheel-voice-model-")),
	);
	const journalRoot = join(activationRoot, "journal");
	mkdirSync(journalRoot, { mode: 0o700 });
	const journal = new SqliteJournalStore(join(journalRoot, "journal.db"));
	let native: ReturnType<typeof preparePinnedNativeSkillHome> | undefined;
	let artifacts: LeadArtifactStore | undefined;
	let parent: Awaited<ReturnType<typeof startLeadRuntimeParent>> | undefined;
	const cleanup = async () => {
		if (closed) return;
		closed = true;
		try {
			await parent?.close();
		} finally {
			try {
				journal.close();
			} finally {
				artifacts?.close();
				native?.close();
				for (const path of [artifactRoot, modelTempRoot]) {
					if (existsSync(path) && !lstatSync(path).isSymbolicLink())
						rmSync(path, { recursive: true, force: true });
				}
			}
		}
	};
	try {
		native = preparePinnedNativeSkillHome({
			codexHome,
			codexVersion: version,
			secrets,
		});
		const current = () => {
			const row = currentIdentity();
			native!.assertCurrent();
			for (const path of [artifactRoot, modelTempRoot, activationRoot]) {
				const stat = lstatSync(path);
				if (stat.isSymbolicLink() || realpathSync(path) !== path)
					throw new Error("voice_capability_directory_changed");
			}
			return row;
		};
		artifacts = new LeadArtifactStore({
			projectRoot,
			artifactRoot,
			assertCurrent: current,
		});
		const discover = () =>
			discoverLeadRuleSources({
				homeDir: hostHome,
				workspaceDir: join(
					hostHome,
					".flywheel/lead-workspace",
					input.leadId,
				),
				scriptsDir: join(deploymentRoot, "packages/teamlead/scripts"),
				projectRoot,
				leadId: input.leadId,
				backend: initial.identity.backend,
				role: "dept",
				commBackend:
					(env.FLYWHEEL_COMM_BACKEND ?? "mailbox").trim().toLowerCase() ===
					"commdb"
						? "commdb"
						: "mailbox",
				hasSummaryDuty: initial.identity.hasSummaryDuty === true,
				inboxEnabled: existsSync(
					join(deploymentRoot, "packages/inbox-mcp/dist"),
				),
				screencaptureEnabled: env.LEAD_DISABLE_SCREENCAPTURE_SKILL !== "1",
			});
		const sources = discover();
		const adopted = resolveLeadMenus({
			projectRoot,
			leadId: input.leadId,
		}).map((menu) => menu.shape);
		const assertPreparedCurrent = async () => {
			current();
			const deployment = verifyLeadDeployment({
				checkoutRoot: deploymentRoot,
				deployedShaPath: join(hostHome, ".flywheel/deployed-sha"),
			});
			if (
				JSON.stringify({
					checkoutRoot: deployment.checkoutRoot,
					headSha: deployment.headSha,
					entrySha256: deployment.entrySha256,
				}) !== deploymentIdentity ||
				JSON.stringify(discover()) !== JSON.stringify(sources)
			)
				throw new Error("voice_capability_preparation_changed");
		};
		const require = createRequire(import.meta.url);
		parent = await startLeadRuntimeParent({
			env,
			activationId: resolution.identity.activationId,
			authority: {
				kind: "voice_session",
				sessionId: input.sessionId,
				leaseFence: input.leaseFence,
			},
			assertActivationCurrent: currentIdentity,
			linearToken,
			context7ApiKey: env.CONTEXT7_API_KEY,
			artifacts,
			secrets,
			operations: resolution.operations,
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
				revokeQaIdentity: async () => {},
			},
			parent: {
				journal,
				recoveryScope: "activation",
				activationRoot,
				codexHome,
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
					readPaths: [deploymentRoot, nodePath, codexPath],
					credentialPaths: leadCredentialAliases(env, codexHome),
				},
				verifyDeployment: async () => assertPreparedCurrent(),
			},
		});
		return Object.freeze({
			...parent,
			cwd: projectRoot,
			close: cleanup,
		});
	} catch (error) {
		await cleanup();
		throw error;
	}
}
