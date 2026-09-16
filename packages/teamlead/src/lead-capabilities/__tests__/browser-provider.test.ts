import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { BROWSER_UPSTREAM_SCHEMA_DIGEST } from "../browser-config.js";
import { verifyBrowserIsolation } from "../browser-isolation.js";
import { startBrowserProvider } from "../browser-provider.js";

vi.mock("../browser-isolation.js", () => ({
	verifyBrowserIsolation: vi.fn(async () => {}),
}));

const worker = vi.hoisted(() => ({
	start: vi.fn(),
	close: vi.fn(),
	call: vi.fn(),
	input: undefined as any,
}));
vi.mock("../browser-worker.js", () => ({
	BrowserWorker: class {
		constructor(input: unknown) {
			worker.input = input;
		}
		start = worker.start;
		close = worker.close;
		call = worker.call;
	},
}));
it.each([false, true])(
	"owns real proxy/profile lifecycle and cleans partial startup failure=%s",
	async (failed) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-provider-")));
		let provider: Awaited<ReturnType<typeof startBrowserProvider>> | undefined;
		try {
			const projectRoot = join(root, "project"),
				qaParentRoot = join(root, "qa");
			mkdirSync(projectRoot, { mode: 0o700 });
			mkdirSync(qaParentRoot, { mode: 0o700 });
			const artifactRoot = join(projectRoot, "artifacts");
			mkdirSync(artifactRoot, { mode: 0o700 });
			const store = new LeadArtifactStore({
				projectRoot,
				artifactRoot,
				assertCurrent: () => {},
			});
			worker.close.mockReset().mockImplementation(async () => {
				if (failed) throw new Error("worker_close_failed");
			});
			vi.mocked(verifyBrowserIsolation).mockClear();
			worker.start.mockReset().mockImplementation(async () => {
				await worker.input.verifyIsolation({ policy: "test-policy" });
				if (failed) throw new Error("upstream_unavailable");
				return "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
			});
			const revokeQaIdentity = vi.fn(async () => {
				expect(worker.close).toHaveBeenCalledOnce();
				if (failed) throw new Error("qa_revoke_failed");
			});
			const options = {
				activationId: "a1",
				projectRoot,
				qaParentRoot,
				packageRoot: "/opt/browser",
				nodeExecutable: "/opt/node",
				chromeExecutable:
					"/Applications/Chrome.app/Contents/MacOS/Google Chrome",
				store,
				assertCurrent: () => {},
				egress: () => ({
					protectedOrigins: [],
					protectedPorts: [],
					localQaTargets: [],
				}),
				revokeQaIdentity,
			};
			if (failed)
				await expect(startBrowserProvider(options)).rejects.toThrow(
					"upstream_unavailable",
				);
			else {
				provider = await startBrowserProvider(options);
				expect(provider.handlers.has("browser.navigate_page")).toBe(true);
				expect(existsSync(join(worker.input.input.qaRoot, "profile"))).toBe(
					true,
				);
				const response = await fetch(`http://127.0.0.1:${provider.proxyPort}/`);
				expect(response.status).toBe(403);
				await provider.close();
				await provider.close();
				await expect(
					fetch(`http://127.0.0.1:${provider.proxyPort}/`),
				).rejects.toThrow();
			}
			expect(verifyBrowserIsolation).toHaveBeenCalledWith(
				{ policy: "test-policy" },
				{ proxyPort: worker.input.input.proxyPort },
			);
			expect(worker.input.expectedUpstreamSchemaDigest).toBe(
				BROWSER_UPSTREAM_SCHEMA_DIGEST,
			);
			expect(revokeQaIdentity).toHaveBeenCalledOnce();
			expect(worker.close).toHaveBeenCalledOnce();
			expect(existsSync(worker.input.input.qaRoot)).toBe(false);
			expect(existsSync(qaParentRoot)).toBe(true);
			store.close();
		} finally {
			await provider?.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
