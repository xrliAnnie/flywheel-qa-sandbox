export type ChannelPointerName = "internal-beta" | "customer-release";
export type Channel = "beta" | "release";
export type Entitlement = "internal" | "customer";
export type VersionStatus = "active" | "quarantined" | "expired";
export type ReleaseOperationState =
	| "reserved"
	| "prepared"
	| "committed"
	| "abandoned";
export type ReleaseOperationKind = "beta" | "release";

export interface ChannelPointer {
	latest: string | null;
}

export interface ManifestChannels {
	"internal-beta": ChannelPointer;
	"customer-release": ChannelPointer;
}

export interface VersionEntry {
	sha256: string;
	key: string;
	size: number;
	publishedAt: string;
	channel: Channel;
	status: VersionStatus;
	sourceCommit: string;
	releaseId: string;
	derivedFromBeta: string | null;
	retentionSince: string | null;
	quarantinedAt: string | null;
}

interface BetaOperationIdentity {
	kind: "beta";
	ver: string;
	betaVersion: null;
}

interface CleanReleaseOperationIdentity {
	kind: "release";
	ver: string;
	betaVersion: string;
}

type OperationIdentity = BetaOperationIdentity | CleanReleaseOperationIdentity;

interface OperationCommon {
	createdAt: string;
}

type ObjectTuple =
	| { sha256: null; objectKey: null }
	| { sha256: string; objectKey: string };

type MutableTuple = { sourceCommit: string | null } & ObjectTuple;

interface CompleteTuple {
	sourceCommit: string;
	sha256: string;
	objectKey: string;
}

export type ReservedReleaseOp = OperationCommon &
	OperationIdentity &
	MutableTuple & { state: "reserved" };

export type PreparedReleaseOp = OperationCommon &
	OperationIdentity &
	CompleteTuple & { state: "prepared" };

export type CommittedReleaseOp = OperationCommon &
	OperationIdentity &
	CompleteTuple & { state: "committed" };

export type AbandonedReleaseOp = OperationCommon &
	OperationIdentity &
	MutableTuple & { state: "abandoned" };

export type ReleaseOp =
	| ReservedReleaseOp
	| PreparedReleaseOp
	| CommittedReleaseOp
	| AbandonedReleaseOp;

export interface ReleaseLedgerRecord {
	nextBetaN: number;
}

export interface Manifest {
	schemaVersion: 1;
	channels: ManifestChannels;
	versions: Record<string, VersionEntry>;
	releaseOps: Record<string, ReleaseOp>;
	releaseLedger: Record<string, ReleaseLedgerRecord>;
	tombstones: string[];
}

export interface BetaCandidate {
	baseVersion: string;
	betaN: number;
	betaVersion: string;
	sourceCommit: string;
	betaPayloadSha256: string;
}

export interface ReleaseArtifact {
	releaseId: string;
	releaseVersion: string;
	sourceCommit: string;
	releasePayloadSha256: string;
	objectKey: string;
}

export interface VetoBinding {
	releaseId: string;
	betaVersion: string;
	betaPayloadSha256: string;
	releaseVersion: string;
	releasePayloadSha256: string;
	sourceCommit: string;
}

export type ParsedPayloadVersion =
	| { kind: "clean"; base: string; betaN: null }
	| { kind: "beta"; base: string; betaN: number };

export const BASE_RE: RegExp;
export const CLEAN_SEMVER_RE: RegExp;
export const BETA_SEMVER_RE: RegExp;
export const CHANNELS: ChannelPointerName[];
export const CHANNEL_OF_POINTER: Record<ChannelPointerName, Channel>;
export const ENTITLEMENT_POINTER: Record<Entitlement, ChannelPointerName>;
export const POINTER_CAPABILITY: Record<
	ChannelPointerName,
	"beta-publish" | "customer-release"
>;
export const VERSION_STATUSES: VersionStatus[];
export const OP_STATES: ReleaseOperationState[];
export const OP_KINDS: ReleaseOperationKind[];
export const RETENTION_WINDOW_MS: Record<Channel, number>;

export function parsePayloadVersion(
	value: unknown,
): ParsedPayloadVersion | null;
export function isCleanSemver(value: unknown): value is string;
export function isBetaSemver(value: unknown): value is string;
export function isPayloadSemver(value: unknown): value is string;
export function baseOf(value: unknown): string;
export function isDerivationOf(
	baseVersion: unknown,
	payloadVersion: unknown,
): boolean;
export function normalizeVersionFile(text: unknown): string;
export function toDisplayLabel(payloadVersion: unknown): string;
export function isHex(value: unknown, length: number): value is string;
export function isIso(value: unknown): value is string;
export function payloadObjectKey(
	payloadVersion: unknown,
	sha256: unknown,
): string;
export function emptyManifest(): Manifest;
export function latestSet(manifest: unknown): Set<string>;
export function validateManifest(manifest: unknown): string[];
export function isEmptyInitialManifest(manifest: unknown): manifest is Manifest;
export function deriveBetaCandidate(
	manifest: Manifest,
	betaVersion: string,
): BetaCandidate;
export function deriveReleaseArtifact(
	manifest: Manifest,
	releaseId: string,
): ReleaseArtifact;
export function deriveVetoBinding(
	manifest: Manifest,
	releaseId: string,
): VetoBinding;
