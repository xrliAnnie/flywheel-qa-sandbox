import fs from "node:fs";
import path from "node:path";

/**
 * FLY-793: Canonicalize a worktree path for comparison with git/lsof output.
 * Missing leaves are resolved through their deepest existing ancestor so a
 * removed worktree keeps the same comparison key as its former live path.
 */
export function canonicalizeWorktreePath(p: string): string {
	const abs = path.resolve(p);
	try {
		return fs.realpathSync(abs);
	} catch {
		const tail: string[] = [];
		let dir = abs;
		for (
			let parent = path.dirname(dir);
			parent !== dir;
			parent = path.dirname(dir)
		) {
			tail.unshift(path.basename(dir));
			dir = parent;
			try {
				return path.join(fs.realpathSync(dir), ...tail);
			} catch {
				// Keep walking until an existing ancestor supplies the canonical root.
			}
		}
		return abs;
	}
}
