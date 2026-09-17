import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { LeadArtifactStore } from "../lead-capabilities/artifacts.js";
import { artifactSchema } from "../xiaohongshu-write/contracts.js";
import {
	measureXhsStagingLeftovers,
	XHS_STAGING_BYTES,
	XhsStagingLeftoversError,
} from "./xhs-staging-leftovers.js";
import {
	acquireXhsStagingOwner,
	type XhsStagingOwner,
} from "./xhs-staging-owner.js";

const id = z.string().min(1).max(256);
const scopeSchema = z
	.object({ projectId: id, leadId: id, activationId: id })
	.strict();
type Scope = z.infer<typeof scopeSchema>;
type Entry = {
	store: LeadArtifactStore | null;
	root: string;
	rootDev: number;
	rootIno: number;
	projectRoot: string;
	projectDev: number;
	projectIno: number;
};
const denied = () => Error("xhs_artifact_unavailable");
/** Bounded parent staging, separate from the authority's durable frozen media.
 * Only a validated current context supplies the project root; callers get no paths. */
export class XhsBridgeArtifactRegistry {
	private readonly entries = new Map<string, Entry>();
	private bytes = 0;
	private readonly projects = new Map<
		string,
		{
			owner?: XhsStagingOwner;
			pending: Promise<XhsStagingOwner>;
			bytes: number;
		}
	>();
	private closing: Promise<void> | undefined;
	private async projectOwner(root: string) {
		let entry = this.projects.get(root);
		if (!entry) {
			if (this.projects.size >= 64) throw denied();
			const created = {
				pending: acquireXhsStagingOwner(root),
				bytes: 0,
				owner: undefined as XhsStagingOwner | undefined,
			};
			this.projects.set(root, created);
			entry = created;
			created.pending = created.pending
				.then((owner) => {
					created.owner = owner;
					return owner;
				})
				.catch((error) => {
					if (this.projects.get(root) === created) this.projects.delete(root);
					throw error;
				});
		}
		await entry.pending;
		if (this.closed) throw denied();
		entry.owner!.assertCurrent();
		return entry;
	}
	private closed = false;
	private key(input: Scope) {
		return JSON.stringify(scopeSchema.parse(input));
	}
	forScope(scope: Scope): Pick<LeadArtifactStore, "read"> {
		const key = this.key(scope);
		if (this.closed || !this.entries.has(key)) throw denied();
		return {
			read: async (handle) => {
				if (this.closed) throw denied();
				const entry = this.entries.get(key);
				if (!entry?.store) throw denied();
				const project = this.projects.get(entry.projectRoot);
				if (!project?.owner) throw denied();
				project.owner.assertCurrent();
				return entry.store.read(handle);
			},
		};
	}
	async put(
		context: { scope: Scope; projectRoot: string; assertCurrent(): void },
		input: Uint8Array,
		mime: string,
	) {
		try {
			if (
				this.closed ||
				!(input instanceof Uint8Array) ||
				input.byteLength === 0 ||
				input.byteLength > 10 * 1024 * 1024 ||
				this.bytes + input.byteLength > 256 * 1024 * 1024
			)
				throw denied();
			const mimeType = artifactSchema.shape.mimeType.parse(mime);
			const data = Buffer.from(input);
			const key = this.key(context.scope);
			context.assertCurrent();
			const projectRoot = context.projectRoot;
			if (!isAbsolute(projectRoot) || realpathSync(projectRoot) !== projectRoot)
				throw denied();
			const projectOwner = await this.projectOwner(projectRoot);
			context.assertCurrent();
			const leftovers = measureXhsStagingLeftovers(
				projectRoot,
				[...this.entries.values()]
					.filter((entry) => entry.projectRoot === projectRoot)
					.map((entry) => ({
						path: entry.root,
						dev: entry.rootDev,
						ino: entry.rootIno,
					})),
			);
			if (
				leftovers.bytes + projectOwner.bytes + data.length >
				XHS_STAGING_BYTES
			)
				throw new XhsStagingLeftoversError(leftovers.paths);
			if (this.bytes + data.length > XHS_STAGING_BYTES) throw denied();
			let entry = this.entries.get(key);
			if (!entry) {
				if (this.entries.size >= 64) throw denied();
				const project = lstatSync(projectRoot);
				if (!project.isDirectory()) throw denied();
				const root = mkdtempSync(join(projectRoot, ".flywheel-xhs-artifact-"));
				const stat = lstatSync(root);

				entry = {
					store: null,
					root,
					rootDev: stat.dev,
					rootIno: stat.ino,
					projectRoot,
					projectDev: project.dev,
					projectIno: project.ino,
				};
				this.entries.set(key, entry);
				entry.store = new LeadArtifactStore({
					projectRoot,
					artifactRoot: root,
					assertCurrent: () => {
						if (this.closed) throw denied();
						projectOwner.owner!.assertCurrent();
						context.assertCurrent();
					},
				});
			}
			if (!entry.store || entry.projectRoot !== projectRoot) throw denied();
			// A failed write may have left staging bytes. Keep its reservation until close.
			this.bytes += data.length;
			projectOwner.bytes += data.length;
			const artifact =
				mimeType === "video/mp4"
					? await entry.store.putVideo(
							(async function* () {
								yield data;
							})(),
						)
					: await entry.store.put(data, mimeType);
			context.assertCurrent();
			projectOwner.owner!.assertCurrent();
			if (this.closed) throw denied();
			return {
				handle: artifact.handle,
				mimeType: artifact.mimeType,
				size: artifact.size,
				sha256: artifact.sha256,
			};
		} catch (error) {
			if (error instanceof XhsStagingLeftoversError) {
				console.warn(
					"xhs_staging_leftovers_retained",
					JSON.stringify({
						projectRoot: context.projectRoot,
						paths: error.paths,
						code: error.message,
					}),
				);
				throw error;
			}
			throw denied();
		}
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = this.closeOwned().catch((error) => {
			this.closing = undefined;
			throw error;
		});
		return this.closing;
	}
	private async closeOwned(): Promise<void> {
		await Promise.allSettled(
			[...this.projects.values()].map((entry) => entry.pending),
		);
		for (const [key, entry] of this.entries) {
			entry.store?.close();
			try {
				const owner = this.projects.get(entry.projectRoot)?.owner;
				if (!owner) throw denied();
				owner.assertCurrent();
				const project = lstatSync(entry.projectRoot),
					root = lstatSync(entry.root);
				if (
					!project.isDirectory() ||
					project.dev !== entry.projectDev ||
					project.ino !== entry.projectIno ||
					!root.isDirectory() ||
					root.dev !== entry.rootDev ||
					root.ino !== entry.rootIno ||
					root.uid !== process.getuid?.() ||
					(root.mode & 0o777) !== 0o700
				)
					throw denied();
				rmSync(entry.root, { recursive: true });
				this.entries.delete(key);
			} catch {
				/* Unconfirmed directories are retained and close may be retried. */
			}
		}
		for (const [root, project] of this.projects) {
			if (
				[...this.entries.values()].some((entry) => entry.projectRoot === root)
			)
				continue;
			try {
				await project.owner?.close();
				this.projects.delete(root);
			} catch {
				/* Preserve failed release for retry. */
			}
		}
		if (this.entries.size || this.projects.size)
			throw Error("xhs_artifact_cleanup_unconfirmed");
		this.bytes = 0;
	}
}
