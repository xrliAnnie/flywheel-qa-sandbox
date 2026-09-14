import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const oauthSchema = z.object({
	accessToken: z.string().min(1).max(16384),
	refreshToken: z.string().min(1).max(16384).optional(),
	expiresAt: z.number().finite().optional(),
	scopes: z.array(z.string().max(200)).max(100).optional(),
	subscriptionType: z.string().max(200).nullable().optional(),
	rateLimitTier: z.string().max(200).nullable().optional(),
});
const decode = (raw: string) => ({
	claudeAiOauth: oauthSchema.parse(JSON.parse(raw).claudeAiOauth),
});

/** Read authentication only; never copy settings or write back to the source/keychain. */
export async function subscriptionAuthentication(
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
) {
	if (env.CLAUDE_CODE_OAUTH_TOKEN)
		return {
			claudeAiOauth: oauthSchema.parse({
				accessToken: env.CLAUDE_CODE_OAUTH_TOKEN,
			}),
		};
	const home = env.HOME ?? homedir();
	const config = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
	try {
		const file = await open(
			join(config, ".credentials.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 65536)
				throw new Error("credential_invalid");
			const bytes = Buffer.alloc(65537);
			let bytesRead = 0;
			while (bytesRead < bytes.length) {
				const read = await file.read(
					bytes,
					bytesRead,
					bytes.length - bytesRead,
					bytesRead,
				);
				if (read.bytesRead === 0) break;
				bytesRead += read.bytesRead;
			}
			if (bytesRead > 65536) throw new Error("credential_invalid");
			return decode(bytes.subarray(0, bytesRead).toString("utf8"));
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("credential_invalid");
	}
	// A custom source must supply its own auth; never silently substitute the default account.
	if (
		process.platform !== "darwin" ||
		resolve(config) !== resolve(homedir(), ".claude") ||
		resolve(home) !== resolve(homedir())
	)
		return null;
	try {
		const { stdout } = await promisify(execFile)(
			"/usr/bin/security",
			[
				"find-generic-password",
				"-a",
				env.USER ?? env.LOGNAME ?? "",
				"-s",
				"Claude Code-credentials",
				"-w",
			],
			{ timeout: 5000, maxBuffer: 65536, signal },
		);
		return decode(stdout);
	} catch {
		return null;
	}
}
