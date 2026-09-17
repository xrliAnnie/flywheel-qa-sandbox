import { execFile } from "node:child_process";
import { collectFixtureEvidence } from "./fixture-evidence.js";
import { provisionBoundaryFixture } from "./fixture-provision.js";
import { renderFixtureRunnerPolicy } from "./fixture-runner-policy.js";
import { readImmutableFile } from "./trusted-files.js";

type ProvisionInput = Parameters<typeof provisionBoundaryFixture>[0];
/** Trusted installer composition only. The caller must first authenticate its
 * own complete immutable installation and root policy. There is no RPC, argv
 * path interface, uploaded-results argument or acceptance signing in this API. */
export async function runInstallerFixture(
	input: ProvisionInput & { principalRunner: { path: string; sha256: string } },
) {
	try {
		if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw Error();
		const { principalRunner, ...provisionInput } = input;
		const { peerHelper, ...policyInput } = provisionInput;
		renderFixtureRunnerPolicy(policyInput);
		// Apply the same installed-path/strict-pin grammar to both native helpers.
		renderFixtureRunnerPolicy({
			...policyInput,
			node: principalRunner,
			boundaryProbe: peerHelper,
		});
		const measure = () => {
			for (const pin of [principalRunner, input.node, peerHelper])
				readImmutableFile(pin.path, {
					sha256: pin.sha256,
					maxBytes: 256 * 1024 * 1024,
					executable: true,
				});
			readImmutableFile(input.boundaryProbe.path, {
				sha256: input.boundaryProbe.sha256,
				maxBytes: 16 * 1024 * 1024,
			});
		};
		measure();
		const reservation = provisionBoundaryFixture(provisionInput);
		return await collectFixtureEvidence(
			{
				nonce: input.nonce,
				serviceUid: input.serviceUid,
				serviceGid: input.serviceGid,
				modelUid: input.modelUid,
				helperSha256: peerHelper.sha256,
				fixture: {
					markerSha256: reservation.markerSha256,
					state: reservation.state,
				},
			},
			async (role, probe) => {
				measure();
				return await new Promise<string>((resolve, reject) => {
					execFile(
						principalRunner.path,
						[role, probe],
						{
							cwd: "/",
							shell: false,
							encoding: "utf8",
							maxBuffer: 128 * 1024,
							timeout: 120000,
							killSignal: "SIGKILL",
							env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
						},
						(error, stdout, stderr) => {
							if (
								error ||
								stderr.length ||
								Buffer.byteLength(stdout) > 128 * 1024
							)
								reject(Error("fixture_child_unavailable"));
							else resolve(stdout);
						},
					);
				});
			},
		);
	} catch {
		throw Error("fixture_orchestration_unavailable");
	}
}
