import { useSyncExternalStore } from "react";
import { api } from "@/state/api";
import type { Action, AppState } from "@/state/store";
import { notificationSoundsEnabled } from "@/lib/notification-preferences";
import type { CollabChatScopeType, DoneBotChatMessage, DoneBotChatSummary } from "../../shared/donebot-collab";
import { cleanError, displayPersonName, type CollabOverview } from "./collab-types";
import { isDoneBotCloudBrowser } from "./services";

export type CollabSidebarTab = "bots" | "collab";

export type CollabSelection =
  | { kind: "friend"; userId: number }
  | { kind: "team"; teamId: string }
  | null;

export type CollabDialogTarget =
  | null
  | { kind: "add-friend" }
  | { kind: "add-team"; mode?: "create" | "join" }
  | { kind: "requests" }
  | { kind: "invite-team"; teamId: string };

export interface CollabToastItem {
  id: string;
  kind: "friend-request" | "team-invitation";
  title: string;
  body: string;
  requestId?: string;
  invitationId?: string;
  email?: string;
  avatarUrl?: string;
  displayName?: string;
  teamName?: string;
}

export interface CollabStoreState {
  sidebarTab: CollabSidebarTab;
  selection: CollabSelection;
  selectionTouched: boolean;
  rightPanelOpen: boolean;
  activeDialog: CollabDialogTarget;
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

function defaultSelectionFor(overview: CollabOverview | null): CollabSelection {
  if (!overview) return null;
  const firstFriend = overview.friends.friends[0];
  if (firstFriend) return { kind: "friend", userId: firstFriend.user_id };
  const firstTeam = overview.teams[0];
  if (firstTeam) return { kind: "team", teamId: firstTeam.id };
  return null;
}

function initialState(): CollabStoreState {
  return {
    sidebarTab: "bots",
    selection: null,
    selectionTouched: false,
    rightPanelOpen: true,
    activeDialog: null,
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
  if (typeof window !== "undefined" && window.ogb?.remoteClient?.active === true) return false;
  if (isDoneBotCloudBrowser()) return false;
  return config?.donebot?.enabled === true
    && config?.donebot?.cloudManaged !== true
    && !config?.cloudHome
    && !config?.team;
}

export function collabPendingCount(overview: CollabOverview | null): number {
  if (!overview) return 0;
  return overview.friends.incoming_requests.length + overview.incoming_team_invitations.length;
}

export function collabUnreadChatCount(overview: CollabOverview | null): number {
  if (!overview?.chat_summaries) return 0;
  return overview.chat_summaries.reduce((sum, item) => sum + Math.max(0, item.unread_count || 0), 0);
}

export function collabTotalBadgeCount(overview: CollabOverview | null): number {
  return collabPendingCount(overview) + collabUnreadChatCount(overview);
}

export function findChatSummary(
  overview: CollabOverview | null,
  scopeType: CollabChatScopeType,
  targetId: string,
): DoneBotChatSummary | undefined {
  return overview?.chat_summaries?.find(item => item.scope_type === scopeType && item.target_id === targetId);
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
  const viewingRequests = typeof document !== "undefined"
    && document.hasFocus()
    && state.activeDialog?.kind === "requests";
  if (viewingRequests) return;

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
      setState({ sidebarTab: "collab", activeDialog: { kind: "requests" } });
    };
  } catch { /* ignore unsupported Notification constructor */ }
}

function incomingItemsFrom(overview: CollabOverview): CollabToastItem[] {
  const items: CollabToastItem[] = [];
  for (const req of overview.friends.incoming_requests) {
    const sender = req.requester_nickname?.trim() || req.requester_email;
    items.push({
      id: `friend-req:${req.id}`,
      kind: "friend-request",
      title: "新的好友申请",
      body: req.note ? `${sender} 请求添加你为好友 · ${req.note}` : `${sender} 请求添加你为好友`,
      requestId: req.id,
      email: req.requester_email,
      displayName: sender,
      avatarUrl: req.requester_avatar_url,
    });
  }
  for (const inv of overview.incoming_team_invitations) {
    const inviter = inv.invited_by_nickname?.trim() || inv.invited_by_email;
    items.push({
      id: `team-inv:${inv.id}`,
      kind: "team-invitation",
      title: "新的团队邀请",
      body: `${inviter} 邀请你加入团队「${inv.team_name}」`,
      invitationId: inv.id,
      displayName: inviter,
      avatarUrl: inv.invited_by_avatar_url,
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

  const viewingRequests = state.activeDialog?.kind === "requests";
  const nextToasts = viewingRequests
    ? retained
    : [...retained, ...newlyArrived.filter(item => !retained.some(t => t.id === item.id))].slice(-4);

  const toastsChanged = nextToasts.length !== state.toasts.length
    || nextToasts.some((toast, idx) => toast.id !== state.toasts[idx]?.id);
  if (toastsChanged) {
    setState({ toasts: nextToasts });
  }

  if (newlyArrived.length > 0) {
    const latest = newlyArrived[newlyArrived.length - 1]!;
    if (!viewingRequests) {
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
  if (tab === "collab" && !state.selection && state.overview) {
    patch.selection = defaultSelectionFor(state.overview);
  }
  setState(patch);
}

export function setCollabSelection(selection: CollabSelection) {
  setState({ selection, selectionTouched: true });
}

export function setCollabRightPanelOpen(open: boolean) {
  if (state.rightPanelOpen !== open) setState({ rightPanelOpen: open });
}

export function toggleCollabRightPanel() {
  setState({ rightPanelOpen: !state.rightPanelOpen });
}

export function openCollabDialog(dialog: CollabDialogTarget) {
  setState({
    activeDialog: dialog,
    ...(dialog?.kind === "requests" && state.toasts.length > 0 ? { toasts: [] } : {}),
  });
}

export function openCollabDestination(
  dispatch: (action: Action) => void,
  destination?: CollabSelection | { kind: "inbox" },
) {
  if (destination && destination.kind === "inbox") {
    setState({
      sidebarTab: "collab",
      selection: state.selection ?? defaultSelectionFor(state.overview),
      activeDialog: { kind: "requests" },
      ...(state.toasts.length > 0 ? { toasts: [] } : {}),
    });
    dispatch({ type: "showCollab" });
    void refreshCollabOverview({ silent: true });
    return;
  }
  const target: CollabSelection = destination !== undefined
    ? destination
    : (state.selection ?? defaultSelectionFor(state.overview));
  setState({
    sidebarTab: "collab",
    selection: target,
    selectionTouched: destination !== undefined || state.selectionTouched,
  });
  dispatch({ type: "showCollab" });
  void refreshCollabOverview({ silent: true });
}

export function clearChatSummaryUnread(scopeType: CollabChatScopeType, targetId: string) {
  const overview = state.overview;
  if (!overview?.chat_summaries) return;
  let changed = false;
  const next = overview.chat_summaries.map(item => {
    if (item.scope_type === scopeType && item.target_id === targetId && item.unread_count > 0) {
      changed = true;
      return { ...item, unread_count: 0 };
    }
    return item;
  });
  if (changed) {
    setState({ overview: { ...overview, chat_summaries: next } });
  }
}

export function upsertChatSummaryFromMessage(msg: DoneBotChatMessage, unreadDelta = 0) {
  const overview = state.overview;
  if (!overview) return;
  const list = [...(overview.chat_summaries ?? [])];
  const senderName = displayPersonName({
    remark: msg.sender_remark,
    nickname: msg.sender_nickname,
    email: msg.sender_email,
  });
  const idx = list.findIndex(item => item.scope_type === msg.scope_type && item.target_id === msg.target_id);
  const prevUnread = idx >= 0 ? list[idx]!.unread_count : 0;
  const updated: DoneBotChatSummary = {
    scope_type: msg.scope_type,
    target_id: msg.target_id,
    last_message_id: msg.id,
    last_kind: msg.kind,
    last_body: msg.body,
    last_file_name: msg.file_name,
    last_sender_id: msg.sender_id,
    last_sender_name: senderName,
    last_created_at: msg.created_at,
    unread_count: unreadDelta < 0 ? 0 : prevUnread + unreadDelta,
  };
  if (idx >= 0) list[idx] = updated;
  else list.unshift(updated);
  setState({ overview: { ...overview, chat_summaries: list } });
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
      // Keep selection valid; auto-pick first friend/team if none selected yet.
      if (state.selection?.kind === "friend" && !next.friends.friends.some(f => f.user_id === (state.selection as { kind: "friend"; userId: number }).userId)) {
        patch.selection = defaultSelectionFor(next);
      } else if (state.selection?.kind === "team" && !next.teams.some(t => t.id === (state.selection as { kind: "team"; teamId: string }).teamId)) {
        patch.selection = defaultSelectionFor(next);
      } else if (!state.selection) {
        patch.selection = defaultSelectionFor(next);
      }
      // If currently viewing an active chat, keep its unread count at 0 until poll catches up.
      if (uiActiveView === "collab" && state.selection && next.chat_summaries) {
        const activeScope = state.selection.kind;
        const activeTarget = state.selection.kind === "friend" ? String(state.selection.userId) : state.selection.teamId;
        patch.overview = {
          ...next,
          chat_summaries: next.chat_summaries.map(item =>
            item.scope_type === activeScope && item.target_id === activeTarget
              ? { ...item, unread_count: 0 }
              : item,
          ),
        };
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
