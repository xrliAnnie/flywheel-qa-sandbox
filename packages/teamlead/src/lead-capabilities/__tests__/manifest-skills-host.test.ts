import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { installManifestSkills } from "../manifest-skills.js";
import { NATIVE_CODEX_SKILL_NAMES } from "../native-skills.js";

const executable = join(homedir(), ".local/bin/codex");
it.skipIf(!existsSync(executable))(
	"discovers an installed adapter through the real isolated Codex skills API",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-host-"))),
			home = join(root, "home"),
			codexHome = join(root, "codex"),
			project = join(root, "project");
		for (const dir of [home, codexHome, project]) mkdirSync(dir);
		const env = { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome };
		const codexVersion = execFileSync(executable, ["--version"], {
			env,
			encoding: "utf8",
			timeout: 5000,
		}).trim();
		const child = spawn(executable, ["app-server"], {
			cwd: project,
			env,
			stdio: ["pipe", "pipe", "ignore"],
		});
		const lines = createInterface({ input: child.stdout });
		let id = 0,
			skills: ReturnType<typeof installManifestSkills> | undefined;
		const pending = new Map<
			number,
			{ resolve: (v: any) => void; reject: (e: Error) => void }
		>();
		lines.on("line", (line) => {
			if (line.length > 1024 * 1024) {
				child.kill();
				return;
			}
			const value = JSON.parse(line);
			const request = pending.get(value.id);
			if (request) {
				pending.delete(value.id);
				value.error
					? request.reject(new Error("rpc_error"))
					: request.resolve(value.result);
			}
		});
		const rpc = (method: string, params: unknown) =>
			new Promise<any>((resolve, reject) => {
				const key = ++id,
					timer = setTimeout(() => {
						pending.delete(key);
						reject(new Error("rpc_timeout"));
					}, 10000);
				pending.set(key, {
					resolve: (v) => {
						clearTimeout(timer);
						resolve(v);
					},
					reject: (e) => {
						clearTimeout(timer);
						reject(e);
					},
				});
				child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
			});
		try {
			await rpc("initialize", {
				clientInfo: { name: "fly2519-skill-qa", version: "1" },
			});
			child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
			await rpc("skills/list", { cwds: [project], forceReload: true });
			// Test fixture baseline only. Production must supply its explicitly pinned manifest baseline.
			const baseline = {
				codexVersion,
				sources: NATIVE_CODEX_SKILL_NAMES.map((name) => ({
					name,
					sha256: createHash("sha256")
						.update(
							readFileSync(join(codexHome, "skills/.system", name, "SKILL.md")),
						)
						.digest("hex"),
				})),
			};
			const text =
					"---\nname: parity-canary\ndescription: Isolated Flywheel skill canary.\n---\nUse the approved typed broker.\n",
				path = join(root, "adapter.md");
			writeFileSync(path, text);
			skills = installManifestSkills({
				codexHome,
				sources: [
					{
						name: "parity-canary",
						path,
						sha256: createHash("sha256").update(text).digest("hex"),
					},
				],
				secrets: [],
				nativeBaseline: baseline,
				codexVersion,
			});
			const result = await rpc("skills/list", {
				cwds: [project],
				forceReload: true,
			});
			const actual = result.data.flatMap(
				(entry: { skills: any[] }) => entry.skills,
			);
			expect(
				actual
					.filter((s: { scope: string }) => s.scope !== "system")
					.map((s: { name: string; path: string }) => ({
						name: s.name,
						path: s.path,
					})),
			).toEqual([
				{
					name: "parity-canary",
					path: join(codexHome, "skills/parity-canary/SKILL.md"),
				},
			]);
			skills.assertDiscovery(result, project);
			const extra = structuredClone(result);
			extra.data[0].skills.push({
				name: "foreign",
				path: "/foreign/SKILL.md",
				scope: "user",
				enabled: true,
			});
			expect(() => skills!.assertDiscovery(extra, project)).toThrow(
				"capability_skills_unverified",
			);
			console.info(
				"skill-consumer-receipt",
				JSON.stringify({
					codexVersion,
					native: skills.nativeReceipts,
					configured: skills.receipts,
				}),
			);
			expect(skills.nativeReceipts).toHaveLength(6);
			skills.assertCurrent();
		} finally {
			child.kill();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null)
					return resolve();
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 2000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			lines.close();
			skills?.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	20000,
);
