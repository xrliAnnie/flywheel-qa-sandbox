export type CodexLeadCapabilityInput = {
	backend?: string;
	codexProfile?: string;
	companion?: boolean;
	external?: boolean;
	canSpawnRunners?: boolean;
	codexRunnerActions?: boolean;
	codexCapabilityBundleVersion?: 2;
};

export type CodexLeadCapability = {
	eligible: boolean;
	runnerActionsEnabled: boolean;
	/** Absent on legacy rows; adoption is not proof of runtime readiness. */
	capabilityBundleVersion?: 2;
	reason: string | null;
};

/** Resolve from the raw registry row, before canSpawnRunners normalization. */
export function resolveCodexLeadCapabilities(
	input: CodexLeadCapabilityInput,
): CodexLeadCapability {
	const refuse = (reason: string): CodexLeadCapability => ({
		eligible: false,
		runnerActionsEnabled: false,
		reason,
	});
	if (
		input.codexCapabilityBundleVersion !== undefined &&
		input.codexCapabilityBundleVersion !== 2
	) {
		return refuse("codexCapabilityBundleVersion must be 2 when present");
	}
	if (
		input.codexCapabilityBundleVersion === 2 &&
		(input.backend !== "codex-app-server" ||
			input.codexProfile !== "full-access" ||
			input.companion === true ||
			input.external === true)
	) {
		return refuse(
			"codexCapabilityBundleVersion requires a full-access Codex department Lead",
		);
	}
	const bundle =
		input.codexCapabilityBundleVersion === 2
			? { capabilityBundleVersion: 2 as const }
			: {};
	if (
		input.codexRunnerActions !== undefined &&
		typeof input.codexRunnerActions !== "boolean"
	) {
		return refuse("codexRunnerActions must be a boolean");
	}
	const writeProfile =
		input.codexProfile === "write-capable" ||
		input.codexProfile === "full-access";
	if (
		input.codexProfile !== undefined &&
		input.codexProfile !== "companion" &&
		!writeProfile
	) {
		return refuse(
			"codexProfile must be companion, write-capable or full-access",
		);
	}
	if (writeProfile && input.companion === true) {
		return refuse(
			`codexProfile ${input.codexProfile} cannot be combined with companion: true`,
		);
	}
	if (input.codexRunnerActions === true) {
		if (
			input.canSpawnRunners !== true ||
			input.companion === true ||
			input.external === true ||
			!writeProfile
		) {
			return refuse(
				"codexRunnerActions requires explicit canSpawnRunners: true, a write-capable/full-access profile, and a non-companion, non-external Lead",
			);
		}
		return {
			eligible: true,
			...bundle,
			runnerActionsEnabled: input.backend === "codex-app-server",
			reason: null,
		};
	}
	const recognizedTier =
		input.companion === true ||
		input.codexProfile === "companion" ||
		writeProfile;
	if (input.canSpawnRunners !== false || !recognizedTier) {
		return refuse(
			"Codex requires canSpawnRunners: false and a recognized tier, or explicit codexRunnerActions authorization (FLY-245/FLY-2459)",
		);
	}
	return {
		eligible: true,
		runnerActionsEnabled: false,
		...bundle,
		reason: null,
	};
}

/** Current generic TUI contract; a requested unsupported tier must never fall back. */
export function resolveGenericCodexProfile(profile?: string): "full-access" {
	if (profile !== undefined && profile !== "full-access") {
		throw new Error("generic Codex TUI requires full-access");
	}
	return "full-access";
}
