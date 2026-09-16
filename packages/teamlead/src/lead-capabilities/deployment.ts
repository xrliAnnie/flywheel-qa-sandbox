import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const LEAD_DEPLOYMENT_ENTRIES = [
	"bin/verify-codex-deployment.js",
	"lead-backends/codex/codex-lead-runtime.js",
	"lead-backends/codex/codex-lead-tui-runtime.js",
	"lead-backends/codex/capability-mcp-entry.js",
	"lead-backends/codex/capability-readiness.js",
	"lead-backends/codex/capability-app-server.js",
	"lead-backends/codex/capability-tui-runtime.js",
	"lead-backends/codex/daemon-ws.js",
	"lead-backends/codex/tui-window.js",
	"lead-capabilities/runtime-parent.js",
	"lead-capabilities/runtime-factory.js",
	"lead-capabilities/default-runtime.js",
	"lead-capabilities/broker.js",
	"lead-backends/codex/runner-action-schemas.js",
	"lead-backends/codex/runner-action-names.js",
	"lead-capabilities/browser-provider.js",
	"lead-capabilities/browser-host-identity.js",
	"lead-capabilities/browser-worker.js",
	"lead-capabilities/bounded-stdio-transport.js",
	"lead-capabilities/gbrain-host.js",
	"lead-capabilities/gbrain-transport.js",
	"lead-capabilities/gbrain-provider.js",
	"lead-capabilities/browser-sandbox.js",
	"lead-capabilities/browser-isolation.js",
	"lead-capabilities/model-isolation.js",
	"lead-capabilities/manifest-instructions.js",
	"lead-capabilities/manifest-skills.js",
	"lead-capabilities/native-skills.js",
	"lead-capabilities/native-home.js",
	"lead-capabilities/native-resource-baseline.js",
	"lead-capabilities/native-skill-baseline.js",
	"lead-capabilities/persona-skill-baseline.js",
	"lead-capabilities/skill-discovery.js",
	"lead-capabilities/skill-adapters.js",
	"lead-capabilities/linear-client.js",
	"lead-capabilities/handlers/linear.js",
	"lead-capabilities/handlers/linear-provider.js",
	"lead-capabilities/credential-paths.js",
	"lead-capabilities/automatic-outbound.js",
	"lead-capabilities/handlers/bridge-read.js",
	"lead-capabilities/handlers/github.js",
	"lead-capabilities/handlers/github-provider.js",
	"lead-capabilities/github-client.js",
	"lead-capabilities/discord-attachments.js",
	"lead-capabilities/attachment-upload.js",
	"lead-capabilities/handlers/bridge-attachments.js",
	"bridge/lead-github-binding.js",
	"bridge/lead-memory.js",
	"bridge/lead-github-handlers.js",
	"bridge/lead-github-write.js",
	"bridge/lead-runner-operation.js",
	"bridge/lead-capability-runners.js",
	"lead-capabilities/handlers/report-publish.js",
	"lead-capabilities/handlers/artifact-text.js",
	"lead-capabilities/handlers/report-verify.js",
	"lead-capabilities/handlers/report-deliver.js",
] as const;
const unverified = () => new Error("lead_deployment_unverified");
export interface LeadDeploymentReceipt {
	schemaVersion: 1;
	checkoutRoot: string;
	headSha: string;
	observedAt: string;
	entrySha256: Record<string, string>;
}
/** Read only the updater's existing deployment truth. No fetching/building or
 * new bundle registry; this receipt records observed artifacts, not reproducibility. */
export function verifyLeadDeployment(options: {
	checkoutRoot: string;
	deployedShaPath: string;
}): LeadDeploymentReceipt {
	try {
		const root = options.checkoutRoot;
		if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
			throw unverified();
		function bytes(path: string, limit: number) {
			if (realpathSync(path) !== path) throw unverified();
			const fd = openSync(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const before = fstatSync(fd);
				if (
					!before.isFile() ||
					before.nlink !== 1 ||
					before.size > limit ||
					(before.mode & 0o022) !== 0
				)
					throw unverified();
				const buffer = Buffer.alloc(limit + 1),
					size = readSync(fd, buffer, 0, buffer.length, 0),
					after = fstatSync(fd);
				if (
					size !== before.size ||
					size > limit ||
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					before.ctimeMs !== after.ctimeMs
				)
					throw unverified();
				return buffer.subarray(0, size);
			} finally {
				closeSync(fd);
			}
		}
		const head = () =>
			execFileSync(
				"/usr/bin/git",
				["-C", root, "rev-parse", "--verify", "HEAD"],
				{
					encoding: "utf8",
					timeout: 5000,
					maxBuffer: 4096,
					stdio: ["ignore", "pipe", "ignore"],
					env: {
						PATH: "/usr/bin:/bin",
						HOME: "/var/empty",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_OPTIONAL_LOCKS: "0",
					},
				},
			).trim();
		const deployed = () =>
			bytes(options.deployedShaPath, 128).toString("utf8").trim();
		const headSha = head();
		if (!/^[a-f0-9]{40}$/.test(headSha) || deployed() !== headSha)
			throw unverified();
		const entrySha256: Record<string, string> = {};
		for (const entry of LEAD_DEPLOYMENT_ENTRIES) {
			const data = bytes(
				join(root, "packages/teamlead/dist", entry),
				4 * 1024 * 1024,
			);
			if (data.length === 0) throw unverified();
			entrySha256[entry] = createHash("sha256").update(data).digest("hex");
		}
		if (head() !== headSha || deployed() !== headSha) throw unverified();
		return {
			schemaVersion: 1,
			checkoutRoot: root,
			headSha,
			observedAt: new Date().toISOString(),
			entrySha256,
		};
	} catch {
		throw unverified();
	}
}

/** Last verified startup receipt in the existing parent state directory. */
export function recordLeadDeployment(options: {
	checkoutRoot: string;
	deployedShaPath: string;
	stateDir: string;
}): LeadDeploymentReceipt {
	const receipt = verifyLeadDeployment(options),
		state = options.stateDir;
	const directory = lstatSync(state);
	if (
		realpathSync(state) !== state ||
		!directory.isDirectory() ||
		directory.uid !== process.getuid?.() ||
		(directory.mode & 0o022) !== 0
	)
		throw unverified();
	const path = join(state, "capability-deployment.json");
	try {
		const existing = lstatSync(path);
		if (
			!existing.isFile() ||
			existing.nlink !== 1 ||
			existing.uid !== process.getuid?.()
		)
			throw unverified();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unverified();
	}
	const temp = join(state, `.deployment-${randomUUID()}.tmp`);
	try {
		const fd = openSync(
			temp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(fd, `${JSON.stringify(receipt)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
	return receipt;
}
