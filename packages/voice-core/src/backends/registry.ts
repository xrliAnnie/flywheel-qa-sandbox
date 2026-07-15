/**
 * Backend registry — id → factory. Unknown id fails fast; and a backend whose
 * declared capability face is not backed by the matching factory method
 * (announce→createAnnouncer, converse→createConversation) also fails fast
 * (plan.md r2 §3 registry contract). This is the vendor-neutral seam: the upper
 * layer picks a backend by id / face and never imports a concrete backend.
 */
import { type VoiceBackend, VoiceError } from "../types.js";

export type BackendFactory = () => VoiceBackend | Promise<VoiceBackend>;

export function assertBackendConsistent(b: VoiceBackend): void {
	if (b.capabilities.announce && typeof b.createAnnouncer !== "function") {
		throw new VoiceError(
			"unsupported",
			`backend "${b.id}" declares announce=true but has no createAnnouncer`,
		);
	}
	if (b.capabilities.converse && typeof b.createConversation !== "function") {
		throw new VoiceError(
			"unsupported",
			`backend "${b.id}" declares converse=true but has no createConversation`,
		);
	}
}

export class BackendRegistry {
	private readonly factories = new Map<string, BackendFactory>();

	register(id: string, factory: BackendFactory): void {
		this.factories.set(id, factory);
	}

	has(id: string): boolean {
		return this.factories.has(id);
	}

	ids(): string[] {
		return [...this.factories.keys()];
	}

	async create(id: string): Promise<VoiceBackend> {
		const factory = this.factories.get(id);
		if (!factory) {
			throw new VoiceError(
				"unsupported",
				`unknown voice backend "${id}" — registered: [${this.ids().join(", ") || "none"}]`,
			);
		}
		const backend = await factory();
		assertBackendConsistent(backend);
		return backend;
	}
}
