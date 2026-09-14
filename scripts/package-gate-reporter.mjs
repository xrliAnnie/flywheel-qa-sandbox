import { renameSync, writeFileSync } from "node:fs";

// Do not infer success from JSON reporter's pending/skipped fallback: a lost
// onTaskUpdate can otherwise hide exactly the failure this gate must preserve.
export function createReceipt(expectedPaths, files, errors, reason) {
	let complete =
		expectedPaths.length > 0 &&
		new Set(expectedPaths).size === expectedPaths.length;
	const paths = files.map((file) => file.filepath);
	complete &&=
		paths.length === expectedPaths.length &&
		new Set(paths).size === paths.length &&
		expectedPaths.every((path) => paths.includes(path));
	let passed = 0,
		failed = 0,
		skipped = 0;
	function visit(task, inheritedSkip = false) {
		const declaredSkip =
			inheritedSkip || task.mode === "skip" || task.mode === "todo";
		const state = task.result?.state;
		if (task.result?.errors?.length || state === "fail") failed++;
		if (!declaredSkip && state !== "pass" && state !== "fail") complete = false;
		if (task.type === "test") {
			if (state === "pass") passed++;
			else if (declaredSkip) skipped++;
		}
		for (const child of task.tasks ?? []) visit(child, declaredSkip);
	}
	for (const file of files) visit(file);
	return {
		schemaVersion: 1,
		complete,
		reason,
		expectedFiles: expectedPaths.length,
		files: paths.length,
		passed,
		failed,
		skipped,
		errors: errors.map((error) => ({
			message:
				typeof error?.message === "string" ? error.message : String(error),
		})),
	};
}

export default class PackageGateReporter {
	onInit(ctx) {
		this.ctx = ctx;
	}
	onTestRunStart(specs) {
		this.expected = specs.map((spec) => spec.moduleId);
	}
	onTestRunEnd(_modules, errors, reason) {
		const output = this.ctx.config.outputFile;
		if (typeof output !== "string" || !output)
			throw new Error("--outputFile is required");
		const receipt = createReceipt(
			this.expected ?? [],
			this.ctx.state.getFiles(),
			errors,
			reason,
		);
		writeFileSync(`${output}.tmp`, `${JSON.stringify(receipt)}\n`);
		renameSync(`${output}.tmp`, output);
	}
}
