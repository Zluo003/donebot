export type CollabAccess = "read" | "write";
export type CollabSubjectType = "user" | "team";
export type CollabChatScopeType = "friend" | "team" | "group";

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
  scope_type: "team" | "group";
  target_id: string;
  chat_name?: string;
  local_bot_id: string;
  bot_name: string;
  recent_messages: DoneBotChatMessage[];
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
