import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const teamleadPackage = new URL("../../../package.json", import.meta.url);
const require = createRequire(teamleadPackage);
const guardUrl = new URL(
	"../linear-transport-rejection-guard.ts",
	import.meta.url,
);
const marker = "[Bridge] unhandledRejection source=process";

async function runChild(
	code: string,
	mode: "throw" | "strict" | "default" = "throw",
) {
	const result = await new Promise<{
		status: number | null;
		signal: NodeJS.Signals | null;
		error: Error | undefined;
		stdout: string;
		stderr: string;
	}>((resolve) => {
		execFile(
			process.execPath,
			[
				...(mode === "default" ? [] : [`--unhandled-rejections=${mode}`]),
				"--import",
				require.resolve("tsx"),
				"--input-type=module",
				"--eval",
				`
import { createRequire } from 'node:module';
// Also bound boot/import stalls, before the per-case liveness timer is installed.
setTimeout(() => { console.error('child boot deadline expired'); process.exit(2); }, 20_000).unref();

const require = createRequire(${JSON.stringify(teamleadPackage.href)});
// isomorphic-unfetch captures global fetch while the SDK loads. Never use the API.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('Fetch failed'); };
// Match the SDK instance used by the teamlead module, including nested payloads.
const sdk = require('@linear/sdk');
const { installLinearTransportRejectionGuard } = await import(${JSON.stringify(guardUrl.href)});
${code}
`,
			],
			{
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
				env: { ...process.env, NODE_OPTIONS: "" },
				encoding: "utf8",
				timeout: 30_000,
				// Fatal SDK stacks can include its minified source line.
				maxBuffer: 8 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				resolve({
					status: error
						? typeof error.code === "number"
							? error.code
							: null
						: 0,
					signal: error?.signal ?? null,
					error: error && typeof error.code !== "number" ? error : undefined,
					stdout,
					stderr,
				});
			},
		);
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

function rejectInChild(
	reason: string,
	mode: "throw" | "strict" | "default" = "throw",
) {
	return runChild(
		`
installLinearTransportRejectionGuard();
const reason = ${reason};
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.error('fatal-monitor:' + origin + ':same-error=' + (error === reason));
});
Promise.reject(reason);
setTimeout(() => { console.log('survived'); process.exit(0); }, 50);
`,
		mode,
	);
}

describe("Bridge promise rejection guard", { timeout: 35_000 }, () => {
	it.each([
		["SDK fetch failure", "sdk.parseLinearError(new Error('Fetch failed'))"],
		[
			"case-insensitive fetch failure",
			"new sdk.UnknownLinearError(new Error('fEtCh FaIlEd'))",
		],
		[
			"SDK network failure",
			"sdk.parseLinearError({ message: 'Bad gateway', response: { status: 502 } })",
		],
		[
			"network failure with empty GraphQL errors",
			"new sdk.NetworkLinearError({ response: { status: 503, errors: [] } }, [])",
		],
	])("survives %s through a timer", async (_label, reason) => {
		const result = await rejectInChild(reason);
		expect(result.status, result.stderr.slice(-3_000)).toBe(0);
		expect(result.stdout).toBe("survived\n");
		expect(result.stderr).toContain(marker);
		expect(result.stderr).toMatch(/\n\s+at /);
	});

	it("works with Node's default throw mode and the team's actual SDK fetch", async () => {
		const result = await runChild(
			`
installLinearTransportRejectionGuard();
const client = new sdk.LinearClient({ apiKey: 'test-key' });
void client.issue('test-issue');
setTimeout(() => {
  if (fetchCalls !== 1) throw new Error('SDK fetch was not exercised exactly once');
  console.log('survived'); process.exit(0);
}, 50);
`,
			"default",
		);
		expect(result.status, result.stderr.slice(-3_000)).toBe(0);
		expect(result.stdout).toBe("survived\n");
		expect(result.stderr).toContain(marker);
		expect(result.stderr).toMatch(/\n\s+at /);
	});

	it("logs no raw request, query, variables, credential, or payload", async () => {
		const result = await rejectInChild(`sdk.parseLinearError({
  message: 'SENSITIVE_MESSAGE',
  request: { query: 'SENSITIVE_QUERY', variables: { token: 'SENSITIVE_TOKEN' } },
  response: { status: 502, data: 'SENSITIVE_PAYLOAD' }
})`);
		expect(result.status, result.stderr.slice(-3_000)).toBe(0);
		expect(result.stderr).toContain(marker);
		expect(result.stderr).toMatch(/\n\s+at /);
		expect(`${result.stdout}${result.stderr}`).not.toContain("SENSITIVE_");
	});

	it.each([
		["ordinary fetch Error", "new Error('Fetch failed')"],
		[
			"abort rejection",
			"new DOMException('This operation was aborted', 'AbortError')",
		],
		[
			"SDK authentication failure",
			"new sdk.AuthenticationLinearError(new Error('Fetch failed'))",
		],
		[
			"SDK input failure",
			"new sdk.InvalidInputLinearError(new Error('Fetch failed'))",
		],
		["SDK unknown failure", "new sdk.UnknownLinearError(new Error('other'))"],
		[
			"SDK unknown failure with extra message text",
			"new sdk.UnknownLinearError(new Error('Fetch failed: unknown cause'))",
		],
		[
			"SDK unknown failure with plain raw object",
			"new sdk.UnknownLinearError({ message: 'Fetch failed' })",
		],
		[
			"SDK unknown failure with an HTTP response",
			"new sdk.UnknownLinearError(Object.assign(new Error('Fetch failed'), { response: { status: 200 } }))",
		],
		[
			"SDK unknown failure with an empty response",
			"new sdk.UnknownLinearError(Object.assign(new Error('Fetch failed'), { response: { errors: [] } }))",
		],
		[
			"SDK unknown failure with status",
			"Object.assign(new sdk.UnknownLinearError(new Error('Fetch failed')), { status: 502 })",
		],
		[
			"SDK GraphQL error",
			"sdk.parseLinearError({ response: { status: 502, errors: [{ message: 'invalid query', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] } })",
		],
		[
			"SDK network failure carrying GraphQL errors",
			"new sdk.NetworkLinearError(new Error('Fetch failed'), [new sdk.LinearGraphQLError({ message: 'invalid query' })])",
		],
		[
			"SDK network failure carrying raw GraphQL errors",
			"new sdk.NetworkLinearError({ response: { status: 502, errors: [{ message: 'invalid query' }] } }, [])",
		],
		[
			"SDK fetch failure carrying GraphQL errors",
			"new sdk.UnknownLinearError(new Error('Fetch failed'), [new sdk.LinearGraphQLError({ message: 'invalid query' })])",
		],
	])("logs and survives %s", async (_label, reason) => {
		const result = await rejectInChild(reason);
		expect(result.status, result.stderr.slice(-3_000)).toBe(0);
		expect(result.stdout).toBe("survived\n");
		expect(result.stderr).toContain(marker);
		expect(result.stderr).toMatch(/\n\s+at /);
	});

	it.each([
		"'Fetch failed'",
		"null",
		"{ message: 'Fetch failed' }",
		"Object.defineProperty(new Error(), 'stack', { get() { throw new Error('bad getter'); } })",
	])(
		"logs non-Error rejection %s with an observation stack and survives",
		async (reason) => {
			const result = await rejectInChild(reason);
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("survived\n");
			expect(result.stderr).toContain(marker);
			expect(result.stderr).toMatch(/\n\s+at /);
		},
	);

	it.each(["throw", "strict"] as const)(
		"leaves synchronous exceptions fatal in %s mode",
		async (mode) => {
			const result = await runChild(
				`
installLinearTransportRejectionGuard();
setTimeout(() => { throw sdk.parseLinearError(new Error('Fetch failed')); }, 0);
setTimeout(() => { console.log('survived'); process.exit(0); }, 50);
`,
				mode,
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Fetch failed");
			expect(result.stderr).not.toContain(marker);
		},
	);

	it.each([
		"sdk.parseLinearError(new Error('Fetch failed'))",
		"new Error('ordinary failure')",
		"null",
	])("also contains strict-mode rejection %s", async (reason) => {
		const result = await rejectInChild(reason, "strict");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("survived\n");
		expect(result.stderr).toContain(marker);
	});

	it.each(["timeout", "body_too_large"])(
		"owns record reader cancellation after %s without a process guard",
		async (outcome) => {
			const result = await runChild(`
const { probeRecord } = await import(${JSON.stringify(new URL("../strength-two-probes.ts", import.meta.url).href)});
const token = 'b'.repeat(32);
const outcome = ${JSON.stringify(outcome)};
let aborted = false;
let cancelled = false;
const result = await probeRecord({
  url: 'https://fw-reports-test.vercel.app/r/' + token + '/',
  vercelProjectName: 'fw-reports-test',
  registry: { list: () => [{ token, createdAt: new Date().toISOString() }], readReportHtml: () => 'proof' },
  timeoutMs: 20,
  maxBodyBytes: 4,
  fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      if (outcome === 'body_too_large') controller.enqueue(new Uint8Array(5));
      signal.addEventListener('abort', () => {
        aborted = true;
        controller.error(signal.reason);
      }, { once: true });
    },
    cancel() {
      cancelled = true;
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    },
  })),
});
if (result.outcome !== outcome) throw new Error('wrong probe result: ' + JSON.stringify(result));
if (outcome === 'timeout' ? !aborted : !cancelled) throw new Error('cleanup was not exercised');
setTimeout(() => { console.log('survived:' + result.outcome); process.exit(0); }, 50);
`);
			expect(result.status, result.stderr.slice(-3_000)).toBe(0);
			expect(result.stdout).toBe(`survived:${outcome}\n`);
			expect(result.stderr).toBe("");
		},
	);

	it("imports without global side effects and disposes only its listener", async () => {
		const result = await runChild(`
if (process.listenerCount('unhandledRejection') !== 0) throw new Error('import installed listener');
const existing = () => {};
const exceptionCount = process.listenerCount('uncaughtException');
process.on('unhandledRejection', existing);
const dispose = installLinearTransportRejectionGuard();
if (process.listenerCount('unhandledRejection') !== 2) throw new Error('missing guard');
if (process.listenerCount('uncaughtException') !== exceptionCount + 1) throw new Error('missing strict guard');
dispose();
dispose();
if (process.listenerCount('uncaughtException') !== exceptionCount) throw new Error('strict guard not disposed');
if (process.listenerCount('unhandledRejection') !== 1 || process.listeners('unhandledRejection')[0] !== existing) throw new Error('wrong listener disposed');
process.removeListener('unhandledRejection', existing);
console.log('disposed');
`);
		expect(result.status, result.stderr.slice(-3_000)).toBe(0);
		expect(result.stdout).toBe("disposed\n");
	});
});
