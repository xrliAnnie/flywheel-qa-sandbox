import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { isAbsolute, normalize } from "node:path";

/** launchd creates the sockets; the unprivileged launcher passes fd3/fd4.
 * Never bind, unlink or change socket permissions in the authority process. */
export async function startInheritedAuthorityListeners(options: {
	/** Startup must establish immutable root ownership of helper and ancestors. */
	launcher: { path: string; sha256: string };
	ingressPath: string;
	authorityPath: string;
	ingress: RequestListener;
	authority: RequestListener;
}): Promise<{ close(): Promise<void> }> {
	const paths = [options.ingressPath, options.authorityPath];
	if (
		paths[0] === paths[1] ||
		paths.some((path) => !isAbsolute(path) || normalize(path) !== path)
	) {
		throw new Error("authority_listener_unavailable");
	}
	const running = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	const track =
		(handler: RequestListener): RequestListener =>
		(req, res) => {
			if (closing) {
				res.destroy();
				return;
			}
			const work = Promise.resolve()
				.then(() => handler(req, res))
				.catch(() => {
					res.destroy();
				})
				.finally(() => {
					running.delete(work);
				});
			running.add(work);
		};
	const ingress = createServer(track(options.ingress));
	const authority = createServer(track(options.authority));
	const close = () => {
		closing ??= Promise.all(
			[ingress, authority].map(
				(server) =>
					new Promise<void>((resolve) => {
						server.closeAllConnections();
						server.close(() => resolve());
					}),
			),
		).then(async () => {
			// Closing sockets cancels request transports, but an async handler may
			// still be unwinding provider work or recording its durable outcome.
			await Promise.all([...running]);
		});
		return closing;
	};
	async function adopt(server: Server, fd: number) {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen({ fd }, () => {
				server.removeListener("error", onError);
				resolve();
			});
		});
	}
	try {
		const { path, sha256 } = options.launcher;
		const stat = lstatSync(path);
		if (
			!isAbsolute(path) ||
			normalize(path) !== path ||
			!stat.isFile() ||
			stat.nlink !== 1 ||
			(stat.mode & 0o022) !== 0 ||
			(stat.mode & 0o111) === 0 ||
			stat.size > 1024 * 1024 ||
			!/^[a-f0-9]{64}$/.test(sha256) ||
			createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256
		)
			throw Error();
		execFileSync(path, ["--verify-listeners", ...paths], {
			stdio: ["ignore", "ignore", "ignore", 3, 4],
			timeout: 1000,
			env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
		});
		await adopt(ingress, 3);
		await adopt(authority, 4);
		return { close };
	} catch {
		await close();
		throw new Error("authority_listener_unavailable");
	}
}
