import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { readManifestMarkdown } from "./manifest-instructions.js";
import {
	type NativeSkillBaseline,
	verifyNativeSkillBaseline,
} from "./native-skills.js";
import { recordActualLeadRuleSources } from "./rule-sources.js";

/** Install admitted, self-contained Markdown adapters. No implicit directory copy,
 * resource discovery or credential-bearing upstream helper execution. */
export function installManifestSkills(options: {
	codexHome: string;
	nativeBaseline?: NativeSkillBaseline;
	codexVersion?: string;
	sources: readonly { name: string; path: string; sha256: string }[];
	secrets: readonly string[];
}) {
	const invalid = () => new Error("capability_skills_unverified"),
		root = join(options.codexHome, "skills");
	let createdRoot = false;
	const ownedDirectories: Array<{ path: string; dev: number; ino: number }> =
		[];
	let owned: { dev: number; ino: number } | undefined,
		closed = false;
	const sameRoot = () => {
		const stat = lstatSync(root);
		return (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			stat.dev === owned?.dev &&
			stat.ino === owned?.ino
		);
	};
	const close = () => {
		if (closed) return;
		closed = true;
		if (owned) {
			try {
				if (sameRoot()) {
					if (createdRoot) rmSync(root, { recursive: true, force: true });
					else
						for (const directory of ownedDirectories) {
							const stat = lstatSync(directory.path);
							if (
								stat.dev === directory.dev &&
								stat.ino === directory.ino &&
								!stat.isSymbolicLink()
							)
								rmSync(directory.path, { recursive: true, force: true });
						}
				}
			} catch {}
		}
	};
	try {
		if (
			!isAbsolute(options.codexHome) ||
			realpathSync(options.codexHome) !== options.codexHome ||
			!lstatSync(options.codexHome).isDirectory()
		)
			throw invalid();
		const names = options.sources.map((s) => s.name);
		if (
			names.length > 128 ||
			new Set(names).size !== names.length ||
			names.some(
				(n) =>
					n.length > 128 || !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/.test(n),
			)
		)
			throw invalid();
		const texts = options.sources.length
			? readManifestMarkdown(options.sources, options.secrets)
			: [];
		for (let i = 0; i < texts.length; i++) {
			const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(texts[i]!);
			if (!match) throw invalid();
			const meta = parse(match[1]!, { maxAliasCount: 0 }) as {
				name?: unknown;
				description?: unknown;
			};
			if (
				!meta ||
				meta.name !== names[i] ||
				typeof meta.description !== "string" ||
				!meta.description.trim() ||
				meta.description.length > 1024
			)
				throw invalid();
		}
		const nativeReceipts = options.nativeBaseline
			? verifyNativeSkillBaseline({
					root: join(root, ".system"),
					baseline: options.nativeBaseline,
					codexVersion: options.codexVersion ?? "",
					secrets: options.secrets,
				})
			: [];
		if (existsSync(root)) {
			if (
				!options.nativeBaseline ||
				realpathSync(root) !== root ||
				JSON.stringify(readdirSync(root)) !== JSON.stringify([".system"])
			)
				throw invalid();
		} else {
			mkdirSync(root, { mode: 0o700 });
			createdRoot = true;
		}
		const stat = lstatSync(root);
		owned = { dev: stat.dev, ino: stat.ino };
		const installed = options.sources.map((source, i) => {
			const directory = join(root, encodeURIComponent(source.name));
			mkdirSync(directory, { mode: 0o700 });
			const directoryStat = lstatSync(directory);
			ownedDirectories.push({
				path: directory,
				dev: directoryStat.dev,
				ino: directoryStat.ino,
			});
			const path = join(directory, "SKILL.md");
			writeFileSync(path, texts[i]!, { flag: "wx", mode: 0o444 });
			return { name: source.name, path, sha256: source.sha256 };
		});
		const assertCurrent = () => {
			try {
				if (closed || !sameRoot()) throw invalid();
				if (
					JSON.stringify(readdirSync(root).sort()) !==
					JSON.stringify(
						[
							...names.map(encodeURIComponent),
							...(options.nativeBaseline ? [".system"] : []),
						].sort(),
					)
				)
					throw invalid();
				for (const skill of installed) {
					const dir = join(root, encodeURIComponent(skill.name));
					if (
						realpathSync(dir) !== dir ||
						JSON.stringify(readdirSync(dir)) !== JSON.stringify(["SKILL.md"])
					)
						throw invalid();
					const file = lstatSync(skill.path);
					if (
						!file.isFile() ||
						file.isSymbolicLink() ||
						file.size > 1024 * 1024
					)
						throw invalid();
				}
				if (installed.length) readManifestMarkdown(installed, options.secrets);
				if (options.nativeBaseline)
					verifyNativeSkillBaseline({
						root: join(root, ".system"),
						baseline: options.nativeBaseline,
						codexVersion: options.codexVersion ?? "",
						secrets: options.secrets,
					});
			} catch (error) {
				if (error instanceof Error && error.message === "baseline_drift")
					throw error;
				throw invalid();
			}
		};
		assertCurrent();
		const receipts = recordActualLeadRuleSources(
			installed.map((s) => ({
				sourceId: `skill/${s.name}`,
				layer: "skill",
				sourcePath: s.path,
			})),
		);
		assertCurrent();
		const assertDiscovery = (raw: unknown, cwd: string) => {
			try {
				assertCurrent();
				const response = z
					.object({
						data: z
							.array(
								z.object({
									cwd: z.string(),
									skills: z.array(
										z.object({
											name: z.string(),
											path: z.string(),
											scope: z.string(),
											enabled: z.boolean(),
										}),
									),
									errors: z.array(z.unknown()).optional(),
								}),
							)
							.length(1),
					})
					.parse(raw);
				const row = response.data[0]!;
				if (row.cwd !== cwd || (row.errors?.length ?? 0) > 0) throw invalid();
				const expected = [
					...installed.map((s) => ({
						name: s.name,
						path: s.path,
						scope: "user",
						enabled: true,
					})),
					...nativeReceipts.map((s) => ({
						name: s.name,
						path: s.sourcePath,
						scope: "system",
						enabled: true,
					})),
				];
				const canonical = (values: typeof expected) =>
					values
						.map((s) => JSON.stringify([s.name, s.path, s.scope, s.enabled]))
						.sort();
				if (
					JSON.stringify(canonical(row.skills)) !==
					JSON.stringify(canonical(expected))
				)
					throw invalid();
				assertCurrent();
			} catch (error) {
				if (error instanceof Error && error.message === "baseline_drift")
					throw error;
				throw invalid();
			}
		};
		return { receipts, nativeReceipts, assertCurrent, assertDiscovery, close };
	} catch (error) {
		close();
		if (error instanceof Error && error.message === "baseline_drift")
			throw error;
		throw invalid();
	}
}
