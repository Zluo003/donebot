export type CollabAccess = "read" | "write";
export type CollabSubjectType = "user" | "team";

export interface DoneBotFriend {
  user_id: number;
  email: string;
  created_at: string;
}

export interface DoneBotFriendRequest {
  id: string;
  requester_id: number;
  requester_email: string;
  recipient_id: number;
  recipient_email: string;
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
    action: "list_files" | "read_file" | "write_file" | "edit_file" | "append_file" | "delete_file";
    path?: string;
    content?: string;
    encoding?: "utf8" | "base64";
    old_text?: string;
    new_text?: string;
    expected_sha256?: string;
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
