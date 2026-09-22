import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { aggregateJudgment } from "../contract.js";
import { buildEvidenceLedger } from "../evidence-ledger.js";
import { GithubProjectApi } from "../github-api.js";
import { prepareJudgmentGit } from "../prepare-git.js";
import { collectProductionJudgment } from "../production-collect.js";
import {
	ProjectRefreshStore,
	SharedProjectRefresh,
} from "../project-refresh.js";
import { renderJudgmentMessage } from "../render.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";
import { evidenceMaterials } from "./evidence-fixture.js";

it.each([false, true])(
	"collects real Git materials with 42 PRs, 370/289-file PRs, and a hard 120-request budget (inventory fails=%s)",
	async (inventoryFails) => {
		const root = mkdtempSync(join(tmpdir(), "fly-2560-scale-"));
		const { store, db } = await bindingFixture();
		let refresh: SharedProjectRefresh | undefined;
		try {
			const git = (...args: string[]) =>
				execFileSync(
					"git",
					[
						"-C",
						root,
						"-c",
						"user.name=Fixture",
						"-c",
						"user.email=fixture@example.test",
						"-c",
						"commit.gpgsign=false",
						...args,
					],
					{
						encoding: "utf8",
						env: {
							PATH: process.env.PATH,
							GIT_CONFIG_GLOBAL: "/dev/null",
							GIT_CONFIG_NOSYSTEM: "1",
						},
					},
				).trim();
			git("init", "--initial-branch=main", "--template=");
			mkdirSync(join(root, "engineering/doc"), { recursive: true });
			writeFileSync(join(root, "engineering/doc/plan.md"), "approved plan\n");
			writeFileSync(join(root, "fix.ts"), "before\n");
			git("add", ".");
			git("commit", "-m", "base");
			const base = git("rev-parse", "HEAD");
			git("switch", "-c", "feature");
			writeFileSync(join(root, "fix.ts"), "after\n");
			git("add", ".");
			git("commit", "-m", "fix");
			const head = git("rev-parse", "HEAD");
			const planBlobSha = git("rev-parse", `${head}:engineering/doc/plan.md`);
			const binding = { ...store.readShipJudgmentBinding("q", CHANNEL)! };
			binding.targets = binding.targets.map((target) => ({
				...target,
				head_sha: head,
			}));
			vi.spyOn(store, "readShipJudgmentBinding").mockReturnValue(binding);
			const material = evidenceMaterials(binding, NOW).targets[0]!;
			material.designApproval!.expectedBlobSha = planBlobSha;
			const qaToken = "a".repeat(32);
			material.qaAuthority!.summary = `QA report: https://reports.vercel.app/r/${qaToken}/`;
			vi.spyOn(store, "readShipJudgmentDesignApproval").mockReturnValue(
				material.designApproval,
			);
			vi.spyOn(store, "readShipJudgmentCodeReviewAtHead").mockReturnValue(
				material.codeReview,
			);
			vi.spyOn(store, "readShipJudgmentQaAuthority").mockReturnValue(
				material.qaAuthority!,
			);
			const numbers = [...Array.from({ length: 41 }, (_, i) => i + 1), 2399];
			const count = (n: number) =>
				n === 1 ? 370 : n === 2 ? 289 : n === 2399 ? 1 : 21;
			const pr = (number: number) => ({
				number,
				head: { sha: head },
				base: { ref: "main", sha: base },
				draft: false,
				state: "open",
				changed_files: count(number),
			});
			const requests: string[] = [];
			let planReady!: () => void;
			const planRead = new Promise<void>((resolve) => {
				planReady = resolve;
			});
			const fetcher = async (url: string) => {
				requests.push(url);
				expect(requests.length).toBeLessThanOrEqual(120);
				const u = new URL(url),
					page = Number(u.searchParams.get("page") ?? 1),
					size = Number(u.searchParams.get("per_page") ?? 20);
				if (u.pathname.endsWith("/git/ref/heads/main"))
					return Response.json({ object: { sha: base } });
				const pageResponse = (items: unknown[], total: number) =>
					Response.json(items, {
						headers:
							page * size < total
								? {
										Link: `<${u.origin}${u.pathname}?${u.pathname.endsWith("/pulls") ? "state=open&" : ""}per_page=${size}&page=${page + 1}>; rel="next"`,
									}
								: {},
					});
				if (u.pathname.endsWith("/pulls"))
					return pageResponse(
						numbers.slice((page - 1) * size, page * size).map(pr),
						numbers.length,
					);
				const n = Number(u.pathname.match(/\/pulls\/(\d+)/)?.[1]);
				if (u.pathname.endsWith("/files")) {
					// Git diff and plan must be available without waiting for successful inventory refresh.
					await planRead;
					if (inventoryFails)
						return new Response("", {
							status: 429,
							headers: { "retry-after": "60" },
						});
					const files = Array.from({ length: count(n) }, (_, i) => ({
						filename: n === 2399 ? "fix.ts" : `other/${n}/${i}.ts`,
					}));
					return pageResponse(
						files.slice((page - 1) * size, page * size),
						files.length,
					);
				}
				return Response.json(pr(n));
			};
			const cache = new ProjectRefreshStore(db);
			let now = Date.parse(NOW);
			refresh = new SharedProjectRefresh(
				cache,
				new GithubProjectApi(
					["owner/repo"],
					() => "fixture",
					fetcher,
					() => now,
				),
				() => now,
			);
			const repositories = [
				{ repo_identity: "__main__", repo_slug: "owner/repo" },
			];
			const result = await collectProductionJudgment(
				"q",
				CHANNEL,
				{
					source: {
						store,
						linearApiKey: "fixture",
						planRepoIdentity: "__main__",
						registry: { readReportHtml: () => "<h1>QA passed</h1>" },
						hosting: { vercelProjectName: "reports" },
					},
					repositories,
					refresh,
					currentSnapshot: () => cache.read(now),
					mergeCache: cache,
					token: async () => "fixture",
					now: () => now,
					prepare: async (request, deps, signal) => {
						const prepared = await prepareJudgmentGit(
							request,
							{
								...deps,
								command: async (command) => {
									const args = command.args.map((arg) =>
										arg === "https://github.com/owner/repo.git" ? root : arg,
									);
									const { stdout } = await promisify(execFile)(
										"git",
										["-c", "protocol.file.allow=always", ...args],
										{
											encoding: "utf8",
											env: command.env,
											signal: command.signal,
										},
									);
									return stdout;
								},
							},
							signal,
						);
						const reader = prepared.material.reader;
						prepared.material.reader = (abort) => {
							const original = reader(abort);
							return {
								diff: (base, head) => original.diff(base, head),
								listTextFiles: (head) => original.listTextFiles(head),
								readText: async (head, path) => {
									const blob = await original.readText(head, path);
									planReady();
									return blob;
								},
							};
						};
						return prepared;
					},
					collect: async () => ({
						status: "undetermined",
						reason: "semantic_not_required",
					}),
				},
				new AbortController().signal,
			);
			const ledger = buildEvidenceLedger(result.materials, binding, {
				status: "evaluated",
				evaluationId: "production-scale-evaluation",
				modelSnapshotDigest: "f".repeat(64),
				alignment: "pass",
				coverage: "pass",
			});
			expect(result.materials.targets[0]?.diff?.files).toEqual([
				{ path: "fix.ts", status: "M" },
			]);
			expect(result.materials.targets[0]?.planBlob?.text).toContain(
				"approved plan",
			);
			expect(ledger.targets[0]).toMatchObject({
				a: {
					verdict: inventoryFails ? "undetermined" : "pass",
					missing: inventoryFails ? ["input"] : [],
				},
				c: {
					verdict: inventoryFails ? "undetermined" : "pass",
					missing: inventoryFails ? ["input"] : [],
				},
			});
			expect(ledger.alignment.verdict).toBe(
				inventoryFails ? "undetermined" : "pass",
			);
			expect(ledger.coverage.verdict).toBe(
				inventoryFails ? "undetermined" : "pass",
			);
			expect(ledger.conflict.verdict).toBe(
				inventoryFails ? "undetermined" : "pass",
			);
			const message = renderJudgmentMessage({
				opinionId: "fixture",
				questionId: "q",
				threadId: binding.threadId,
				cardMessageId: binding.cardMessageId,
				marker: "ship-judgment:q",
				mode: "dry_run",
				overall: aggregateJudgment(
					ledger.alignment.verdict,
					ledger.conflict.verdict,
					ledger.coverage.verdict,
				),
				alignment: ledger.alignment.verdict,
				conflict: ledger.conflict.verdict,
				coverage: ledger.coverage.verdict,
				mechanical: result.mechanical,
				evidence: ledger,
				evaluation: null,
			});
			expect(message).not.toContain("0 仓");
			if (inventoryFails) {
				expect(ledger.input.status).toBe("unavailable");
				expect(message).toContain("② 合并与在飞文件：缺 机械快照");
			} else {
				expect(message).toContain("三点均通过");
				expect(message).toContain("仅展示，等你决定");
				expect(cache.read(now)?.prs).toHaveLength(42);
				expect(cache.read(now)?.prs[0]?.files).toHaveLength(370);
				expect(requests).toHaveLength(93);
				now += 60_001;
				const before = requests.length;
				expect(
					(await refresh.refresh({ projectName: "flywheel", repositories }))
						.status,
				).toBe("ready");
				// Validated files AND identity reads are cached for unchanged heads.
				expect(requests.length - before).toBe(4);
				expect(requests.length).toBeLessThanOrEqual(120);
			}
		} finally {
			await refresh?.stop();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
