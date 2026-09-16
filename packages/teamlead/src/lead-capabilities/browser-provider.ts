import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import type { LeadArtifactStore } from "./artifacts.js";
import {
	BROWSER_UPSTREAM_SCHEMA_DIGEST,
	type BrowserWorkerSpecInput,
} from "./browser-config.js";
import type { BrowserEgressPolicy } from "./browser-egress.js";
import { startBrowserEgressProxy } from "./browser-egress-proxy.js";
import { verifyBrowserIsolation } from "./browser-isolation.js";
import { BrowserWorker } from "./browser-worker.js";
import { createBrowserHandlers } from "./handlers/browser.js";

/** Activation-owned browser provider. Caller owns the shared artifact store and
 * supplies any product QA identity revoker; the host verifier is fixed here. */
export async function startBrowserProvider(
	options: Omit<BrowserWorkerSpecInput, "qaRoot" | "proxyPort"> & {
		activationId: string;
		qaParentRoot: string;
		store: LeadArtifactStore;
		assertCurrent(): void;
		egress(): BrowserEgressPolicy;
		revokeQaIdentity(): Promise<void>;
	},
) {
	let qaRoot: string | undefined;
	let proxy: Awaited<ReturnType<typeof startBrowserEgressProxy>> | undefined;
	let worker: BrowserWorker | undefined;
	let closed = false,
		closing: Promise<void> | undefined;
	const current = () => {
		if (closed) throw new Error("browser_provider_closed");
		options.assertCurrent();
	};
	const close = () => {
		if (closing) return closing;
		closed = true;
		closing = (async () => {
			try {
				await worker?.close();
			} finally {
				try {
					await proxy?.close();
				} finally {
					try {
						await options.revokeQaIdentity();
					} finally {
						if (qaRoot) rmSync(qaRoot, { recursive: true, force: true });
					}
				}
			}
		})();
		return closing;
	};
	try {
		current();
		const parent = options.qaParentRoot,
			stat = lstatSync(parent);
		const under = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
		if (
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			realpathSync(parent) !== parent ||
			under(parent, options.projectRoot) ||
			under(options.projectRoot, parent)
		)
			throw new Error("browser_provider_root_invalid");
		qaRoot = mkdtempSync(join(parent, "browser-"));
		for (const name of ["profile", "tmp", "artifacts"])
			mkdirSync(join(qaRoot, name), { mode: 0o700 });
		proxy = await startBrowserEgressProxy({
			policy: options.egress,
			assertCurrent: current,
		});
		current();
		const workerArtifactRoot = join(qaRoot, "artifacts");
		worker = new BrowserWorker({
			input: {
				packageRoot: options.packageRoot,
				nodeExecutable: options.nodeExecutable,
				chromeExecutable: options.chromeExecutable,
				projectRoot: options.projectRoot,
				qaRoot,
				proxyPort: proxy.port,
			},
			artifactRoot: workerArtifactRoot,
			expectedUpstreamSchemaDigest: BROWSER_UPSTREAM_SCHEMA_DIGEST,
			assertCurrent: current,
			egress: options.egress,
			verifyIsolation: (launch) =>
				verifyBrowserIsolation(launch, { proxyPort: proxy!.port }),
		});
		const generation = await worker.start();
		current();
		const handlers = createBrowserHandlers({
			activationId: options.activationId,
			generation,
			worker,
			workerArtifactRoot,
			store: options.store,
			assertCurrent: current,
		});
		return Object.freeze({
			generation,
			handlers,
			proxyPort: proxy.port,
			close,
		});
	} catch (error) {
		try {
			await close();
		} catch {
			/* Preserve startup failure after attempting every cleanup. */
		}
		throw error;
	}
}
