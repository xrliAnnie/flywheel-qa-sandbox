import {
	baseOf,
	CHANNEL_OF_POINTER,
	CHANNELS,
	isBetaSemver,
	isCleanSemver,
	isHex,
	isIso,
	isPayloadSemver,
	latestSet,
	OP_KINDS,
	OP_STATES,
	payloadObjectKey,
	VERSION_STATUSES,
} from "./grammar.mjs";

const ROOT_KEYS = [
	"schemaVersion",
	"channels",
	"versions",
	"releaseOps",
	"releaseLedger",
	"tombstones",
];
const CHANNEL_KEYS = ["latest"];
const VERSION_ENTRY_KEYS = [
	"sha256",
	"key",
	"size",
	"publishedAt",
	"channel",
	"status",
	"sourceCommit",
	"releaseId",
	"derivedFromBeta",
	"retentionSince",
	"quarantinedAt",
];
const RELEASE_OP_KEYS = [
	"kind",
	"state",
	"ver",
	"betaVersion",
	"sourceCommit",
	"sha256",
	"objectKey",
	"createdAt",
];
const LEDGER_KEYS = ["nextBetaN"];

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, expected) {
	if (!isPlainObject(value)) return false;
	const actual = Object.keys(value).sort();
	return actual.join("\0") === [...expected].sort().join("\0");
}

export function validateManifest(manifest) {
	const errors = [];
	const error = (code, path, message) => {
		errors.push(`${code}: ${path}: ${message}`);
	};
	const shape = (condition, path, message) => {
		if (!condition) error("C-0", path, message);
		return condition;
	};

	if (!shape(isPlainObject(manifest), "$", "manifest must be an object")) {
		return errors;
	}
	shape(
		sameKeys(manifest, ROOT_KEYS),
		"$",
		`keys must be exactly ${ROOT_KEYS.join(",")}`,
	);
	shape(manifest.schemaVersion === 1, "schemaVersion", "must equal 1");
	const channelsOk = shape(
		isPlainObject(manifest.channels),
		"channels",
		"must be an object",
	);
	const versionsOk = shape(
		isPlainObject(manifest.versions),
		"versions",
		"must be an object",
	);
	const releaseOpsOk = shape(
		isPlainObject(manifest.releaseOps),
		"releaseOps",
		"must be an object",
	);
	const releaseLedgerOk = shape(
		isPlainObject(manifest.releaseLedger),
		"releaseLedger",
		"must be an object",
	);
	const tombstonesOk = shape(
		Array.isArray(manifest.tombstones),
		"tombstones",
		"must be an array",
	);
	if (!channelsOk || !versionsOk || !releaseOpsOk || !releaseLedgerOk) {
		return errors;
	}

	shape(
		sameKeys(manifest.channels, CHANNELS),
		"channels",
		`keys must be exactly ${CHANNELS.join(",")}`,
	);
	for (const pointer of CHANNELS) {
		const spec = manifest.channels[pointer];
		if (
			!shape(isPlainObject(spec), `channels[${pointer}]`, "must be an object")
		) {
			continue;
		}
		shape(
			sameKeys(spec, CHANNEL_KEYS),
			`channels[${pointer}]`,
			"keys must be exactly latest",
		);
		shape(
			spec.latest === null || typeof spec.latest === "string",
			`channels[${pointer}].latest`,
			"must be a string or null",
		);
	}

	const releaseIdToVersion = new Map();
	for (const [version, entry] of Object.entries(manifest.versions)) {
		const at = `versions[${version}]`;
		const versionValid = isPayloadSemver(version);
		if (!versionValid) {
			error("C-0", at, "key must be a clean or beta payload semver");
		}
		if (!shape(isPlainObject(entry), at, "must be an object")) continue;
		shape(
			sameKeys(entry, VERSION_ENTRY_KEYS),
			at,
			`keys must be exactly ${VERSION_ENTRY_KEYS.join(",")}`,
		);
		const shaValid = shape(
			isHex(entry.sha256, 64),
			`${at}.sha256`,
			"must be 64 lowercase hex characters",
		);
		shape(typeof entry.key === "string", `${at}.key`, "must be a string");
		if (
			versionValid &&
			shaValid &&
			entry.key !== payloadObjectKey(version, entry.sha256)
		) {
			error("C-2", `${at}.key`, "must equal payloadObjectKey(version, sha256)");
		}
		shape(
			Number.isInteger(entry.size) && entry.size > 0,
			`${at}.size`,
			"must be a positive integer",
		);
		shape(
			isIso(entry.publishedAt),
			`${at}.publishedAt`,
			"must be an ISO timestamp",
		);
		shape(
			entry.channel === "beta" || entry.channel === "release",
			`${at}.channel`,
			"must be beta or release",
		);
		if (entry.channel === "beta" && !isBetaSemver(version)) {
			error("C-9", at, "a beta entry key must be X.Y.Z-beta.N");
		}
		if (entry.channel === "release" && !isCleanSemver(version)) {
			error("C-9", at, "a release entry key must be X.Y.Z");
		}
		shape(
			VERSION_STATUSES.includes(entry.status),
			`${at}.status`,
			"has an unsupported value",
		);
		shape(
			isHex(entry.sourceCommit, 40),
			`${at}.sourceCommit`,
			"must be 40 lowercase hex characters",
		);
		const releaseIdValid = shape(
			typeof entry.releaseId === "string" && entry.releaseId.length > 0,
			`${at}.releaseId`,
			"must be a non-empty string",
		);
		if (releaseIdValid) {
			if (releaseIdToVersion.has(entry.releaseId)) {
				error(
					"C-7",
					`${at}.releaseId`,
					`duplicates versions[${releaseIdToVersion.get(entry.releaseId)}].releaseId`,
				);
			}
			releaseIdToVersion.set(entry.releaseId, version);
		}
		shape(
			entry.derivedFromBeta === null || isBetaSemver(entry.derivedFromBeta),
			`${at}.derivedFromBeta`,
			"must be a beta payload semver or null",
		);
		shape(
			entry.retentionSince === null || isIso(entry.retentionSince),
			`${at}.retentionSince`,
			"must be null or an ISO timestamp",
		);
		shape(
			entry.quarantinedAt === null || isIso(entry.quarantinedAt),
			`${at}.quarantinedAt`,
			"must be null or an ISO timestamp",
		);
		if (entry.status === "quarantined" && entry.quarantinedAt === null) {
			error(
				"C-0",
				`${at}.quarantinedAt`,
				"must be set for a quarantined entry",
			);
		}

		if (entry.channel === "beta") {
			if (entry.derivedFromBeta !== null) {
				error("C-6", `${at}.derivedFromBeta`, "must be null for a beta entry");
			}
		} else if (entry.channel === "release") {
			const betaVersion = entry.derivedFromBeta;
			const beta =
				typeof betaVersion === "string"
					? manifest.versions[betaVersion]
					: undefined;
			if (!beta) {
				error(
					"C-6",
					`${at}.derivedFromBeta`,
					"must reference an existing beta entry",
				);
			} else {
				if (beta.channel !== "beta") {
					error("C-6", `${at}.derivedFromBeta`, "must reference a beta entry");
				}
				if (!isBetaSemver(betaVersion) || baseOf(betaVersion) !== version) {
					error(
						"C-6",
						`${at}.derivedFromBeta`,
						"base must equal the release version",
					);
				}
				if (beta.sourceCommit !== entry.sourceCommit) {
					error(
						"C-6",
						`${at}.sourceCommit`,
						"must equal its beta sourceCommit",
					);
				}
			}
		}
	}

	for (const pointer of CHANNELS) {
		const spec = manifest.channels[pointer];
		if (!isPlainObject(spec)) continue;
		const expectedChannel = CHANNEL_OF_POINTER[pointer];
		if (spec.latest === null) {
			const hasActive = Object.values(manifest.versions).some(
				(entry) =>
					isPlainObject(entry) &&
					entry.channel === expectedChannel &&
					entry.status === "active",
			);
			if (hasActive) {
				error(
					"C-1b",
					`channels[${pointer}]`,
					`latest is null while active ${expectedChannel} entries exist`,
				);
			}
			continue;
		}
		if (typeof spec.latest !== "string") continue;
		const entry = manifest.versions[spec.latest];
		if (!entry) {
			error(
				"C-1",
				`channels[${pointer}]`,
				`latest ${spec.latest} has no entry (dangling)`,
			);
			continue;
		}
		if (entry.status !== "active") {
			error(
				"C-1",
				`channels[${pointer}]`,
				`latest ${spec.latest} is not active`,
			);
		}
		if (entry.channel !== expectedChannel) {
			error(
				"C-1",
				`channels[${pointer}]`,
				`latest ${spec.latest} channel mismatch`,
			);
		}
	}

	const latest = latestSet(manifest);
	for (const [version, entry] of Object.entries(manifest.versions)) {
		if (!isPlainObject(entry)) continue;
		if (latest.has(version)) {
			if (entry.retentionSince !== null) {
				error(
					"C-5",
					`versions[${version}].retentionSince`,
					"latest entries must be pinned with null",
				);
			}
		} else if (entry.status === "active" && entry.retentionSince === null) {
			error(
				"C-5",
				`versions[${version}].retentionSince`,
				"active non-latest entries must have a timestamp",
			);
		}
	}

	for (const [baseVersion, record] of Object.entries(manifest.releaseLedger)) {
		const at = `releaseLedger[${baseVersion}]`;
		if (!isCleanSemver(baseVersion)) {
			error("C-0", at, "key must be a clean base semver");
		}
		if (!shape(isPlainObject(record), at, "must be an object")) continue;
		shape(sameKeys(record, LEDGER_KEYS), at, "keys must be exactly nextBetaN");
		if (!Number.isInteger(record.nextBetaN) || record.nextBetaN < 1) {
			error(
				"C-4",
				`${at}.nextBetaN`,
				"must be an integer greater than or equal to 1",
			);
		}
	}

	const committedOperationIds = new Set();
	for (const [releaseId, operation] of Object.entries(manifest.releaseOps)) {
		const at = `releaseOps[${releaseId}]`;
		if (!shape(releaseId.length > 0, at, "key must be a non-empty string"))
			continue;
		if (!shape(isPlainObject(operation), at, "must be an object")) continue;
		shape(
			sameKeys(operation, RELEASE_OP_KEYS),
			at,
			`keys must be exactly ${RELEASE_OP_KEYS.join(",")}`,
		);
		shape(
			OP_KINDS.includes(operation.kind),
			`${at}.kind`,
			"has an unsupported value",
		);
		shape(
			OP_STATES.includes(operation.state),
			`${at}.state`,
			"has an unsupported value",
		);
		shape(
			isPayloadSemver(operation.ver),
			`${at}.ver`,
			"must be a clean or beta payload semver",
		);
		shape(
			operation.betaVersion === null || isBetaSemver(operation.betaVersion),
			`${at}.betaVersion`,
			"must be a beta payload semver or null",
		);
		shape(
			operation.sourceCommit === null || isHex(operation.sourceCommit, 40),
			`${at}.sourceCommit`,
			"must be null or 40 lowercase hex characters",
		);
		const operationShaValid = shape(
			operation.sha256 === null || isHex(operation.sha256, 64),
			`${at}.sha256`,
			"must be null or 64 lowercase hex characters",
		);
		shape(
			operation.objectKey === null || typeof operation.objectKey === "string",
			`${at}.objectKey`,
			"must be a string or null",
		);
		shape(
			isIso(operation.createdAt),
			`${at}.createdAt`,
			"must be an ISO timestamp",
		);

		if (operation.kind === "beta") {
			if (!isBetaSemver(operation.ver)) {
				error("C-9", `${at}.ver`, "beta operations require X.Y.Z-beta.N");
			}
			if (operation.betaVersion !== null) {
				error("C-7", `${at}.betaVersion`, "beta operations require null");
			}
		} else if (operation.kind === "release") {
			if (!isCleanSemver(operation.ver)) {
				error("C-9", `${at}.ver`, "release operations require X.Y.Z");
			}
			if (!isBetaSemver(operation.betaVersion)) {
				error(
					"C-7",
					`${at}.betaVersion`,
					"release operations must pin a beta version",
				);
			} else if (
				isCleanSemver(operation.ver) &&
				baseOf(operation.betaVersion) !== operation.ver
			) {
				error("C-7", `${at}.betaVersion`, "base must equal operation.ver");
			}
		}

		if ((operation.sha256 === null) !== (operation.objectKey === null)) {
			error("C-7", at, "sha256 and objectKey must be registered together");
		}
		if (
			operation.objectKey !== null &&
			operation.sha256 !== null &&
			operationShaValid &&
			isPayloadSemver(operation.ver) &&
			operation.objectKey !== payloadObjectKey(operation.ver, operation.sha256)
		) {
			error(
				"C-2",
				`${at}.objectKey`,
				"must equal payloadObjectKey(ver, sha256)",
			);
		}
		if (
			(operation.state === "prepared" || operation.state === "committed") &&
			(operation.sourceCommit === null ||
				operation.sha256 === null ||
				operation.objectKey === null)
		) {
			error(
				"C-7",
				at,
				`${operation.state} operations must carry the full tuple`,
			);
		}
		if (operation.state === "committed") committedOperationIds.add(releaseId);
	}

	for (const [releaseId, version] of releaseIdToVersion) {
		const operation = manifest.releaseOps[releaseId];
		const entry = manifest.versions[version];
		if (!operation) {
			error(
				"C-7",
				`versions[${version}].releaseId`,
				`${releaseId} has no releaseOps record`,
			);
			continue;
		}
		if (operation.state !== "committed") {
			error(
				"C-7",
				`releaseOps[${releaseId}].state`,
				"must be committed when referenced by a version",
			);
			continue;
		}
		if (operation.ver !== version)
			error("C-7", `releaseOps[${releaseId}].ver`, `must equal ${version}`);
		if (operation.sha256 !== entry.sha256)
			error(
				"C-7",
				`releaseOps[${releaseId}].sha256`,
				"must equal its version entry",
			);
		if (operation.objectKey !== entry.key)
			error(
				"C-7",
				`releaseOps[${releaseId}].objectKey`,
				"must equal its version entry",
			);
		if (operation.sourceCommit !== entry.sourceCommit)
			error(
				"C-7",
				`releaseOps[${releaseId}].sourceCommit`,
				"must equal its version entry",
			);
		const expectedEntryChannel = operation.kind === "beta" ? "beta" : "release";
		if (entry.channel !== expectedEntryChannel)
			error(
				"C-7",
				`releaseOps[${releaseId}].kind`,
				"must match its version channel",
			);
		if (
			operation.kind === "release" &&
			operation.betaVersion !== entry.derivedFromBeta
		) {
			error(
				"C-7",
				`releaseOps[${releaseId}].betaVersion`,
				"must equal its version derivedFromBeta",
			);
		}
	}
	for (const releaseId of committedOperationIds) {
		if (!releaseIdToVersion.has(releaseId)) {
			error(
				"C-7",
				`releaseOps[${releaseId}]`,
				"committed operation has no version entry",
			);
		}
	}

	if (tombstonesOk) {
		const seenTombstones = new Set();
		for (const tombstone of manifest.tombstones) {
			if (
				typeof tombstone !== "string" ||
				!/^payloads\/.+\.tgz$/.test(tombstone)
			) {
				error(
					"C-8",
					"tombstones",
					`invalid entry ${JSON.stringify(tombstone)}`,
				);
				continue;
			}
			if (seenTombstones.has(tombstone)) {
				error("C-8", "tombstones", `duplicate ${tombstone}`);
			}
			seenTombstones.add(tombstone);
			for (const [version, entry] of Object.entries(manifest.versions)) {
				if (entry?.key === tombstone && entry.status !== "expired") {
					error(
						"C-8",
						"tombstones",
						`${tombstone} is referenced by live versions[${version}]`,
					);
				}
			}
			for (const [releaseId, operation] of Object.entries(
				manifest.releaseOps,
			)) {
				if (operation?.objectKey !== tombstone) continue;
				if (operation.state === "abandoned") continue;
				if (operation.state === "committed") {
					const version = releaseIdToVersion.get(releaseId);
					if (version && manifest.versions[version]?.status === "expired")
						continue;
				}
				error(
					"C-8",
					"tombstones",
					`${tombstone} is referenced by live releaseOps[${releaseId}]`,
				);
			}
		}
	}

	return errors;
}

export function isEmptyInitialManifest(manifest) {
	return (
		validateManifest(manifest).length === 0 &&
		manifest.channels["internal-beta"].latest === null &&
		manifest.channels["customer-release"].latest === null &&
		Object.keys(manifest.versions).length === 0 &&
		Object.keys(manifest.releaseOps).length === 0 &&
		Object.keys(manifest.releaseLedger).length === 0 &&
		manifest.tombstones.length === 0
	);
}
