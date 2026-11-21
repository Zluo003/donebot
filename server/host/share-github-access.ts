import { createHash } from "node:crypto";
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import { GithubTemplateError } from "../share-github.ts";
import type { GithubConnection } from "../share-github-repo.ts";

export interface ShareGithubAccessDeps {
  cfg(): AppConfig;
  composio: Pick<typeof Composio, "configured" | "connectedServicesInventory" | "relayMcp" | "brokerAccess">;
  refusal(): string | null;
}

export function createShareGithubAccess(deps: ShareGithubAccessDeps) {
  const assertAccess = () => {
    if (deps.refusal()) throw new GithubTemplateError("This workspace cannot use a private GitHub connection for templates.", 403);
    if (!deps.composio.configured(deps.cfg())) throw new GithubTemplateError("Connect GitHub in Apps first.", 409);
  };
  const accounts = async () => {
    assertAccess();
    let inventory: Awaited<ReturnType<typeof deps.composio.connectedServicesInventory>>;
    try { inventory = await deps.composio.connectedServicesInventory(deps.cfg()); }
    catch { throw new GithubTemplateError("Apps cannot be reached right now. Try again later.", 502); }
    assertAccess();
    if (!inventory.complete) throw new GithubTemplateError("GitHub account discovery is incomplete. Refresh Apps and try again.", 502);
    return (inventory.services.github?.accounts ?? []).filter(account => /^active$/i.test(account.status))
      .map(({ id, alias }) => ({ id, ...(alias ? { alias } : {}) }));
  };
  const connect = async (account?: string, assertActor: () => void = () => undefined): Promise<Extract<GithubConnection, { ok: true }>> => {
    assertActor();
    const active = await accounts();
    const selected = account ? active.find(item => item.id === account) : active.length === 1 ? active[0] : undefined;
    if (!selected) throw new GithubTemplateError(active.length ? "Choose an active GitHub account." : "Connect GitHub in Apps first.", 409);
    const cfg = deps.cfg();
    const identityOf = (current: AppConfig) => JSON.stringify([current.composio?.apiKey, current.composio?.userId, deps.composio.brokerAccess()]);
    const identity = identityOf(cfg);
    const assertCurrent = () => {
      assertAccess();
      assertActor();
      const current = deps.cfg();
      if (identityOf(current) !== identity) {
        throw new GithubTemplateError("The GitHub connection changed. Load the template again.", 409);
      }
    };
    return {
      ok: true, account: selected.id, binding: createHash("sha256").update(identity).digest("hex"),
      relay: async (payload, session, signal) => {
        signal.throwIfAborted();
        assertCurrent();
        const current = await accounts();
        assertCurrent();
        if (!current.some(item => item.id === selected.id)) throw new GithubTemplateError("The chosen GitHub account is no longer connected.", 403);
        const answer = await deps.composio.relayMcp(cfg, payload as never, session, assertCurrent, signal);
        const after = await accounts();
        assertCurrent();
        signal.throwIfAborted();
        if (!after.some(item => item.id === selected.id)) throw new GithubTemplateError("The chosen GitHub account is no longer connected.", 403);
        return answer;
      },
    };
  };
  return { accounts, connect };
}
