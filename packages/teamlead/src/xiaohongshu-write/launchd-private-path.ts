import { lstatSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

/** Only pass the verified root policy. launchd owns the listener inode;
 * the service group can traverse its private directory but cannot replace it. */
export function verifyPrivateAuthoritySocket(policy: {
	authoritySocket: string;
	serviceGid: number;
}): void {
	try {
		const { authoritySocket: path, serviceGid } = policy;
		if (
			!isAbsolute(path) ||
			normalize(path) !== path ||
			path.includes("\0") ||
			!Number.isSafeInteger(serviceGid) ||
			serviceGid <= 0 ||
			serviceGid === 80
		)
			throw Error();
		const parent = dirname(path);
		for (let current = parent; ; current = dirname(current)) {
			const stat = lstatSync(current);
			if (
				!stat.isDirectory() ||
				stat.uid !== 0 ||
				(stat.mode & 0o7022) !== 0 ||
				(current === parent &&
					(stat.gid !== serviceGid || (stat.mode & 0o7777) !== 0o750))
			)
				throw Error();
			if (current === dirname(current)) break;
		}
		const socket = lstatSync(path);
		if (
			!socket.isSocket() ||
			socket.uid !== 0 ||
			socket.gid !== serviceGid ||
			socket.nlink !== 1 ||
			(socket.mode & 0o7777) !== 0o660
		)
			throw Error();
	} catch {
		throw Error("authority_config_unavailable");
	}
}
