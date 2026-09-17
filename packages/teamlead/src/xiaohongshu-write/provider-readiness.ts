import { setTimeout as delay } from "node:timers/promises";
import type { ProviderStartupConfig } from "./authority-config.js";
import type { XhsProviderClient } from "./provider-client.js";

/** Startup transport readiness only. Logged-out readiness keeps read/login
 * paths available; preparation still requires fresh proven account login. */
export async function waitForGuardedProvider(options: {
	exited: Promise<unknown>;
	expected: Pick<
		ProviderStartupConfig,
		"accountBase" | "providerBinary" | "toolSchemaDigest"
	>;
	client: Pick<XhsProviderClient, "account">;
	signal?: AbortSignal;
}) {
	const expected = structuredClone(options.expected);
	const controller = new AbortController();
	let finished = false;
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	void options.exited.then(
		() => {
			if (!finished) abort();
		},
		() => {
			if (!finished) abort();
		},
	);
	const timer = setTimeout(abort, 30000);
	let rejectCancelled!: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		rejectCancelled = () => reject(Error("provider_ready_unavailable"));
	});
	controller.signal.addEventListener("abort", rejectCancelled, { once: true });
	try {
		for (;;) {
			if (controller.signal.aborted) throw Error();
			let proof: Awaited<ReturnType<XhsProviderClient["account"]>>;
			try {
				proof = await Promise.race([
					options.client.account(controller.signal),
					cancelled,
				]);
			} catch {
				if (controller.signal.aborted) throw Error();
				await delay(250, undefined, { signal: controller.signal });
				continue;
			}
			if (controller.signal.aborted) throw Error();
			if (
				proof.account.providerInstanceId !==
					expected.accountBase.providerInstanceId ||
				proof.account.accountUserId !== expected.accountBase.accountUserId ||
				proof.account.providerGeneration !==
					expected.accountBase.providerGeneration ||
				!Number.isSafeInteger(proof.account.accountEpoch) ||
				proof.account.accountEpoch < expected.accountBase.accountEpoch ||
				proof.upstream.guardProtocol !== 1 ||
				proof.upstream.binarySha256 !== expected.providerBinary.sha256 ||
				proof.upstream.toolSchemaDigest !== expected.toolSchemaDigest
			)
				throw Error();
			return proof;
		}
	} catch {
		throw Error("provider_ready_unavailable");
	} finally {
		finished = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", rejectCancelled);
	}
}
