import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	PINNED_NATIVE_CODEX_SKILLS,
	resolvePinnedNativeSkillBaseline,
} from "./native-skill-baseline.js";
import {
	type NativeSkillBaseline,
	verifyNativeSkillBaseline,
} from "./native-skills.js";

const denied = () => new Error("native_skill_home_unverified");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function snapshot(root: string, secrets: readonly string[]) {
	const files = new Map<string, { data: Buffer; mode: number }>();
	let size = 0,
		entries = 0;
	const walk = (relative: string) => {
		const path = join(root, relative);
		if (realpathSync(path) !== path) throw denied();
		const before = lstatSync(path);
		if (before.isSymbolicLink()) throw denied();
		if (++entries > 512) throw denied();
		if (before.isDirectory()) {
			for (const name of readdirSync(path).sort()) walk(join(relative, name));
			return;
		}
		if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024)
			throw denied();
		const fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const buffer = Buffer.alloc(before.size + 1);
			let length = 0;
			while (length < buffer.length) {
				const count = readSync(
					fd,
					buffer,
					length,
					buffer.length - length,
					null,
				);
				if (!count) break;
				length += count;
			}
			const data = buffer.subarray(0, length),
				after = fstatSync(fd);
			size += data.length;
			if (
				size > 8 * 1024 * 1024 ||
				data.length !== before.size ||
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.mtimeMs !== after.mtimeMs ||
				secrets.some((secret) => data.includes(Buffer.from(secret)))
			)
				throw denied();
			files.set(relative, { data, mode: 0o600 | (before.mode & 0o100) });
		} finally {
			closeSync(fd);
		}
	};
	walk("");
	return files;
}
function assertOrigin(
	root: string,
	baseline: NativeSkillBaseline,
	secrets: readonly string[],
) {
	if (!baseline.origin) throw denied();
	const files = snapshot(root, secrets);
	if (files.size !== baseline.origin.files.length) throw denied();
	for (const file of baseline.origin.files) {
		const actual = files.get(file.path);
		if (!actual || hash(actual.data) !== file.sha256) throw denied();
	}
}
/** Read-only full-tree admission check for operator canaries and trusted launchers. */
export function verifyNativeSkillOrigin(options: {
	root: string;
	baseline: NativeSkillBaseline;
	codexVersion: string;
	secrets: readonly string[];
}) {
	const receipts = verifyNativeSkillBaseline(options);
	assertOrigin(options.root, options.baseline, options.secrets);
	return receipts;
}
/** Canonical source is fixed by the deployed baseline. Existing homes are verified, never overwritten. */
export function preparePinnedNativeSkillHome(options: {
	codexHome: string;
	codexVersion: string;
	secrets: readonly string[];
}) {
	const selectedBaseline = resolvePinnedNativeSkillBaseline(
		options.codexVersion,
	);
	if (!selectedBaseline.origin) throw denied();
	const target = join(options.codexHome, "skills/.system");
	if (existsSync(target)) {
		let closed = false;
		const assertCurrent = () => {
			if (closed) throw denied();
			verifyNativeSkillOrigin({
				root: target,
				baseline: selectedBaseline,
				codexVersion: options.codexVersion,
				secrets: options.secrets,
			});
		};
		assertCurrent();
		return {
			root: target,
			assertCurrent,
			close: () => {
				closed = true;
			},
		};
	}
	if (!existsSync(selectedBaseline.origin.root)) throw denied();
	let canonicalOrigin: string;
	try {
		canonicalOrigin = realpathSync(selectedBaseline.origin.root);
		if (
			!isAbsolute(canonicalOrigin) ||
			!lstatSync(canonicalOrigin).isDirectory()
		)
			throw denied();
	} catch {
		throw denied();
	}
	const baseline: NativeSkillBaseline = {
		...selectedBaseline,
		origin: { ...selectedBaseline.origin, root: canonicalOrigin },
	};
	return prepareNativeSkillHome({
		...options,
		sourceRoot: canonicalOrigin,
		baseline,
	});
}
/** Trusted launcher preparation; never accepts model paths. Owns only its newly created .system. */
export function prepareNativeSkillHome(options: {
	sourceRoot: string;
	codexHome: string;
	codexVersion: string;
	secrets: readonly string[];
	baseline?: NativeSkillBaseline;
}) {
	const baseline = options.baseline ?? PINNED_NATIVE_CODEX_SKILLS;
	const secrets = options.secrets.filter(Boolean);
	const verify = (root: string) =>
		verifyNativeSkillBaseline({
			root,
			baseline,
			codexVersion: options.codexVersion,
			secrets,
		});
	for (const path of [options.sourceRoot, options.codexHome])
		if (
			!isAbsolute(path) ||
			!existsSync(path) ||
			realpathSync(path) !== path ||
			!lstatSync(path).isDirectory()
		)
			throw denied();
	verify(options.sourceRoot);
	const skills = join(options.codexHome, "skills"),
		target = join(skills, ".system");
	if (existsSync(target)) throw denied();

	if (baseline.origin) {
		if (options.sourceRoot !== baseline.origin.root) throw denied();
		assertOrigin(options.sourceRoot, baseline, secrets);
	}
	const source = snapshot(options.sourceRoot, secrets);
	if (!existsSync(skills)) mkdirSync(skills, { mode: 0o700 });
	if (realpathSync(skills) !== skills || !lstatSync(skills).isDirectory())
		throw denied();
	mkdirSync(target, { mode: 0o700 });
	const owner = lstatSync(target);
	let closed = false;
	const owns = () => {
		const now = lstatSync(target);
		return (
			now.dev === owner.dev && now.ino === owner.ino && !now.isSymbolicLink()
		);
	};
	const close = () => {
		if (closed) return;
		closed = true;
		if (existsSync(target) && owns()) rmSync(target, { recursive: true });
	};
	try {
		for (const [relative, { data, mode }] of source) {
			const parts = relative.split("/");
			parts.pop();
			let parent = target;
			for (const part of parts) {
				parent = join(parent, part);
				if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
			}
			writeFileSync(join(target, relative), data, { flag: "wx", mode });
		}
		const receipts = verify(target);
		const assertCurrent = () => {
			if (closed || !owns()) throw denied();
			verify(target);
			const current = snapshot(target, secrets);
			if (current.size !== source.size) throw denied();
			for (const [path, expected] of source)
				if (
					!current.has(path) ||
					hash(current.get(path)!.data) !== hash(expected.data) ||
					current.get(path)!.mode !== expected.mode
				)
					throw denied();
		};
		assertCurrent();
		return { root: target, receipts, assertCurrent, close };
	} catch (error) {
		close();
		throw error;
	}
}
