import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	CodexCandidateWorkspace,
	probeCodexCandidate,
	sanitizedCodexEnvironment,
} from "../probe.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(body: string) {
	const root = await mkdtemp(join(tmpdir(), "quota-test-"));
	roots.push(root);
	const bin = join(root, "codex");
	await writeFile(bin, `#!${process.execPath}\n${body}`, { mode: 0o700 });
	return { root, bin };
}
const identify = (bytes: string) => ({
	accountKey: JSON.parse(bytes).account,
	profile: "school",
});
it("accepts only result-file ok and matching final identity; retains refreshed bytes", async () => {
	const { root, bin } = await fixture(
		`const fs=require('fs');fs.writeFileSync(process.env.CODEX_HOME+'/auth.json',JSON.stringify({account:'school',refresh:'new'}));fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');`,
	);
	const pool = new CodexCandidateWorkspace(root, { profilesRoot: root });
	await pool.run("school", '{"account":"school"}', async (workspace) => {
		const result = await probeCodexCandidate({
			workspace,
			binary: bin,
			model: "test-model",
			profile: "school",
			accountKey: "school",
			identify,
		});
		expect(result.ok).toBe(true);
		expect(JSON.parse(await readFile(workspace.authPath, "utf8")).refresh).toBe(
			"new",
		);
		expect((await stat(workspace.authPath)).mode & 0o777).toBe(0o600);
	});
});
it("rejects stdout ok, nonzero exit, tools, and changed identity", async () => {
	for (const body of [
		`console.log('ok')`,
		`require('fs').writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');process.exit(1)`,
		`require('fs').writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}}))`,
		`require('fs').writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');require('fs').writeFileSync(process.env.CODEX_HOME+'/auth.json','{"account":"other"}')`,
	]) {
		const { root, bin } = await fixture(body);
		await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
			"school",
			'{"account":"school"}',
			async (workspace) =>
				expect(
					(
						await probeCodexCandidate({
							workspace,
							binary: bin,
							model: "test",
							accountKey: "school",
							profile: "school",
							identify,
						})
					).ok,
				).toBe(false),
		);
	}
});
it("serializes same account even across managers, retaining credentials on thrown callback", async () => {
	const { root } = await fixture("");
	const pool = new CodexCandidateWorkspace(root, { profilesRoot: root });
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	const order: string[] = [];
	const first = pool
		.run("school", "{}", async (w) => {
			order.push("first");
			await writeFile(w.authPath, "refreshed");
			await wait;
			throw new Error("abort");
		})
		.catch(() => {});
	await new Promise((r) => setTimeout(r, 10));
	const second = new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
		"school",
		"{}",
		async () => {
			order.push("second");
		},
	);
	await new Promise((r) => setTimeout(r, 10));
	expect(order).toEqual(["first"]);
	release();
	await first;
	await expect(second).rejects.toThrow("codex_candidate_recovery_required");
	expect(order).toEqual(["first"]);
});
it("drops credential/provider injection and isolates all home/config state", () => {
	const env = sanitizedCodexEnvironment("/isolated", {
		PATH: "/bin",
		HOME: "/real",
		OPENAI_API_KEY: "secret",
		OPENAI_BASE_URL: "bad",
		CODEX_HOME: "/real",
		NODE_OPTIONS: "bad",
		SSL_CERT_FILE: "/ca",
	});
	expect(env).toEqual({
		PATH: "/bin",
		HOME: "/isolated",
		CODEX_HOME: "/isolated",
		XDG_CONFIG_HOME: "/isolated/config",
		XDG_DATA_HOME: "/isolated/data",
		XDG_CACHE_HOME: "/isolated/cache",
		SSL_CERT_FILE: "/ca",
	});
});

it("reader initializes, verifies account before reading correct limit bucket, preserves refresh", async () => {
	const { readCodexQuota } = await import("../quota-reader.js");
	const { root, bin } = await fixture(
		`const fs=require('fs'); const rl=require('readline').createInterface({input:process.stdin});let initialized=false;rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized'){initialized=true;return;} let result={};if(m.method==='account/read'){if(!initialized)process.exit(2);result={account:{email:'school@test.example'}};}if(m.method==='account/rateLimits/read'){result={rateLimitsByLimitId:{codex:{primary:{usedPercent:30,resetsAt:1800000100},secondary:null}}};fs.writeFileSync(process.env.CODEX_HOME+'/auth.json','{"account":"school","refresh":"new"}');} console.log(JSON.stringify({id:m.id,result}));});`,
	);
	await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
		"school",
		'{"account":"school"}',
		async (workspace) => {
			const result = await readCodexQuota({
				workspace,
				binary: bin,
				profile: "school",
				accountKey: "school",
				identify,
				accountMatches: (a) =>
					(a as { email?: string })?.email === "school@test.example",
				limitId: "codex",
				now: () => 1_800_000_000_000,
			});
			expect(result.observation.windows).toEqual([
				{ usedPercent: 30, resetsAt: 1_800_000_100_000 },
			]);
			expect(result.observation.identityVerified).toBe(true);
			expect(result.reason).toBe("ok");
			expect(
				JSON.parse(await readFile(workspace.authPath, "utf8")).refresh,
			).toBe("new");
		},
	);
});
it("reader rejects generic 429 as quota and marks only explicit invalid refresh as invalid", async () => {
	const { readCodexQuota } = await import("../quota-reader.js");
	for (const [code, health] of [
		["rateLimitExceeded", "unknown"],
		["invalid_grant", "refresh_invalid"],
	]) {
		const { root, bin } = await fixture(
			`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,error:{code:${JSON.stringify(code)}}}));});`,
		);
		await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
			"school",
			'{"account":"school"}',
			async (workspace) => {
				const result = await readCodexQuota({
					workspace,
					binary: bin,
					profile: "school",
					accountKey: "school",
					identify,
					accountMatches: () => true,
					limitId: "codex",
					now: () => 1_800_000_000_000,
				});
				expect(result.observation.authHealth).toBe(health);
				expect(result.observation.reached).not.toBe(true);
				expect(result.reason).not.toBe("ok");
			},
		);
	}
});
it("rejects structured tool calls outside item envelopes even with final ok", async () => {
	const { root, bin } = await fixture(
		`require('fs').writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');console.log(JSON.stringify({type:'tool_call',name:'shell'}));`,
	);
	await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
		"school",
		'{"account":"school"}',
		async (workspace) =>
			expect(
				(
					await probeCodexCandidate({
						workspace,
						binary: bin,
						model: "test",
						profile: "school",
						accountKey: "school",
						identify,
					})
				).ok,
			).toBe(false),
	);
});
it("recognizes explicit refresh invalidation inside JSON-RPC numeric error, without treating generic429 as quota", async () => {
	const { readCodexQuota } = await import("../quota-reader.js");
	const { root, bin } = await fixture(
		`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,error:{code:-32000,message:'Token refresh failed: invalid_grant'}}));});`,
	);
	await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
		"school",
		'{"account":"school"}',
		async (workspace) => {
			expect(
				(
					await readCodexQuota({
						workspace,
						binary: bin,
						profile: "school",
						accountKey: "school",
						identify,
						accountMatches: () => true,
						limitId: "codex",
					})
				).observation.authHealth,
			).toBe("refresh_invalid");
		},
	);
});
it("abort after token refresh keeps sole refreshed credential recoverable after callback throws", async () => {
	const { root, bin } = await fixture(
		`require('fs').writeFileSync(process.env.CODEX_HOME+'/auth.json','{"account":"school","refresh":"new"}');setInterval(()=>{},1000);`,
	);
	let retained = "";
	const abort = new AbortController();
	await expect(
		new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
			"school",
			'{"account":"school"}',
			async (workspace) => {
				retained = workspace.authPath;
				const pending = probeCodexCandidate({
					workspace,
					binary: bin,
					model: "test",
					profile: "school",
					accountKey: "school",
					identify,
					signal: abort.signal,
				});
				for (let i = 0; i < 1000; i++) {
					if ((await readFile(retained, "utf8")).includes("new")) break;
					await new Promise((r) => setTimeout(r, 5));
				}
				abort.abort();
				expect((await pending).ok).toBe(false);
				throw new Error("install-aborted");
			},
		),
	).rejects.toThrow("install-aborted");
	expect(JSON.parse(await readFile(retained, "utf8")).refresh).toBe("new");
});
it("bounds retained process output even when child floods stdout after stop", async () => {
	const { runIsolatedCodex } = await import("../probe.js");
	const { root, bin } = await fixture(
		`process.on('SIGTERM',()=>{});process.stdout.write('x\\n'.repeat(512*1024));setInterval(()=>{},1000);`,
	);
	await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
		"school",
		"{}",
		async (workspace) => {
			const result = await runIsolatedCodex({
				workspace,
				binary: bin,
				args: [],
				timeoutMs: 1000,
			});
			expect(result.failed).toBe(true);
			expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(262144);
		},
	);
});
it("blocks another refresh until retained orphan credentials are reconciled", async () => {
	const { root } = await fixture("");
	const pool = new CodexCandidateWorkspace(root, { profilesRoot: root });
	await expect(
		pool.run("orphan", "old", async (workspace) => {
			await writeFile(workspace.authPath, "refreshed");
			throw new Error("abort");
		}),
	).rejects.toThrow("abort");
	let copied = false;
	await expect(
		pool.run(
			"orphan",
			async () => {
				copied = true;
				return "old";
			},
			async () => {},
		),
	).rejects.toThrow("codex_candidate_recovery_required");
	expect(copied).toBe(false);
});
it("composes network reader failures as observation_unavailable rather than bad credentials", async () => {
	const { readCodexQuota } = await import("../quota-reader.js");
	const { selectCodexQuotaCandidate } = await import(
		"../candidate-selector.js"
	);
	const { root, bin } = await fixture(
		`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,error:{code:-32000,message:'network unavailable'}}));});`,
	);
	const observations: import("../candidate-selector.js").CodexQuotaObservation[] =
		[];
	for (const profile of ["school", "personal", "business"])
		await new CodexCandidateWorkspace(root, { profilesRoot: root }).run(
			profile,
			JSON.stringify({ account: profile }),
			async (workspace) => {
				observations.push(
					(
						await readCodexQuota({
							workspace,
							binary: bin,
							profile,
							accountKey: profile,
							identify: (raw) => ({
								profile: JSON.parse(raw).account,
								accountKey: JSON.parse(raw).account,
							}),
							accountMatches: () => true,
							limitId: "codex",
							now: () => 1800000000000,
						})
					).observation,
				);
			},
		);
	expect(
		selectCodexQuotaCandidate(observations, { now: 1800000000000 }).kind,
	).toBe("observation_unavailable");
});
it("releases orphan gate only after matching retained bytes were persisted elsewhere", async () => {
	const { acquireCodexAccountLease, resolveCodexCandidateRecovery } =
		await import("flywheel-claude-runner/bin/codex-account-install.mjs");
	const { root } = await fixture("");
	const pool = new CodexCandidateWorkspace(root, { profilesRoot: root });
	const persisted = join(root, "profile-auth");
	await writeFile(persisted, "old");
	await expect(
		pool.run("orphan", "old", async (workspace) => {
			await writeFile(workspace.authPath, "refreshed");
			throw new Error("abort");
		}),
	).rejects.toThrow("abort");
	const lease = acquireCodexAccountLease(root, "orphan");
	try {
		expect(lease.orphanRecovery?.authPath).toBeTruthy();
		expect(() => resolveCodexCandidateRecovery(lease, persisted)).toThrow(
			"codex_candidate_recovery_digest_mismatch",
		);
		await writeFile(persisted, "refreshed");
		resolveCodexCandidateRecovery(lease, persisted);
		expect(lease.orphanRecovery).toBeNull();
	} finally {
		lease.release();
	}
	await pool.run(
		"orphan",
		() => readFile(persisted, "utf8"),
		async (workspace) => {
			expect(await readFile(workspace.authPath, "utf8")).toBe("refreshed");
			await workspace.discardAfterCredentialPersistence(persisted);
		},
	);
});
