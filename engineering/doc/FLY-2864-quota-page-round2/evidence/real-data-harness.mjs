// FLY-2864 local real-data check: read-only probes into a temp dir, then render.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const W = process.argv[2];
const D = `${W}/packages/teamlead/dist`;
const { observeClaudeAccountDetails } = await import(`${D}/claude-quota/account-detail-observer.js`);
const { writeClaudeAccountDetailStore } = await import(`${D}/claude-quota/account-detail-store.js`);
const { observeCodexSubscriptions } = await import(`${D}/codex-quota/codex-subscription-reader.js`);
const { writeCodexSubscriptionStore } = await import(`${D}/codex-quota/codex-subscription-store.js`);
const { defaultCodexAccountQuotaStorePath } = await import(`${D}/codex-quota/codex-account-quota-store.js`);
const { buildCapacitySnapshot } = await import(`${D}/bridge/capacity-snapshot.js`);
const { buildAccountQuotaView } = await import(`${D}/bridge/account-quota-view.js`);
const { renderAccountQuotaPageHtml } = await import(`${D}/bridge/account-quota-page.js`);
const { loadCodexAccountPool } = await import(`${W}/packages/claude-runner/bin/codex-account-core.mjs`);

const out = mkdtempSync(join(process.argv[3] ?? tmpdir(), "fly2864-real-"));
const claudePool = join(homedir(), ".flywheel", "claude-profiles");
const codexHome = realpathSync(join(homedir(), ".codex"));
const codexProfiles = join(codexHome, "profiles");

const claude = await observeClaudeAccountDetails({ profilesRoot: claudePool });
const detailPath = join(out, "account-details.json");
writeClaudeAccountDetailStore(detailPath, claude);
const codex = await observeCodexSubscriptions({
	profilesRoot: codexProfiles,
	canonicalAuthPath: join(codexHome, "auth.json"),
	pool: () => loadCodexAccountPool({ profilesRoot: codexProfiles }),
});
const subsPath = join(out, "codex-subscriptions.json");
writeCodexSubscriptionStore(subsPath, codex);

const snapshot = await buildCapacitySnapshot({
	store: {
		getActiveSessions: () => [],
		getFleetPressureHold: () => undefined,
		getAdmissionPause: () => undefined,
	},
	readMemoryFreePct: async () => ({ freePct: 50, observedAt: new Date().toISOString() }),
	claudeAccountDetailStorePath: detailPath,
	codexSubscriptionStorePath: subsPath,
	codexAccountStorePath: defaultCodexAccountQuotaStorePath(),
});
const html = renderAccountQuotaPageHtml(buildAccountQuotaView(snapshot));
writeFileSync(join(out, "accounts-page.html"), html);
console.log(`OUT ${out}`);
console.log("CLAUDE", JSON.stringify(claude.accounts.map((a) => ({
	name: a.name, subscription: a.subscription, usageStatus: a.usageStatus, tier: a.tier ?? "(absent)",
	resetGrants: a.resetGrants ?? "(absent)", note: a.note,
})), null, 1));
console.log("CODEX", JSON.stringify(codex.accounts.map(({ identityKey, ...rest }) => ({ ...rest, identityKey: identityKey ? "<64hex>" : undefined })), null, 1));
