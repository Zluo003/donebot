// Coordinator tool schemas extracted from agents-catalog.ts to keep catalog modules concise.
export const COORDINATOR_ROOM_AND_INSTRUCTIONS_TOOLS = [
  {
    name: "manage_room",
    description:
      "Coordinators only, for rooms in departments you oversee (the System Coordinator oversees all departments; a Department Coordinator oversees its own department). create a room (was create_room) when needed (at most four per turn), optionally specifying section for a managed department, with active bots from list_bots; in your own department you are included automatically as default responder, while in another department its Department Coordinator becomes the default responder. For a room from list_rooms: rename it, change its bulletin, add, remove or set members, or open a new thread in it (new_thread, at most four per turn), which becomes the room's current thread. Busy rooms, pending approvals and team-goal leads are protected. Moving existing rooms between departments stays with the user; coordinate_bots reaches bots outside a room directly. Follow the tool result under the effective access level; if the change is refused, report the blocker, or ask the user to make the room change, without trying another route.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["create", "add_members", "remove_members", "set_members", "rename", "set_bulletin", "new_thread"],
          description: "The change to make.",
        },
        room_id: { type: "string", description: "Every action but create: the room's id from list_rooms." },
        name: { type: "string", minLength: 1, maxLength: 100, description: 'create and rename: the room\'s display name (e.g. "短剧部群聊"). new_thread: the thread\'s title (optional).' },
        section: { type: "string", maxLength: 60, description: "create only: optional department name you manage (defaults to your own department). The System Coordinator can create a room in any department." },
        member_bot_ids: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string" },
          description: "create, add_members, remove_members and set_members: the bot IDs.",
        },
        bulletin: {
          type: "string",
          maxLength: 12_000,
          description: "create: an optional bulletin, goal or instructions pinned for the room. set_bulletin: the new bulletin; an empty string clears it.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_department_instructions",
    description:
      "Coordinators only: read, create, replace, or append a department's shared instructions (部门共享指示, injected at turn start for every bot in that department). The System Coordinator may manage any existing department (and General); a Department Coordinator may manage only its own department (and authorized managed departments). Ordinary specialist bots cannot edit shared instructions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["read", "set", "append"],
          description: "read: inspect current shared instructions; set: create or replace full text (empty string clears); append: add a new section/lines to existing shared instructions.",
        },
        section: {
          type: "string",
          maxLength: 60,
          description: 'Target department name (omit for your own department; "" = General). System Coordinator may name any existing department.',
        },
        text: {
          type: "string",
          maxLength: 24_000,
          description: "Required for set and append: department shared instructions (goals, handoff workflow, shared paths, approval rules and standards).",
        },
      },
      required: ["action"],
    },
  },
] as const;
