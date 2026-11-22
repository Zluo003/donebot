import { useSyncExternalStore } from "react";
import { api } from "@/state/api";
import type { Action, AppState } from "@/state/store";
import { notificationSoundsEnabled } from "@/lib/notification-preferences";
import { cleanError, type CollabOverview } from "./collab-types";

export type CollabSidebarTab = "bots" | "collab";

export type CollabSelection =
  | { kind: "inbox" }
  | { kind: "folders" }
  | { kind: "bots" }
  | { kind: "contacts"; focus?: "add-friend" | "create-team" | "accept-team" }
  | { kind: "friend"; userId: number }
  | { kind: "team"; teamId: string };

export interface CollabToastItem {
  id: string;
  kind: "friend-request" | "team-invitation";
  title: string;
  body: string;
  requestId?: string;
  invitationId?: string;
  email?: string;
  teamName?: string;
}

export interface CollabStoreState {
  sidebarTab: CollabSidebarTab;
  selection: CollabSelection;
  selectionTouched: boolean;
  overview: CollabOverview | null;
  loaded: boolean;
  refreshing: boolean;
  error: string;
  toasts: CollabToastItem[];
  announcement: string;
  modalOpen: boolean;
}

export const COLLAB_DESKTOP_NOTIFY_BOT_ID = "donebot-collab";
export const COLLAB_DESKTOP_NOTIFY_THREAD_ID = "collab-inbox";

const NOTIFIED_STORAGE_PREFIX = "donebot.collab.notified.";

function initialState(): CollabStoreState {
  return {
    sidebarTab: "bots",
    selection: { kind: "folders" },
    selectionTouched: false,
    overview: null,
    loaded: false,
    refreshing: false,
    error: "",
    toasts: [],
    announcement: "",
    modalOpen: false,
  };
}

let state: CollabStoreState = initialState();
let currentAccountKey: string | null = null;
let uiActiveView: AppState["activeView"] = "chat";
let inFlight: Promise<CollabOverview | null> | null = null;
let requestGeneration = 0;
let notifiedAccount = "";
let notifiedIds = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<CollabStoreState>) {
  state = { ...state, ...patch };
  emit();
}

export function isCollabEligible(config?: AppState["config"] | null): boolean {
  return config?.donebot?.enabled === true && !config?.cloudHome && !config?.team;
}

export function collabPendingCount(overview: CollabOverview | null): number {
  if (!overview) return 0;
  return overview.friends.incoming_requests.length + overview.incoming_team_invitations.length;
}

function loadNotified(accountId: string): Set<string> {
  if (notifiedAccount === accountId) return notifiedIds;
  notifiedAccount = accountId;
  notifiedIds = new Set<string>();
  try {
    if (typeof sessionStorage !== "undefined") {
      const raw = sessionStorage.getItem(`${NOTIFIED_STORAGE_PREFIX}${accountId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string") notifiedIds.add(item);
          }
        }
      }
    }
  } catch { /* sessionStorage may be unavailable */ }
  return notifiedIds;
}

function persistNotified(accountId: string, set: Set<string>) {
  try {
    if (typeof sessionStorage !== "undefined") {
      const trimmed = [...set].slice(-200);
      sessionStorage.setItem(`${NOTIFIED_STORAGE_PREFIX}${accountId}`, JSON.stringify(trimmed));
    }
  } catch { /* ignore storage quota errors */ }
}

function announceText(text: string) {
  if (!text) return;
  const doc = typeof document !== "undefined" ? (document as Document & { ariaNotify?: (msg: string, opts?: { priority?: string }) => void }) : null;
  if (doc && typeof doc.ariaNotify === "function") {
    try {
      doc.ariaNotify(text, { priority: "normal" });
      return;
    } catch { /* Fall back to live region */ }
  }
  setState({ announcement: "" });
  queueMicrotask(() => setState({ announcement: text }));
}

function fireDesktopNotification(item: CollabToastItem) {
  if (typeof window === "undefined") return;
  const focusedOnCollabInbox = typeof document !== "undefined"
    && document.hasFocus()
    && uiActiveView === "collab"
    && (state.selection.kind === "inbox" || state.selection.kind === "contacts");
  if (focusedOnCollabInbox) return;

  const silent = !notificationSoundsEnabled();
  const desktop = window.ogb?.desktopNotifications;
  if (desktop) {
    void desktop.show({
      title: item.title,
      body: item.body,
      tag: `donebot:collab:${item.id}`,
      silent,
      botId: COLLAB_DESKTOP_NOTIFY_BOT_ID,
      threadId: COLLAB_DESKTOP_NOTIFY_THREAD_ID,
    }).catch(() => {});
    return;
  }

  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const note = new Notification(item.title, {
      body: item.body,
      tag: `donebot:collab:${item.id}`,
      silent,
    });
    note.onclick = () => {
      window.focus();
      setState({ sidebarTab: "collab", selection: { kind: "inbox" }, selectionTouched: true });
    };
  } catch { /* ignore unsupported Notification constructor */ }
}

function incomingItemsFrom(overview: CollabOverview): CollabToastItem[] {
  const items: CollabToastItem[] = [];
  for (const req of overview.friends.incoming_requests) {
    items.push({
      id: `friend-req:${req.id}`,
      kind: "friend-request",
      title: "新的好友申请",
      body: req.note ? `${req.requester_email} 请求添加你为好友 · ${req.note}` : `${req.requester_email} 请求添加你为好友`,
      requestId: req.id,
      email: req.requester_email,
    });
  }
  for (const inv of overview.incoming_team_invitations) {
    items.push({
      id: `team-inv:${inv.id}`,
      kind: "team-invitation",
      title: "新的团队邀请",
      body: `${inv.invited_by_email} 邀请你加入团队「${inv.team_name}」`,
      invitationId: inv.id,
      teamName: inv.team_name,
    });
  }
  return items;
}

function reconcileNotifications(overview: CollabOverview) {
  const accountId = overview.identity.account_id || "default";
  const seen = loadNotified(accountId);
  const incoming = incomingItemsFrom(overview);
  const liveIds = new Set(incoming.map(item => item.id));

  // Drop toasts that are no longer pending (accepted, declined, or revoked elsewhere).
  const retained = state.toasts.filter(toast => liveIds.has(toast.id));
  const newlyArrived: CollabToastItem[] = [];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    newlyArrived.push(item);
  }
  if (newlyArrived.length > 0) {
    persistNotified(accountId, seen);
  }

  const viewingInbox = uiActiveView === "collab" && (state.selection.kind === "inbox" || state.selection.kind === "contacts");
  const nextToasts = viewingInbox
    ? retained
    : [...retained, ...newlyArrived.filter(item => !retained.some(t => t.id === item.id))].slice(-4);

  const toastsChanged = nextToasts.length !== state.toasts.length
    || nextToasts.some((toast, idx) => toast.id !== state.toasts[idx]?.id);
  if (toastsChanged) {
    setState({ toasts: nextToasts });
  }

  if (newlyArrived.length > 0) {
    const latest = newlyArrived[newlyArrived.length - 1]!;
    if (!viewingInbox) {
      announceText(`${latest.title}：${latest.body}，有可用操作`);
    }
    for (const item of newlyArrived) {
      fireDesktopNotification(item);
    }
  }
}

export function setCollabUiContext(context: { activeView: AppState["activeView"]; modalOpen: boolean }) {
  uiActiveView = context.activeView;
  if (state.modalOpen !== context.modalOpen) {
    setState({ modalOpen: context.modalOpen });
  }
}

export function syncCollabAccount(accountKey: string | null) {
  if (currentAccountKey === accountKey) return;
  currentAccountKey = accountKey;
  requestGeneration++;
  inFlight = null;
  notifiedAccount = "";
  notifiedIds = new Set();
  state = { ...initialState(), modalOpen: state.modalOpen };
  emit();
}

export function setCollabSidebarTab(tab: CollabSidebarTab) {
  if (state.sidebarTab === tab) return;
  const patch: Partial<CollabStoreState> = { sidebarTab: tab };
  if (tab === "collab" && !state.selectionTouched && collabPendingCount(state.overview) > 0) {
    patch.selection = { kind: "inbox" };
  }
  setState(patch);
}

export function setCollabSelection(selection: CollabSelection) {
  const clearToasts = selection.kind === "inbox";
  setState({
    selection,
    selectionTouched: true,
    ...(clearToasts && state.toasts.length > 0 ? { toasts: [] } : {}),
  });
}

export function openCollabDestination(
  dispatch: (action: Action) => void,
  selection?: CollabSelection,
) {
  const target: CollabSelection = selection
    ?? (collabPendingCount(state.overview) > 0 ? { kind: "inbox" } : state.selectionTouched ? state.selection : { kind: "folders" });
  setState({
    sidebarTab: "collab",
    selection: target,
    selectionTouched: true,
    ...(target.kind === "inbox" && state.toasts.length > 0 ? { toasts: [] } : {}),
  });
  dispatch({ type: "showCollab" });
  void refreshCollabOverview({ silent: true });
}

export function dismissCollabToast(id: string) {
  const next = state.toasts.filter(toast => toast.id !== id);
  if (next.length !== state.toasts.length) {
    setState({ toasts: next });
  }
}

export async function refreshCollabOverview(opts: { silent?: boolean } = {}): Promise<CollabOverview | null> {
  if (inFlight) return inFlight;
  const mine = ++requestGeneration;
  if (!opts.silent) {
    setState({ refreshing: true });
  }
  let promise: Promise<CollabOverview | null> | null = null;
  promise = (async () => {
    try {
      const next = await api<CollabOverview>("/api/donebot/collab/overview");
      if (requestGeneration !== mine) return null;
      const patch: Partial<CollabStoreState> = {
        overview: next,
        loaded: true,
        refreshing: false,
        error: "",
      };
      // Keep selection valid if a friend or team was removed.
      if (state.selection.kind === "friend" && !next.friends.friends.some(f => f.user_id === (state.selection as { kind: "friend"; userId: number }).userId)) {
        patch.selection = { kind: "contacts" };
      } else if (state.selection.kind === "team" && !next.teams.some(t => t.id === (state.selection as { kind: "team"; teamId: string }).teamId)) {
        patch.selection = { kind: "contacts" };
      } else if (!state.selectionTouched && collabPendingCount(next) > 0) {
        patch.selection = { kind: "inbox" };
      }
      setState(patch);
      reconcileNotifications(next);
      return next;
    } catch (cause) {
      if (requestGeneration !== mine) return null;
      setState({
        loaded: true,
        refreshing: false,
        ...(opts.silent && state.overview ? {} : { error: cleanError(cause, "无法加载远程协作数据，请确认已登录并升级网关。") }),
      });
      return null;
    } finally {
      if (inFlight === promise) inFlight = null;
    }
  })();
  inFlight = promise;
  return promise;
}

export function subscribeCollabStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCollabStoreSnapshot(): CollabStoreState {
  return state;
}

export function useCollabStore(): CollabStoreState {
  return useSyncExternalStore(subscribeCollabStore, getCollabStoreSnapshot, getCollabStoreSnapshot);
}

export function useCollabPendingCount(): number {
  const snap = useCollabStore();
  return collabPendingCount(snap.overview);
}

/** Tests only. */
export function resetCollabStore() {
  requestGeneration++;
  inFlight = null;
  currentAccountKey = null;
  uiActiveView = "chat";
  notifiedAccount = "";
  notifiedIds = new Set();
  state = initialState();
  emit();
}
