import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { canonicalDigest, prFileInventorySchema } from "./contract.js";

// Raw PR material can exceed a single document. Model packets and persisted ledgers
// retain their independent, smaller budgets. Keep this temporary read bounded.
export const RAW_PR_DIFF_BYTES = 2 * 1024 * 1024;
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const pathSchema = prFileInventorySchema.shape.files.element.shape.path;
export interface FrozenDiff {
	text: string;
	files: { path: string; previous_path?: string; status: string }[];
	complete: boolean;
	digest: string;
}

/** Reads only caller-owned bare Git objects. Does not checkout, follow symlinks, or execute diff drivers. */
export class FrozenGitReader {
	private verified: Promise<void> | undefined;
	constructor(
		private readonly gitDir: string,
		private readonly signal?: AbortSignal,
	) {
		if (!isAbsolute(gitDir)) throw new Error("isolated_bare_required");
	}

	async listTextFiles(commit: string, directory: string): Promise<string[]> {
		shaSchema.parse(commit);
		if (directory) pathSchema.parse(directory);
		await this.verify();
		const listing = this.text(
			await this.git(
				["ls-tree", "-z", directory ? `${commit}:${directory}` : commit],
				262_144,
			),
		);
		const entries = listing.split("\0");
		if (entries.pop() !== "" || entries.length > 1000)
			throw new Error("git_directory_budget_exceeded");
		const files: string[] = [];
		for (const entry of entries) {
			const match =
				/^([0-9]{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]*)$/.exec(entry);
			if (!match) throw new Error("git_directory_invalid");
			if (match[2] === "blob" && /\.(?:md|html)$/.test(match[4]!)) {
				files.push(
					pathSchema.parse(directory ? `${directory}/${match[4]}` : match[4]),
				);
			}
		}
		return files.sort();
	}

	async readText(
		commit: string,
		path: string,
	): Promise<{ text: string; blobSha: string }> {
		shaSchema.parse(commit);
		pathSchema.parse(path);
		await this.verify();
		const entry = this.text(
			await this.git(["ls-tree", "-z", commit, "--", path], 4096),
		);
		const match = /^([0-9]{6}) blob ([a-f0-9]{40})\t([\s\S]*)\0$/.exec(entry);
		if (
			!match ||
			match[3] !== path ||
			!["100644", "100755"].includes(match[1]!)
		)
			throw new Error("git_blob_not_regular");
		const blobSha = match[2]!;
		const size = Number(
			this.text(await this.git(["cat-file", "-s", blobSha], 128)).trim(),
		);
		if (!Number.isSafeInteger(size) || size < 0 || size > 262_144)
			throw new Error("git_blob_budget_exceeded");
		const blob = await this.git(["cat-file", "blob", blobSha], 262_145);
		if (blob.byteLength !== size) throw new Error("git_blob_size_mismatch");
		return { text: this.text(blob), blobSha };
	}

	async mergeBase(base: string, head: string): Promise<string> {
		shaSchema.parse(base);
		shaSchema.parse(head);
		await this.verify();
		return shaSchema.parse(
			this.text(
				await this.git(["merge-base", "--all", base, head], 4096),
			).trim(),
		);
	}

	async diff(base: string, head: string): Promise<FrozenDiff> {
		shaSchema.parse(base);
		shaSchema.parse(head);
		await this.verify();
		const args = [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames",
			"--no-color",
		];
		const names = this.text(
			await this.git(
				[...args, "--name-status", "-z", base, head, "--"],
				1_048_576,
			),
		).split("\0");
		if (names.pop() !== "") throw new Error("git_file_list_invalid");
		const files: FrozenDiff["files"] = [];
		for (let index = 0; index < names.length; ) {
			const status = names[index++];
			if (!status || !/^[ACDMRTUXB][0-9]*$/.test(status))
				throw new Error("git_file_list_invalid");
			const first = pathSchema.parse(names[index++]);
			if (status.startsWith("R") || status.startsWith("C"))
				files.push({
					path: pathSchema.parse(names[index++]),
					previous_path: first,
					status,
				});
			else files.push({ path: first, status });
			if (files.length > 1000) throw new Error("git_file_budget_exceeded");
		}
		const text = this.text(
			await this.git([...args, base, head, "--"], RAW_PR_DIFF_BYTES),
		);
		return {
			files,
			text,
			complete: !/^Binary files .+ differ$/m.test(text),
			digest: canonicalDigest({ base, head, files, text }),
		};
	}

	private verify(): Promise<void> {
		this.verified ??= this.git(["rev-parse", "--is-bare-repository"], 128).then(
			(result) => {
				if (this.text(result).trim() !== "true")
					throw new Error("isolated_bare_required");
			},
		);
		return this.verified;
	}

	private text(value: Buffer): string {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(value);
		} catch {
			throw new Error("git_input_not_utf8");
		}
	}

	private git(args: string[], maxBuffer: number): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			execFile(
				"git",
				[
					"--no-pager",
					"--literal-pathspecs",
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.fsmonitor=false",
					`--git-dir=${this.gitDir}`,
					...args,
				],
				{
					encoding: "buffer",
					maxBuffer,
					timeout: 20_000,
					killSignal: "SIGKILL",
					signal: this.signal,
					env: {
						PATH: process.env.PATH,
						LC_ALL: "C",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						GIT_NO_LAZY_FETCH: "1",
					},
				},
				(error, stdout) =>
					error
						? reject(new Error("git_input_read_failed", { cause: error }))
						: resolve(stdout),
			);
		});
	}
}
