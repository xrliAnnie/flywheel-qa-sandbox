import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { renderAuthorityDeployment } from "./deployment.js";

function readSource(path: string): string {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw Error();
		const raw = Buffer.alloc(65537);
		let length = 0;
		while (length < raw.length) {
			const count = readSync(fd, raw, length, raw.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length !== stat.size) throw Error();
		return new TextDecoder("utf-8", { fatal: true }).decode(
			raw.subarray(0, length),
		);
	} finally {
		closeSync(fd);
	}
}
try {
	const [
		policyFlag,
		policySource,
		providerFlag,
		providerSource,
		pathFlag,
		policyPath,
		outputFlag,
		output,
	] = process.argv.slice(2);
	if (
		process.argv.length !== 10 ||
		policyFlag !== "--policy-source" ||
		providerFlag !== "--provider-source" ||
		pathFlag !== "--policy-path" ||
		outputFlag !== "--output-dir" ||
		!policySource ||
		!providerSource ||
		!policyPath ||
		!output ||
		!isAbsolute(output) ||
		normalize(output) !== output
	)
		throw Error();
	const result = renderAuthorityDeployment(
		readSource(policySource),
		readSource(providerSource),
		policyPath,
	);
	const { plist, ...manifest } = result;
	// Exclusive directory creation: no overwrite of an earlier reviewed bundle.
	mkdirSync(output, { mode: 0o700 });
	writeFileSync(join(output, "com.flywheel.xhs-authority.plist"), plist, {
		flag: "wx",
		mode: 0o600,
	});
	writeFileSync(
		join(output, "requirements.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	process.stdout.write("authority_deployment_rendered\n");
} catch {
	process.stderr.write("authority_deployment_unavailable\n");
	process.exitCode = 1;
}
