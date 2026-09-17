import { probeFileControl } from "./boundary-file-control.js";
import { probeFileAuthority } from "./boundary-file-probe.js";
import { runBoundaryFixtureHarness } from "./boundary-fixture-launcher.js";

// Independent fixture-only entry. It cannot load production authority config,
// start production services, acquire account credentials or sign acceptance.
const args = process.argv.slice(2);
try {
	if (
		args.length !== 4 ||
		args[0] !== "--probe" ||
		!["file-authority", "file-control", "authority-flow"].includes(args[1]!) ||
		args[2] !== "--fixture"
	)
		throw Error();
	const result =
		args[1] === "authority-flow"
			? await runBoundaryFixtureHarness(args[3]!)
			: args[1] === "file-control"
				? probeFileControl(args[3]!)
				: probeFileAuthority(args[3]!);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (
		"observations" in result &&
		!result.observations.every((row) => row.denied)
	)
		process.exitCode = 1;
} catch {
	process.stderr.write("boundary_probe_unavailable\n");
	process.exitCode = 1;
}
