export type CollabAccess = "read" | "write";
export type CollabSubjectType = "user" | "team";
export type CollabChatScopeType = "friend" | "team" | "group" | "channel";

export const DONEBOT_COLLAB_MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface DoneBotCollabGroupMember {
  user_id: number;
  email: string;
  nickname?: string;
  avatar_url?: string;
  remark?: string;
  joined_at: string;
}

export interface DoneBotCollabGroup {
  id: string;
  name: string;
  avatar_url?: string;
  creator_id: number;
  members: DoneBotCollabGroupMember[];
  created_at: string;
  updated_at: string;
}

export interface DoneBotCollabChatBot {
  id: string;
  scope_type: "team" | "group";
  target_id: string;
  owner_user_id: number;
  owner_email: string;
  owner_nickname?: string;
  owner_avatar_url?: string;
  owner_remark?: string;
  installation_id: string;
  local_bot_id: string;
  bot_name: string;
  bot_color: string;
  bot_avatar_url?: string;
  bot_mascot_body?: string;
  bot_mascot_face_color?: string;
  bot_mascot_expression?: string;
  bot_avatar_crop?: string;
  bot_avatar_zoom?: number;
  bot_avatar_focus_x?: number;
  bot_avatar_focus_y?: number;
  bot_title?: string;
  allow_all_members: boolean;
  allowed_user_ids: number[];
  can_invoke: boolean;
  created_at: string;
}

export interface DoneBotChatMessage {
  id: number;
  scope_type: CollabChatScopeType;
  target_id: string;
  sender_id: number;
  sender_kind?: "user" | "bot";
  sender_email: string;
  sender_nickname?: string;
  sender_avatar_url?: string;
  sender_remark?: string;
  sender_bot_id?: string;
  sender_bot_name?: string;
  sender_bot_color?: string;
  sender_bot_avatar_url?: string;
  sender_bot_mascot_body?: string;
  sender_bot_mascot_face_color?: string;
  sender_bot_mascot_expression?: string;
  sender_bot_avatar_crop?: string;
  sender_bot_avatar_zoom?: number;
  sender_bot_avatar_focus_x?: number;
  sender_bot_avatar_focus_y?: number;
  kind: "text" | "file";
  body: string;
  file_id?: string;
  file_name?: string;
  file_mime?: string;
  file_size?: number;
  file_sha256?: string;
  triggered_bot_ids?: string[];
  denied_bot_names?: string[];
  created_at: string;
}

export interface DoneBotClaimedBotInvocation {
  id: string;
  chat_bot_id: string;
  message_id: number;
  scope_type: "team" | "group" | "channel";
  target_id: string;
  team_id?: string;
  chat_name?: string;
  local_bot_id: string;
  bot_name: string;
  recent_messages: DoneBotChatMessage[];
}

export interface DoneBotTeamChannel {
  id: string;
  team_id: string;
  name: string;
  description?: string;
  is_default: boolean;
  is_private: boolean;
  chat_scope_type: "team" | "channel";
  chat_target_id: string;
  created_by: number;
  member_ids: number[];
  archived_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DoneBotTeamMemberProfile {
  user_id: number;
  job_title: string;
  updated_at: string;
}

export type DoneBotTeamTaskStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "bot_reviewing"
  | "bot_revising"
  | "ready_for_review"
  | "changes_requested"
  | "blocked"
  | "done";

export type DoneBotTeamTaskPriority = "low" | "normal" | "high" | "urgent";

export type DoneBotTeamTaskUpdateKind =
  | "comment"
  | "submission"
  | "approve"
  | "request_changes"
  | "status_change"
  | "bot_review_pass"
  | "bot_reject"
  | "bot_escalate";

export interface DoneBotTeamTaskBotReview {
  verdict: "pass" | "hard_fail" | "escalated" | string;
  summary: string;
  bot_name?: string;
  batch_id?: string;
  passed_items?: string[];
  attention_items?: string[];
  failed_criteria?: string[];
  actionable_fixes?: string[];
  round?: number;
  reviewed_at?: string;
}

export interface DoneBotTeamTask {
  id: string;
  team_id: string;
  channel_id?: string;
  channel_name?: string;
  title: string;
  description: string;
  acceptance_criteria?: string[];
  status: DoneBotTeamTaskStatus;
  priority: DoneBotTeamTaskPriority;
  creator_id: number;
  assignee_id?: number;
  reviewer_id?: number;
  collaborator_ids: number[];
  due_at?: string;
  auto_review_enabled?: boolean;
  max_auto_revisions?: number;
  auto_revision_count?: number;
  assignee_auto_resubmit?: boolean;
  latest_submission_batch_id?: string;
  latest_bot_review_verdict?: string;
  latest_bot_review_summary?: string;
  latest_bot_review?: DoneBotTeamTaskBotReview;
  source_scope_type?: string;
  source_target_id?: string;
  source_message_id?: number;
  source_quote?: string;
  update_count: number;
  deliverable_count: number;
  submitted_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DoneBotTeamTaskCounts {
  team_id: string;
  open_total: number;
  assigned_to_me: number;
  review_by_me: number;
  ready_for_my_review?: number;
  changes_requested_to_me: number;
  bot_revising_count?: number;
}

export interface DoneBotTeamTaskUpdate {
  id: number;
  task_id: string;
  actor_id: number;
  actor_kind?: "user" | "bot";
  actor_bot_name?: string;
  actor_email: string;
  actor_nickname?: string;
  actor_avatar_url?: string;
  actor_remark?: string;
  kind: DoneBotTeamTaskUpdateKind;
  batch_id?: string;
  body: string;
  file_id?: string;
  file_name?: string;
  file_mime?: string;
  file_size?: number;
  file_sha256?: string;
  meta?: Record<string, unknown>;
  created_at: string;
}

export interface DoneBotTeamTaskDetail {
  task: DoneBotTeamTask;
  updates: DoneBotTeamTaskUpdate[];
}

export interface DoneBotClaimedTaskBotEvent {
  id: string;
  team_id: string;
  team_name: string;
  task_id: string;
  event_type: "task_assigned" | "task_submitted" | "task_bot_rejected" | "task_human_rejected";
  batch_id?: string;
  payload?: Record<string, unknown>;
  assignee_name?: string;
  reviewer_name?: string;
  creator_name?: string;
  detail: DoneBotTeamTaskDetail;
  created_at: string;
}

export interface DoneBotLocalTaskBinding {
  teamId: string;
  teamName: string;
  taskId: string;
  taskTitle: string;
  botId: string;
  threadId: string;
  updatedAt: number;
}

export interface DoneBotChatSummary {
  scope_type: CollabChatScopeType;
  target_id: string;
  last_message_id: number;
  last_kind?: "text" | "file";
  last_body?: string;
  last_file_name?: string;
  last_sender_id?: number;
  last_sender_name?: string;
  last_created_at?: string;
  unread_count: number;
}

export interface DoneBotFriend {
  user_id: number;
  email: string;
  nickname?: string;
  avatar_url?: string;
  remark?: string;
  created_at: string;
}

export interface DoneBotFriendRequest {
  id: string;
  requester_id: number;
  requester_email: string;
  requester_nickname?: string;
  requester_avatar_url?: string;
  recipient_id: number;
  recipient_email: string;
  recipient_nickname?: string;
  recipient_avatar_url?: string;
  note: string;
  status: string;
  created_at: string;
}

export interface DoneBotFriendsSnapshot {
  friends: DoneBotFriend[];
  incoming_requests: DoneBotFriendRequest[];
  outgoing_requests: DoneBotFriendRequest[];
}

export interface DoneBotIncomingTeamInvitation {
  id: string;
  team_id: string;
  team_name: string;
  role: "admin" | "member";
  invited_by_email: string;
  invited_by_nickname?: string;
  invited_by_avatar_url?: string;
  expires_at: string;
}

export interface DoneBotCollabSource {
  kind: "friend" | "team";
  team_id?: string;
  team_name?: string;
}

export interface DoneBotFolderGrantInput {
  subject_type: CollabSubjectType;
  subject_id: string;
  access: CollabAccess;
}

export interface DoneBotFolderGrant extends DoneBotFolderGrantInput {
  label: string;
}

export interface DoneBotOwnedFolder {
  id: string;
  installation_id: string;
  device_name: string;
  name: string;
  enabled: boolean;
  online: boolean;
  grants: DoneBotFolderGrant[];
  updated_at: string;
}

export interface DoneBotSharedFolder {
  id: string;
  owner_user_id: number;
  owner_email: string;
  owner_nickname?: string;
  owner_avatar_url?: string;
  owner_remark?: string;
  device_name: string;
  name: string;
  access: CollabAccess;
  online: boolean;
  sources: DoneBotCollabSource[];
  updated_at: string;
}

export interface DoneBotCollabFoldersSnapshot {
  owned: DoneBotOwnedFolder[];
  shared_with_me: DoneBotSharedFolder[];
}

export interface DoneBotBotGrantInput {
  subject_type: CollabSubjectType;
  subject_id: string;
}

export interface DoneBotBotGrant extends DoneBotBotGrantInput {
  label: string;
}

export interface DoneBotOwnedSharedBot {
  id: string;
  source_bot_id: string;
  name: string;
  title: string;
  description: string;
  skill_count: number;
  has_soul: boolean;
  grants: DoneBotBotGrant[];
  updated_at: string;
}

export interface DoneBotSharedBot {
  id: string;
  owner_user_id: number;
  owner_email: string;
  owner_nickname?: string;
  owner_avatar_url?: string;
  owner_remark?: string;
  name: string;
  title: string;
  description: string;
  skill_count: number;
  has_soul: boolean;
  sources: DoneBotCollabSource[];
  updated_at: string;
}

export interface DoneBotCollabBotsSnapshot {
  owned: DoneBotOwnedSharedBot[];
  shared_with_me: DoneBotSharedBot[];
}

export interface DoneBotCollabRelayJob {
  id: string;
  folder_id: string;
  caller_user_id: number;
  caller_email: string;
  granted_access: CollabAccess;
  operation: {
    action: "list_files" | "read_file" | "write_file" | "edit_file" | "append_file" | "delete_file" | "stream_read_file" | "stream_write_file";
    path?: string;
    content?: string;
    encoding?: "utf8" | "base64";
    old_text?: string;
    new_text?: string;
    expected_sha256?: string;
    transfer_id?: string;
    max_bytes?: number;
    content_type?: string;
  };
}

export interface DoneBotCollabActivity {
  at: number;
  folderId: string;
  folderName: string;
  callerEmail: string;
  action: string;
  detail: string;
  ok: boolean;
  error?: string;
}

export interface DoneBotLocalSharedFolder {
  id: string;
  accountId: string;
  path: string;
  name: string;
  enabled: boolean;
  allowWrite: boolean;
}
