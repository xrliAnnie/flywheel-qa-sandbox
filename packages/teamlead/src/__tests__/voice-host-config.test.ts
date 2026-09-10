import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../ProjectConfig.js";
import { loadVoiceHostConfig } from "../voice-host-config.js";

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true });
});

function fixture(): {
	root: string;
	homeDir: string;
	projects: ProjectEntry[];
} {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-host-"));
	cleanup.push(root);
	const homeDir = join(root, "home");
	const projectRoot = join(root, "project");
	mkdirSync(homeDir);
	mkdirSync(projectRoot);
	return {
		root,
		homeDir,
		projects: [
			{
				projectName: "flywheel",
				projectRoot,
				leads: [],
			},
		],
	};
}

describe("loadVoiceHostConfig", () => {
	it("uses bounded defaults when the optional host file is absent", () => {
		const { root, homeDir, projects } = fixture();
		expect(
			loadVoiceHostConfig({
				path: join(root, "missing.json"),
				homeDir,
				projects,
			}),
		).toEqual({
			schemaVersion: 1,
			qaVoiceChannelIds: [],
			qaAllowUserIds: [],
			evidenceRoots: [projects[0]!.projectRoot, join(homeDir, ".flywheel")],
		});
	});

	it("loads the exact allowlists from a private regular file", () => {
		const { root, homeDir, projects } = fixture();
		const evidenceRoot = join(root, "evidence");
		mkdirSync(evidenceRoot);
		const path = join(root, "voice-host.json");
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: 1,
				qaVoiceChannelIds: ["123456789012345678"],
				qaAllowUserIds: ["223456789012345678"],
				evidenceRoots: [evidenceRoot],
			}),
		);
		chmodSync(path, 0o600);

		expect(loadVoiceHostConfig({ path, homeDir, projects })).toEqual({
			schemaVersion: 1,
			qaVoiceChannelIds: ["123456789012345678"],
			qaAllowUserIds: ["223456789012345678"],
			evidenceRoots: [evidenceRoot],
		});
	});

	it("rejects public, symlinked, identity-bearing, and malformed files", () => {
		const { root, homeDir, projects } = fixture();
		const load = (path: string) =>
			loadVoiceHostConfig({ path, homeDir, projects });
		const publicFile = join(root, "public.json");
		writeFileSync(publicFile, JSON.stringify({ schemaVersion: 1 }));
		chmodSync(publicFile, 0o644);
		expect(() => load(publicFile)).toThrow(/0600/);

		const target = join(root, "target.json");
		writeFileSync(target, JSON.stringify({ schemaVersion: 1 }));
		chmodSync(target, 0o600);
		const link = join(root, "link.json");
		symlinkSync(target, link);
		expect(() => load(link)).toThrow(/symlink/);

		for (const value of [
			{ schemaVersion: 1, botToken: "secret" },
			{ schemaVersion: 2 },
			{ schemaVersion: 1, qaAllowUserIds: ["not-a-snowflake"] },
			{ schemaVersion: 1, evidenceRoots: ["relative"] },
		]) {
			writeFileSync(target, JSON.stringify(value));
			expect(() => load(target)).toThrow();
		}
	});
});
