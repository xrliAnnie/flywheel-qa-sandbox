// FLY-1062 PR2 · `license set` — hidden-read a new key, validate it against the
// manifest endpoint, atomically 0600-overwrite .env, then continue the normal
// install flow (rotation must not be blocked by the second-run fast path —
// Codex R4#1).
import { execFileSync } from "node:child_process";
import { fetchManifest } from "./endpoint.mjs";
import { hiddenPrompt, persistKey } from "./key.mjs";
import { MSG } from "./messages.mjs";
import { messageFor, runOnboard } from "./onboard.mjs";

export async function runLicenseSet(
	cfg,
	{
		io,
		exec = execFileSync,
		fetchImpl = fetch,
		promptFn = hiddenPrompt,
		env = process.env,
	} = {},
) {
	io.out("请粘贴新的授权码(粘贴时不会显示):\n");
	const k = (
		(await promptFn(MSG.keyPromptHidden, {
			input: io.input,
			output: io.output,
		})) || ""
	).trim();
	if (!k) {
		io.err(MSG.keyInvalid);
		return 1;
	}
	// validate once against the manifest endpoint before persisting.
	try {
		await fetchManifest(cfg.endpoint, k, { fetchImpl });
	} catch (e) {
		io.err(messageFor(e));
		return 1;
	}
	persistKey(cfg.envFile, k);
	io.out("授权码已更新。\n");
	// continue the normal install flow with the freshly stored key.
	return runOnboard(cfg, { io, exec, fetchImpl, promptFn, env });
}
