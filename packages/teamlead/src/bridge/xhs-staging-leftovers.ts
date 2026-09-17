import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const XHS_STAGING_BYTES = 256 * 1024 * 1024;
export const XHS_STAGING_LEFTOVER_DIRS = 8;
export class XhsStagingLeftoversError extends Error {
	constructor(readonly paths: readonly string[]) {
		super("staging_leftovers_exceeded");
	}
}
type OwnedRoot = { path: string; dev: number; ino: number };
/** Metadata-only measurement of reserved staging trees. Never reads a manifest,
 * follows symlinks, moves directories or deletes retained data. Call under the
 * project's exclusive staging-owner marker before reserving new bytes. */
export function measureXhsStagingLeftovers(
	projectRoot: string,
	owned: readonly OwnedRoot[],
) {
	const paths: string[] = [];
	let bytes = 0,
		visited = 0;
	const deny = (): never => {
		throw new XhsStagingLeftoversError([...paths]);
	};
	try {
		if (!isAbsolute(projectRoot) || realpathSync(projectRoot) !== projectRoot)
			deny();
		const project = lstatSync(projectRoot);
		if (!project.isDirectory()) deny();
		const sameProject = () => {
			const current = lstatSync(projectRoot);
			if (
				!current.isDirectory() ||
				current.dev !== project.dev ||
				current.ino !== project.ino
			)
				deny();
		};
		const walk = (path: string, depth: number): void => {
			if (++visited > 65536 || depth > 16) deny();
			sameProject();
			const before = lstatSync(path);
			if (before.uid !== process.getuid?.() || before.isSymbolicLink()) deny();
			if (before.isFile()) {
				if (
					before.nlink !== 1 ||
					!Number.isSafeInteger(before.size) ||
					before.size < 0
				)
					deny();
				bytes += before.size;
				if (!Number.isSafeInteger(bytes) || bytes >= XHS_STAGING_BYTES) deny();
				return;
			}
			if (!before.isDirectory() || realpathSync(path) !== path) deny();
			const directory = opendirSync(path);
			try {
				for (
					let entry = directory.readSync();
					entry;
					entry = directory.readSync()
				)
					walk(join(path, entry.name), depth + 1);
			} finally {
				directory.closeSync();
			}
			const after = lstatSync(path);
			if (
				!after.isDirectory() ||
				after.dev !== before.dev ||
				after.ino !== before.ino
			)
				deny();
		};
		const directory = opendirSync(projectRoot);
		try {
			let count = 0;
			for (
				let entry = directory.readSync();
				entry;
				entry = directory.readSync()
			) {
				if (++count > 100000) deny();
				if (!entry.name.startsWith(".flywheel-xhs-artifact-")) continue;
				sameProject();
				const path = join(projectRoot, entry.name),
					stat = lstatSync(path);
				if (
					stat.isDirectory() &&
					owned.some(
						(root) =>
							root.path === path &&
							root.dev === stat.dev &&
							root.ino === stat.ino,
					)
				)
					continue;
				paths.push(path);
				if (paths.length >= XHS_STAGING_LEFTOVER_DIRS) deny();
				if (!stat.isDirectory()) deny();
				walk(path, 0);
			}
		} finally {
			directory.closeSync();
		}
		sameProject();
		return { bytes, paths: paths.sort() };
	} catch (error) {
		if (error instanceof XhsStagingLeftoversError) throw error;
		return deny();
	}
}
