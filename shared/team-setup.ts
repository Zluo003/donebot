import type { ModelSelection } from "./wire.ts";

export interface TeamSetupFields {
  name?: string;
  title?: string;
  description?: string;
  soul?: string;
  /** Create only: the folder the new bot's tools work in. "" = private workspace. */
  cwd?: string;
  section?: string;
  modelSelection?: ModelSelection;
  chiefOfStaff?: boolean;
  /** Update only: the complete list of MCP server names the bot may use. */
  mcpServers?: string[];
}

export interface TeamSetupOperation {
  action: "create" | "update";
  botId: string;
  threadId?: string;
  fields: TeamSetupFields;
  expectedRevision?: string;
}

export interface TeamSetupCreatedRoom {
  id: string;
  name: string;
  section: string;
  memberIds: string[];
}

export interface TeamSetupResult {
  state: "applied" | "denied" | "cancelled" | "failed";
  bots: Array<{ id: string; name: string; action: "created" | "updated" | "deleted"; section?: string; modelSelection?: ModelSelection; chiefOfStaff?: boolean }>;
  newTeams: string[];
  createdRooms?: TeamSetupCreatedRoom[];
  updatedDepartmentInstructions?: string[];
  error?: string;
}

/** The complete, reviewed operation. MCP selection may change; other execution permissions are excluded. */
export interface TeamSetupRequest {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  reason: string;
  createdAt: number;
  requesterRevision: string;
  operations: TeamSetupOperation[];
  newTeams: string[];
  /** Shared instructions (OpenMausBot section-context) to write per department when this setup applies. */
  departmentInstructions?: Record<string, string>;
  deletion?: { botId: string; name: string; expectedRevision: string };
  result?: TeamSetupResult;
  resumed?: boolean;
  /** Set when the setup applied on its own (direct-apply.ts) and Undo can reverse it. */
  undo?: TeamSetupUndo;
}

/** Undo deletes the bots a setup created while still unused, gives each updated bot back the values the card showed and
 * the Chief its earlier teams; `revisions` pin every bot it touched as it applied, so a later change refuses Undo. */
export interface TeamSetupUndo {
  created: string[];
  createdRoomIds?: string[];
  previousSectionContexts?: Array<{ section: string; previousText: string | null; writtenText: string }>;
  before: Array<{ botId: string; fields: TeamSetupFields; managedSections?: string[] | null }>;
  revisions: Record<string, string>;
}
