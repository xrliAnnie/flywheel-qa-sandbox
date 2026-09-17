import { randomUUID } from "node:crypto";
import { z } from "zod";
import { XiaohongshuTokenHandles } from "../lead-capabilities/xiaohongshu-tokens.js";
import { canonical } from "./canonical.js";
import type { FrozenWrite } from "./contracts.js";
import type { XhsProviderClient } from "./provider-client.js";
import {
	privateReadData,
	privateReadInputs,
	publicDetailInput,
} from "./provider-read-contract.js";
import type { WriteIdentity } from "./store.js";

const listOperation = z.enum([
	"search_feeds",
	"list_saved_content",
	"list_collections",
	"get_collection_content",
]);
export type ResourceListOperation = z.infer<typeof listOperation>;

const denied = (): never => {
	throw Error("target_unbound");
};
function binding(identity: WriteIdentity) {
	return {
		requesterUid: identity.requesterUid,
		projectId: identity.projectId,
		leadId: identity.leadId,
		authorityPolicyVersion: identity.authorityPolicyVersion,
		account: {
			providerInstanceId: identity.providerInstanceId,
			accountUserId: identity.accountUserId,
			accountEpoch: identity.accountEpoch,
			providerGeneration: identity.providerGeneration,
		},
	};
}

/** One authority-owned activation/account scope. Only a private provider read
 * registers resources; frozen content can neither mint nor recover tokens.
 * Disposal/restart loses these grants. Refresh must happen before a write lease.
 * Activation is attribution; the parent remains the current-activation authority. */
export class XhsReadResources {
	private readonly scope: ReturnType<typeof binding>;
	private readonly activationId: string;
	private readonly upstream: FrozenWrite["upstream"];
	private readonly tokens: XiaohongshuTokenHandles;
	private readonly targets = new Map<string, string>();
	private readonly comments = new Map<
		string,
		{ target: NonNullable<FrozenWrite["target"]>; tokenHandle: string }
	>();
	private closed = false;
	constructor(
		private readonly options: {
			identity: WriteIdentity;
			activationId: string;
			upstream: FrozenWrite["upstream"];
			assertCurrent: () => void;
			provider: Pick<XhsProviderClient, "readFeeds" | "read">;
		},
	) {
		if (!options.activationId || options.activationId.length > 256) denied();
		this.scope = binding(structuredClone(options.identity));
		this.activationId = options.activationId;
		this.upstream = structuredClone(options.upstream);
		this.tokens = new XiaohongshuTokenHandles(() => this.current());
	}
	private current() {
		try {
			if (this.closed) denied();
			this.options.assertCurrent();
		} catch {
			denied();
		}
	}
	async readFeeds(signal?: AbortSignal): Promise<string> {
		try {
			this.current();
			signal?.throwIfAborted();
			const result = await this.options.provider.readFeeds(
				{ account: this.scope.account, upstream: this.upstream },
				signal,
			);
			return this.projectList("list_feeds", result, signal);
		} catch {
			return denied();
		}
	}
	async readList(
		operation: ResourceListOperation,
		input: unknown,
		signal?: AbortSignal,
	): Promise<string> {
		try {
			this.current();
			signal?.throwIfAborted();
			const action = listOperation.parse(operation);
			const normalized = privateReadInputs[action].parse(input);
			const result = await this.options.provider.read(
				action,
				normalized,
				{ account: this.scope.account, upstream: this.upstream },
				signal,
			);
			return this.projectList(action, result, signal);
		} catch {
			return denied();
		}
	}
	async readDetail(input: unknown, signal?: AbortSignal): Promise<string> {
		try {
			this.current();
			signal?.throwIfAborted();
			const { resourceHandle, ...request } = publicDetailInput.parse(input);
			if (this.targets.get(resourceHandle) !== request.feed_id) return denied();
			const token = this.tokens.resolve(resourceHandle, request.feed_id);
			const result = await this.options.provider.read(
				"get_feed_detail",
				{ ...request, xsec_token: token },
				{ account: this.scope.account, upstream: this.upstream },
				signal,
			);
			this.current();
			signal?.throwIfAborted();
			if (
				canonical(result.account) !== canonical(this.scope.account) ||
				canonical(result.upstream) !== canonical(this.upstream)
			)
				return denied();
			const data = privateReadData.get_feed_detail.parse(result.data);
			if (
				data.feed_id !== request.feed_id ||
				data.data.note.noteId !== request.feed_id
			)
				return denied();
			const projected = JSON.parse(this.tokens.project(JSON.stringify(data)));
			const detailHandle = projected.data.note.resourceHandle ?? resourceHandle;
			this.tokens.resolve(detailHandle, request.feed_id);
			projected.data.note.resourceHandle = detailHandle;
			const staged = new Map(this.comments);
			const selected = new Set<string>();
			const id = privateReadInputs.get_feed_detail.shape.feed_id;
			const visit = (raw: unknown, depth = 0): unknown => {
				if (depth > 32) denied();
				const rows = z
					.array(z.record(z.string(), z.unknown()))
					.max(512)
					.nullable()
					.parse(raw);
				for (const row of rows ?? []) {
					if (row.noteId !== request.feed_id) denied();
					const user = z.record(z.string(), z.unknown()).parse(row.userInfo);
					const target = {
						feedId: request.feed_id,
						commentId: id.parse(row.id),
						userId: user.userId === "" ? null : id.parse(user.userId),
					};
					const previous = [...staged].find(
						([, record]) =>
							record.tokenHandle === detailHandle &&
							canonical(record.target) === canonical(target),
					);
					const handle = previous?.[0] ?? randomUUID();
					selected.add(handle);
					if (selected.size > 512) denied();
					staged.delete(handle);
					staged.set(handle, { target, tokenHandle: detailHandle });
					row.resourceHandle = handle;
					row.subComments = visit(row.subComments, depth + 1);
				}
				return rows;
			};
			projected.data.comments.list = visit(projected.data.comments.list);
			const output = JSON.stringify(projected);
			if (Buffer.byteLength(output) > 196608) denied();
			this.current();
			signal?.throwIfAborted();
			this.tokens.resolve(detailHandle, request.feed_id);
			this.targets.delete(detailHandle);
			this.targets.set(detailHandle, request.feed_id);
			while (this.targets.size > 512)
				this.targets.delete(this.targets.keys().next().value!);
			while (staged.size > 512) staged.delete(staged.keys().next().value!);
			this.comments.clear();
			for (const [handle, record] of staged) this.comments.set(handle, record);
			return output;
		} catch {
			return denied();
		}
	}

	private projectList(
		operation: ResourceListOperation | "list_feeds",
		result: {
			account: FrozenWrite["account"];
			upstream: FrozenWrite["upstream"];
			data: unknown;
		},
		signal?: AbortSignal,
	): string {
		this.current();
		signal?.throwIfAborted();
		if (
			canonical(result.account) !== canonical(this.scope.account) ||
			canonical(result.upstream) !== canonical(this.upstream)
		)
			denied();
		const data = privateReadData[operation].parse(result.data);
		const output = this.tokens.project(JSON.stringify(data));
		const projected = JSON.parse(output);
		const additions: [string, string][] = [];
		if (!Array.isArray(data)) {
			const collection = "notes" in data;
			const originals = collection ? data.notes : data.feeds;
			const rows = collection ? projected.notes : projected.feeds;
			const idKey = collection ? "noteId" : "id";
			for (const [index, original] of (originals ?? []).entries()) {
				const row = rows[index];
				if (typeof row.resourceHandle !== "string") continue;
				const id = original[idKey];
				if (typeof id !== "string" || id !== row[idKey]) return denied();
				// Only root note rows are write targets; nested user handles are not.
				this.tokens.resolve(row.resourceHandle, id);
				additions.push([row.resourceHandle, id]);
			}
		}
		this.current();
		signal?.throwIfAborted();
		for (const [handle, id] of additions) {
			this.targets.delete(handle);
			this.targets.set(handle, id);
		}
		while (this.targets.size > 512)
			this.targets.delete(this.targets.keys().next().value!);
		return output;
	}

	target(
		identity: WriteIdentity,
		handle: string,
		activationId: string,
	): FrozenWrite["target"] {
		try {
			this.current();
			if (
				activationId !== this.activationId ||
				canonical(binding(identity)) !== canonical(this.scope)
			)
				denied();
			const comment = this.comments.get(handle);
			if (comment) {
				this.tokens.resolve(comment.tokenHandle, comment.target.feedId);
				return structuredClone(comment.target);
			}
			const feedId = this.targets.get(handle);
			if (!feedId) return denied();
			this.tokens.resolve(handle, feedId);
			return { feedId, commentId: null, userId: null };
		} catch {
			return denied();
		}
	}
	token(context: { frozen: FrozenWrite; activationId: string }): string {
		try {
			this.current();
			const f = context.frozen;
			if (
				context.activationId !== this.activationId ||
				canonical({
					requesterUid: f.requesterUid,
					projectId: f.projectId,
					leadId: f.leadId,
					authorityPolicyVersion: f.authorityPolicyVersion,
					account: f.account,
				}) !== canonical(this.scope) ||
				canonical(f.upstream) !== canonical(this.upstream) ||
				!f.target
			)
				denied();
			if (f.target!.commentId !== null || f.target!.userId !== null) {
				for (const record of [...this.comments.values()].reverse()) {
					if (canonical(record.target) === canonical(f.target))
						return this.tokens.resolve(
							record.tokenHandle,
							record.target.feedId,
						);
				}
				return denied();
			}
			for (const [handle, feedId] of [...this.targets].reverse())
				if (feedId === f.target!.feedId)
					return this.tokens.resolve(handle, feedId);
			return denied();
		} catch {
			return denied();
		}
	}
	close() {
		this.closed = true;
		this.targets.clear();
		this.comments.clear();
		this.tokens.close();
	}
}
