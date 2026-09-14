import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { subscriptionAuthentication } from "../subscription-auth.js";

it("imports only OAuth fields and rejects malformed, oversized or linked credential files", async () => {
	const root = await mkdtemp(join(tmpdir(), "judgment-auth-"));
	const env = { HOME: root, CLAUDE_CONFIG_DIR: root };
	const path = join(root, ".credentials.json");
	try {
		expect(await subscriptionAuthentication(env)).toBeNull();
		await writeFile(
			path,
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "fixture",
					settings: { language: "chinese" },
				},
				env: { POISON: "yes" },
			}),
		);
		expect(await subscriptionAuthentication(env)).toEqual({
			claudeAiOauth: { accessToken: "fixture" },
		});
		for (const input of [
			"secret malformed credential",
			"x".repeat(65537),
			JSON.stringify({ claudeAiOauth: { accessToken: 123 } }),
		]) {
			await writeFile(path, input);
			await expect(subscriptionAuthentication(env)).rejects.toThrow(
				"credential_invalid",
			);
		}
		await rm(path);
		await writeFile(
			join(root, "target"),
			JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } }),
		);
		await symlink(join(root, "target"), path);
		await expect(subscriptionAuthentication(env)).rejects.toThrow(
			"credential_invalid",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
