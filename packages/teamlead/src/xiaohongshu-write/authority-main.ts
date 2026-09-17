import { isAbsolute, normalize } from "node:path";
import { startAuthorityFromConfig } from "./authority-bootstrap.js";

const args = process.argv.slice(2);
if (
	args.length !== 2 ||
	args[0] !== "--config" ||
	!isAbsolute(args[1]!) ||
	normalize(args[1]!) !== args[1] ||
	args[1]!.includes("\0")
) {
	process.stderr.write("authority_arguments_invalid\n");
	process.exitCode = 2;
} else {
	let requested = false;
	let service: Awaited<ReturnType<typeof startAuthorityFromConfig>> | undefined;
	const stop = () => {
		requested = true;
		if (service)
			void service.close().catch(() => {
				process.exitCode = 1;
			});
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		service = await startAuthorityFromConfig(args[1]!);
		if (requested) await service.close();
		await service.closed;
	} catch {
		process.stderr.write("authority_startup_or_cleanup_failed\n");
		process.exitCode = 1;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
