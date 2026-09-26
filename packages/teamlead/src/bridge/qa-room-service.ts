import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	parseRoomDeploy,
	parseRoomTeardown,
	QaRoomError,
	roomRequestDigest,
	withoutRoomCredential,
} from "./qa-room-contract.js";
import type { QaRoomRuntime } from "./qa-room-runtime.js";
import {
	QA_ROOM_TERMINAL,
	type QaRoom,
	type QaRoomAudit,
	type QaRoomOperation,
	type QaRoomStatus,
	type QaRoomStore,
} from "./qa-room-store.js";

export interface QaRoomActor {
	key: string;
	issue: string | null;
	lead: boolean;
}
interface Options {
	store: QaRoomStore;
	runtime: QaRoomRuntime;
	stateRoot: string;
	slotCount: number;
	now: () => number;
	load: () => number;
	threshold: () => number;
	ownerTerminal: (actorKey: string) => boolean;
	enabled: () => boolean;
	onError?: (reason: string) => void;
}
const activeOperation = (op: QaRoomOperation) =>
	op.status === "running" || op.status === "spawning";
const jobReason = (error: unknown) =>
	error instanceof QaRoomError
		? error.reason
		: error instanceof Error &&
				[
					"build_sha_mismatch",
					"invalid_room_json",
					"health_unavailable",
					"claim_mismatch",
				].includes(error.message)
			? error.message
			: "operation_failed";

export class QaRoomService {
	private timer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private work?: Promise<void>;
	constructor(private readonly options: Options) {}
	private get store() {
		return this.options.store;
	}
	private now() {
		return new Date(this.options.now()).toISOString();
	}
	start(): void {
		if (this.timer) return;
		const run = () => {
			if (this.ticking) return;
			this.work = this.tick().catch(() =>
				this.options.onError?.("room_tick_failed"),
			);
		};
		run();
		this.timer = setInterval(run, 5000);
		this.timer.unref();
	}
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.work;
	}

	refuse(
		actor: QaRoomActor,
		action: "deploy" | "teardown",
		reason: string,
		input: unknown,
		roomId: string | null = null,
	): void {
		this.store.audit({
			at: this.now(),
			actor_key: actor.key,
			actor_issue: actor.issue,
			action,
			room_id: roomId,
			slot: null,
			decision: "refused",
			reason,
			head: null,
			request_digest: roomRequestDigest(action, input),
		});
	}
	private enabled() {
		if (!this.options.enabled())
			throw new QaRoomError("room_service_disabled", 503);
	}
	private mutation<T>(
		actor: QaRoomActor,
		action: "deploy" | "teardown",
		input: unknown,
		roomId: string | null,
		fn: () => T,
	): T {
		try {
			this.enabled();
			return fn();
		} catch (error) {
			const reason =
				error instanceof QaRoomError ? error.reason : "room_store_conflict";
			this.refuse(actor, action, reason, input, roomId);
			throw error instanceof QaRoomError ? error : new QaRoomError(reason, 409);
		}
	}
	private audit(
		actor: QaRoomActor,
		room: QaRoom,
		op: QaRoomOperation,
		decision: QaRoomAudit["decision"],
		reason: string | null = null,
	): QaRoomAudit {
		return {
			at: this.now(),
			actor_key: actor.key,
			actor_issue: actor.issue,
			action: op.kind,
			room_id: room.room_id,
			slot: room.slot,
			decision,
			reason,
			head: room.head,
			request_digest: op.request_digest,
		};
	}
	private operation(
		actor: QaRoomActor,
		roomId: string,
		kind: QaRoomOperation["kind"],
		body: { request_id: string },
		attempt: number,
	): QaRoomOperation {
		const id = randomUUID();
		const now = this.now();
		return {
			operation_id: id,
			room_id: roomId,
			kind,
			actor_key: actor.key,
			request_id: body.request_id,
			request_digest: roomRequestDigest(kind, { ...body, room_id: roomId }),
			attempt,
			status: "queued",
			operation_dir: join(this.options.stateRoot, roomId, "ops", id),
			pid: null,
			residue_check: null,
			request_json: JSON.stringify(body),
			queued_at: now,
			created_at: now,
			started_at: null,
			finished_at: null,
		};
	}
	deploy(actor: QaRoomActor, input: unknown) {
		return this.mutation(actor, "deploy", input, null, () => {
			const body = withoutRoomCredential(
				parseRoomDeploy(input, this.options.slotCount),
			);
			const digest = roomRequestDigest("deploy", body);
			const existing = this.store.findRequest(actor.key, body.request_id);
			if (existing) {
				if (existing.request_digest !== digest || existing.kind !== "deploy")
					throw new QaRoomError("request_conflict", 409);
				return this.view(this.room(existing.room_id), existing);
			}
			if (
				!actor.lead &&
				this.store
					.rooms()
					.some(
						(r) =>
							r.owner_actor_key === actor.key &&
							!QA_ROOM_TERMINAL.has(r.status),
					)
			)
				throw new QaRoomError("actor_has_room", 409);
			const reserved = new Set(this.store.reservedSlots());
			const extra = body.extra_leads.map((e) => e.slot);
			const free = (slot: number) =>
				!reserved.has(slot) && !this.options.runtime.occupied(slot);
			const slot =
				body.slot === "auto"
					? Array.from(
							{
								length:
									body.mode === "mirror"
										? Math.min(3, this.options.slotCount)
										: this.options.slotCount,
							},
							(_, i) => i + 1,
						).find((s) => !extra.includes(s) && free(s))
					: body.slot;
			if (slot === undefined || !free(slot) || extra.some((s) => !free(s)))
				throw new QaRoomError("slot_unavailable", 409);
			const roomId = randomUUID();
			const now = this.now();
			const room: QaRoom = {
				room_id: roomId,
				status: "queued",
				status_reason: null,
				owner_actor_key: actor.key,
				owner_issue: actor.issue,
				head: body.head,
				slot,
				claim_token: randomUUID(),
				physically_claimed: 0,
				release_state: "held",
				src_dir: join(this.options.stateRoot, roomId, "src"),
				deploy_json: null,
				evidence_dir: null,
				request_json: JSON.stringify(body),
				created_at: now,
				updated_at: now,
			};
			const op = this.operation(actor, roomId, "deploy", body, 1);
			op.request_digest = digest;
			this.store.accept(
				room,
				op,
				[slot, ...extra].sort((a, b) => a - b),
				this.audit(actor, room, op, "accepted"),
			);
			return this.status(actor, roomId);
		});
	}
	teardown(actor: QaRoomActor, roomId: string, input: unknown) {
		return this.mutation(actor, "teardown", input, roomId, () => {
			const body = withoutRoomCredential(parseRoomTeardown(input));
			const room = this.room(roomId);
			const takeover = !actor.lead && actor.key !== room.owner_actor_key;
			if (
				takeover &&
				!(
					actor.issue !== null &&
					actor.issue === room.owner_issue &&
					this.options.ownerTerminal(room.owner_actor_key)
				)
			)
				throw new QaRoomError("room_not_owned", 403);
			const digest = roomRequestDigest("teardown", {
				...body,
				room_id: roomId,
			});
			const existing = this.store.findRequest(actor.key, body.request_id);
			if (existing) {
				if (
					existing.request_digest !== digest ||
					existing.room_id !== roomId ||
					existing.kind !== "teardown"
				)
					throw new QaRoomError("request_conflict", 409);
				return this.view(room, existing);
			}
			if (
				!["ready", "failed", "interrupted", "teardown_failed"].includes(
					room.status,
				) ||
				room.physically_claimed !== 1
			)
				throw new QaRoomError("room_not_teardownable", 409);
			const attempt =
				this.store.operations(roomId).filter((o) => o.kind === "teardown")
					.length + 1;
			const op = this.operation(actor, roomId, "teardown", body, attempt);
			this.store.transaction(() => {
				this.store.addOperation(op);
				this.store.updateRoom(roomId, {
					status: "tearing_down",
					status_reason: null,
					release_state: "held",
					updated_at: this.now(),
				});
				this.store.audit(
					this.audit(
						actor,
						room,
						op,
						"accepted",
						takeover
							? `takeover_from=${room.owner_actor_key}`
							: body.skip_snapshot
								? `skip_snapshot:${body.reason}`
								: null,
					),
				);
			});
			return this.status(actor, roomId);
		});
	}
	private room(id: string): QaRoom {
		const room = this.store.getRoom(id);
		if (!room) throw new QaRoomError("room_not_found", 404);
		return room;
	}
	status(actor: QaRoomActor, id: string) {
		const room = this.room(id);
		if (
			!actor.lead &&
			(actor.issue === null || actor.issue !== room.owner_issue)
		)
			throw new QaRoomError("room_not_visible", 403);
		return this.view(room);
	}
	list(actor: QaRoomActor) {
		return this.store
			.rooms()
			.filter(
				(r) =>
					actor.lead || (actor.issue !== null && r.owner_issue === actor.issue),
			)
			.map((r) => this.view(r));
	}
	private view(room: QaRoom, operation?: QaRoomOperation) {
		const op = operation ?? this.store.operations(room.room_id).at(-1);
		const pressure =
			room.status === "queued" &&
			this.options.load() >= this.options.threshold();
		return {
			ok: true,
			room_id: room.room_id,
			operation_id: op?.operation_id,
			operation_status: op?.status,
			status: room.status,
			status_reason: room.status_reason,
			head: room.head,
			slot: room.slot,
			owner_actor_key: room.owner_actor_key,
			owner_issue: room.owner_issue,
			owner_terminal: this.options.ownerTerminal(room.owner_actor_key),
			roomInfo: room.deploy_json ? JSON.parse(room.deploy_json) : null,
			evidence_dir: room.evidence_dir,
			residue_check: op?.residue_check ? JSON.parse(op.residue_check) : null,
			log_tail: op ? this.options.runtime.logTail(op) : [],
			queue_reason: pressure
				? "load_pressure"
				: room.status === "queued"
					? "waiting_for_deploy"
					: null,
			...(pressure
				? { load1: this.options.load(), threshold: this.options.threshold() }
				: {}),
			recovery_hint:
				room.status_reason === "snapshot_failed"
					? "Inspect the previous evidence_dir; retry room teardown --skip-snapshot --reason <reason> only when deliberately omitting the missing snapshot."
					: null,
		};
	}
	private settle(
		room: QaRoom,
		op: QaRoomOperation,
		status: QaRoomStatus,
		reason: string | null,
	): void {
		const succeeded = status === "ready" || status === "torn_down";
		this.store.transaction(() => {
			this.store.updateRoom(room.room_id, {
				status,
				status_reason: reason,
				updated_at: this.now(),
			});
			this.store.updateOperation(op.operation_id, {
				status: succeeded
					? "succeeded"
					: status === "refused"
						? "refused"
						: "failed",
				finished_at: this.now(),
			});
			if (status === "refused") this.store.releaseReservations(room.room_id);
			this.store.audit(
				this.audit(
					{
						key: op.actor_key,
						issue: room.owner_issue,
						lead: op.actor_key.startsWith("lead:"),
					},
					room,
					op,
					succeeded ? "completed" : "failed",
					reason,
				),
			);
		});
	}
	private async release(room: QaRoom, op: QaRoomOperation): Promise<void> {
		this.store.updateRoom(room.room_id, {
			release_state: "releasing",
			updated_at: this.now(),
		});
		const conflicts = this.options.runtime.release(
			room,
			this.store.reservedSlots(room.room_id),
		);
		if (conflicts.length) {
			this.store.updateRoom(room.room_id, { release_state: "held" });
			this.settle(room, op, "teardown_failed", "release_conflict");
			return;
		}
		try {
			await this.options.runtime.removeSource(room);
		} catch {
			this.store.updateRoom(room.room_id, {
				status_reason: "source_cleanup_failed",
				updated_at: this.now(),
			});
			return;
		}
		this.store.transaction(() => {
			this.store.updateRoom(room.room_id, {
				release_state: "released",
				physically_claimed: 0,
			});
			this.store.releaseReservations(room.room_id);
			this.settle(
				room,
				op,
				op.kind === "deploy" ? "released" : "torn_down",
				op.kind === "deploy" ? "prepare_failed" : null,
			);
		});
	}
	private async poll(room: QaRoom, op: QaRoomOperation): Promise<void> {
		const observed = await this.options.runtime.observe(op);
		const evidence = this.options.runtime.evidence(op);
		if (evidence)
			this.store.updateRoom(room.room_id, { evidence_dir: evidence });
		const receipt = observed.receipt;
		if (receipt?.operation_id === op.operation_id) {
			if (op.kind === "deploy") {
				if (receipt.phase_reached === "prepare" && receipt.exit_code !== 0) {
					await this.release(room, op);
					return;
				}
				if (receipt.phase_reached !== "deploy" || receipt.exit_code !== 0) {
					this.settle(room, op, "failed", "deploy_failed");
					return;
				}
				try {
					const info = await this.options.runtime.verifyDeploy(room, op);
					this.store.updateRoom(room.room_id, {
						deploy_json: JSON.stringify(info),
					});
					this.settle(room, op, "ready", null);
				} catch (error) {
					this.settle(room, op, "failed", jobReason(error));
				}
			} else {
				if (receipt.phase_reached !== "teardown" || receipt.exit_code !== 0) {
					this.settle(
						room,
						op,
						"teardown_failed",
						receipt.phase_reached === "snapshot"
							? "snapshot_failed"
							: "teardown_failed",
					);
					return;
				}
				const residue = await this.options.runtime.residue(
					room,
					this.store.reservedSlots(room.room_id),
				);
				this.store.updateOperation(op.operation_id, {
					residue_check: JSON.stringify(residue),
				});
				if (!residue.ok) {
					this.settle(room, op, "teardown_failed", "residue");
					return;
				}
				await this.release(room, op);
			}
			return;
		}
		if (
			this.options.now() - Date.parse(op.started_at ?? op.created_at) >=
			(op.kind === "deploy" ? 45 : 15) * 60_000
		) {
			await this.options.runtime.terminate(op);
			this.settle(
				room,
				op,
				op.kind === "deploy" ? "failed" : "teardown_failed",
				"timeout",
			);
			return;
		}
		if (!observed.alive) {
			this.settle(
				room,
				op,
				op.kind === "deploy" ? "interrupted" : "teardown_failed",
				"interrupted",
			);
			return;
		}
		if (
			op.kind === "deploy" &&
			observed.phase === "deploy" &&
			room.status !== "deploying"
		)
			this.store.updateRoom(room.room_id, {
				status: "deploying",
				updated_at: this.now(),
			});
	}
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			for (const room of this.store
				.rooms()
				.filter(
					(r) =>
						r.release_state === "releasing" && !QA_ROOM_TERMINAL.has(r.status),
				)) {
				const op = this.store.operations(room.room_id).at(-1);
				if (op) await this.release(room, op);
			}
			for (const op of this.store.operations().filter(activeOperation)) {
				const room = this.room(op.room_id);
				if (room.release_state !== "releasing") await this.poll(room, op);
			}
			if (!this.options.enabled()) return;
			for (const op of this.store
				.operations()
				.filter((o) => o.status === "queued")) {
				const room = this.room(op.room_id);
				if (
					op.kind === "deploy" &&
					this.options.now() - Date.parse(op.queued_at) >= 60 * 60_000
				) {
					// Also reconcile claims written before a crash preceding the spawning transaction.
					this.options.runtime.release(
						room,
						this.store.reservedSlots(room.room_id),
					);
					this.settle(room, op, "refused", "load_gate_timeout");
					continue;
				}
				if (
					this.store
						.operations()
						.some((o) => o.kind === op.kind && activeOperation(o))
				)
					continue;
				if (
					op.kind === "deploy" &&
					this.options.load() >= this.options.threshold()
				)
					continue;
				if (
					op.kind === "deploy" &&
					!this.options.runtime.claim(
						room,
						this.store.reservedSlots(room.room_id),
					)
				) {
					this.settle(room, op, "refused", "slot_taken_while_queued");
					continue;
				}
				this.store.transaction(() => {
					this.store.updateRoom(room.room_id, {
						status: op.kind === "deploy" ? "preparing" : "tearing_down",
						physically_claimed: 1,
						updated_at: this.now(),
					});
					this.store.updateOperation(op.operation_id, {
						status: "spawning",
						started_at: this.now(),
					});
				});
				let pid: number | undefined;
				try {
					pid = this.options.runtime.start(
						this.room(room.room_id),
						this.store.getOperation(op.operation_id)!,
					);
					this.store.updateOperation(op.operation_id, {
						status: "running",
						pid,
					});
				} catch {
					if (pid !== undefined)
						await this.options.runtime.terminate({ ...op, pid });
					this.settle(
						room,
						op,
						op.kind === "deploy" ? "interrupted" : "teardown_failed",
						pid !== undefined ? "spawn_record_failed" : "spawn_failed",
					);
				}
			}
		} finally {
			this.ticking = false;
		}
	}
}
