import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	planFableAuthorityUpdate,
	selectLatestFableModel,
	syncFableModelAuthority,
} from "../account-heal/fable-model-sync.js";

describe("Fable model authority sync", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("selects the greatest exact numeric base id rather than response order", () => {
		expect(
			selectLatestFableModel({
				data: [
					{ id: "claude-fable-5-9", max_input_tokens: 200_000 },
					{ id: "claude-fable-5-10[1m]", max_input_tokens: 1_000_000 },
					{ id: "claude-fable-5-10-preview", max_input_tokens: 1_000_000 },
					{ id: "claude-fable-5", max_input_tokens: 1_000_000 },
					{ id: "claude-fable-5-10", max_input_tokens: 1_000_000 },
				],
			}),
		).toEqual({
			id: "claude-fable-5-10",
			versionSegments: [5, 10],
			maxInputTokens: 1_000_000,
		});
	});

	it("updates only managed authority keys and derives the synthetic 1M entry independently", () => {
		const authority = {
			version: 1,
			models: [
				{
					id: "claude-fable-5-1",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Fable 5.1 founder entry",
					aliases: ["fable-5-1"],
					dispatch: true,
					founderNote: "preserve-me",
				},
				{
					id: "claude-unrelated",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Unrelated",
					aliases: [],
				},
			],
			bindings: { opus: "claude-opus-5" },
			tiers: {
				heavy: "claude-fable-5-1",
				medium: "claude-opus-5",
				light: "claude-opus-5",
				trivial: "claude-opus-5",
			},
			phases: { qa: { vendor: "claude", model: "claude-opus-5" } },
			founderExtension: { keep: true },
		};

		const result = planFableAuthorityUpdate(authority, "claude-fable-5-1", {
			id: "claude-fable-5-2",
			versionSegments: [5, 2],
			maxInputTokens: 1_000_000,
		});

		expect(result.status).toBe("updated");
		expect(result.authority.bindings).toEqual({
			opus: "claude-opus-5",
			fable: "claude-fable-5-2",
		});
		expect(result.authority.tiers).toEqual({
			heavy: "fable",
			medium: "claude-opus-5",
			light: "claude-opus-5",
			trivial: "claude-opus-5",
		});
		expect(result.authority.phases).toEqual(authority.phases);
		expect(result.authority.founderExtension).toEqual(
			authority.founderExtension,
		);
		expect(result.authority.models.slice(0, 2)).toEqual(authority.models);
		expect(result.authority.models.at(-2)).toMatchObject({
			id: "claude-fable-5-2",
			aliases: ["fable-5-2"],
			dispatch: true,
			maxInputTokens: 1_000_000,
		});
		expect(result.authority.models.at(-2)).not.toHaveProperty(
			"contextWindowTokens",
		);
		expect(result.authority.models.at(-1)).toMatchObject({
			id: "claude-fable-5-2[1m]",
			aliases: ["fable-5-2-1m"],
			dispatch: true,
			maxInputTokens: 1_000_000,
			contextWindowTokens: 1_000_000,
		});
	});

	it("preserves an explicit non-Fable heavy tier while advancing the family binding", () => {
		const result = planFableAuthorityUpdate(
			{
				version: 1,
				models: [],
				bindings: {},
				tiers: { heavy: "claude-opus-5", medium: "claude-opus-5" },
			},
			"claude-fable-5-1",
			{
				id: "claude-fable-5-2",
				versionSegments: [5, 2],
				maxInputTokens: 1_000_000,
			},
		);

		expect(result.status).toBe("updated");
		expect(result.authority.bindings.fable).toBe("claude-fable-5-2");
		expect(result.authority.tiers).toEqual({
			heavy: "claude-opus-5",
			medium: "claude-opus-5",
		});
	});

	it("does not roll back a family update because a preserved heavy tier is non-dispatch or stale", async () => {
		for (const heavy of ["claude-sonnet-4-6", "claude-retired-model"]) {
			const root = mkdtempSync(join(tmpdir(), "fable-sync-heavy-"));
			roots.push(root);
			const authorityPath = join(root, "models.json");
			writeFileSync(
				authorityPath,
				`${JSON.stringify({
					version: 1,
					models: [],
					bindings: { fable: "claude-fable-5-1" },
					tiers: { heavy },
				})}\n`,
				{ mode: 0o600 },
			);

			const result = await syncFableModelAuthority({
				authorityPath,
				readCredential: async () => ({
					accessToken: "secret",
					expiresAt: Date.now() + 60_000,
				}),
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							data: [
								{
									id: "claude-fable-5-2",
									max_input_tokens: 1_000_000,
								},
							],
						}),
						{ status: 200 },
					),
			});

			expect(result).toMatchObject({
				status: "updated",
				canonical: "claude-fable-5-2",
			});
			const persisted = JSON.parse(readFileSync(authorityPath, "utf8"));
			expect(persisted.bindings.fable).toBe("claude-fable-5-2");
			expect(persisted.tiers.heavy).toBe(heavy);
		}
	});

	it("atomically updates and verifies a real authority file without leaking credentials", async () => {
		const root = mkdtempSync(join(tmpdir(), "fable-sync-"));
		roots.push(root);
		const authorityPath = join(root, "models.json");
		writeFileSync(
			authorityPath,
			`${JSON.stringify(
				{
					version: 1,
					models: [
						{
							id: "claude-fable-5-1",
							provider: "anthropic",
							runtimeVendor: "claude",
							label: "Fable 5.1",
							aliases: ["fable-5-1"],
							dispatch: true,
						},
						{
							id: "claude-fable-5-1[1m]",
							provider: "anthropic",
							runtimeVendor: "claude",
							label: "Fable 5.1 (1M)",
							aliases: ["fable-5-1-1m"],
							dispatch: true,
						},
					],
					bindings: { opus: "claude-opus-5" },
					tiers: { heavy: "claude-fable-5-1", medium: "claude-opus-5" },
					phases: { qa: { model: "claude-opus-5" } },
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);

		const result = await syncFableModelAuthority({
			authorityPath,
			readCredential: async () => ({
				accessToken: "top-secret-token",
				expiresAt: Date.now() + 60_000,
			}),
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-fable-5-2",
								max_input_tokens: 1_000_000,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		});

		expect(result).toMatchObject({
			status: "updated",
			previousCanonical: "claude-fable-5-1",
			canonical: "claude-fable-5-2",
		});
		expect(JSON.stringify(result)).not.toContain("top-secret-token");
		const persisted = JSON.parse(readFileSync(authorityPath, "utf8"));
		expect(persisted.bindings).toEqual({
			opus: "claude-opus-5",
			fable: "claude-fable-5-2",
		});
		expect(persisted.phases).toEqual({ qa: { model: "claude-opus-5" } });
		expect(readFileSync(authorityPath, "utf8")).not.toContain(
			"top-secret-token",
		);
		expect(statSync(authorityPath).mode & 0o777).toBe(0o600);
	});

	it("retains the exact authority bytes when the atomic replace fails before rename", async () => {
		const root = mkdtempSync(join(tmpdir(), "fable-sync-fail-"));
		roots.push(root);
		const authorityPath = join(root, "models.json");
		const original = `${JSON.stringify({
			version: 1,
			models: [
				{
					id: "claude-fable-5-1",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Fable 5.1",
					aliases: ["fable-5-1"],
					dispatch: true,
				},
				{
					id: "claude-fable-5-1[1m]",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Fable 5.1 (1M)",
					aliases: ["fable-5-1-1m"],
					dispatch: true,
				},
			],
			bindings: {},
			tiers: { heavy: "claude-fable-5-1" },
		})}\n`;
		writeFileSync(authorityPath, original, { mode: 0o600 });

		const result = await syncFableModelAuthority({
			authorityPath,
			readCredential: async () => ({
				accessToken: "secret",
				expiresAt: Date.now() + 60_000,
			}),
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-fable-5-2",
								max_input_tokens: 1_000_000,
							},
						],
					}),
					{ status: 200 },
				),
			beforeRename: () => {
				throw new Error("injected before rename");
			},
		});

		expect(result).toMatchObject({
			status: "retained",
			reason: "write_failed",
		});
		expect(readFileSync(authorityPath, "utf8")).toBe(original);
	});

	it("restores the previous authority when post-write registry verification fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "fable-sync-verify-"));
		roots.push(root);
		const authorityPath = join(root, "models.json");
		const original = `${JSON.stringify({
			version: 1,
			models: [
				{
					id: "claude-fable-5-1",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Fable 5.1",
					aliases: ["fable-5-1"],
					dispatch: true,
				},
				{
					id: "claude-fable-5-1[1m]",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Fable 5.1 (1M)",
					aliases: ["fable-5-1-1m"],
					dispatch: true,
				},
			],
			bindings: {},
			tiers: { heavy: "claude-fable-5-1" },
		})}\n`;
		writeFileSync(authorityPath, original, { mode: 0o600 });

		const result = await syncFableModelAuthority({
			authorityPath,
			readCredential: async () => ({
				accessToken: "secret",
				expiresAt: Date.now() + 60_000,
			}),
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-fable-5-2",
								max_input_tokens: 1_000_000,
							},
						],
					}),
					{ status: 200 },
				),
			afterWrite: (path) => {
				writeFileSync(path, '{"version":1}\n', { mode: 0o600 });
			},
		});

		expect(result).toMatchObject({
			status: "retained",
			reason: "verification_failed",
		});
		expect(readFileSync(authorityPath, "utf8")).toBe(original);
	});

	it("retains the authority when credential access throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "fable-sync-credential-"));
		roots.push(root);
		const authorityPath = join(root, "models.json");
		const original = `${JSON.stringify({
			version: 1,
			models: [],
			bindings: {},
			tiers: {},
		})}\n`;
		writeFileSync(authorityPath, original, { mode: 0o600 });

		const result = await syncFableModelAuthority({
			authorityPath,
			readCredential: async () => {
				throw new Error("Keychain unavailable");
			},
		});

		expect(result).toMatchObject({
			status: "retained",
			reason: "credential_unavailable",
		});
		expect(readFileSync(authorityPath, "utf8")).toBe(original);
	});
});
