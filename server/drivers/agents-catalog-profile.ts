// The DONEBOT_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a conversation is shown, the same on every one of its turns. Presentation only: the server still
 * authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  sharedComputers: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on: x_search is mounted.
   * Absent means off. */
  xResearch?: boolean;
  /** As xResearch, and research works for that credential (the person's treg key, or a plan whose relay has research
   * on): research_search, research_endpoint and research_call are mounted too. Absent means off. */
  research?: boolean;
  cloudHome: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Only for Watcher's own tool. Never written into a schema: a list that names its bot can't share a prompt cache with other bots. */
  botId: string;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's DoneBot with a Chief's powers: its notification tools are mounted. */
  mausbot?: boolean;
  /** A direct chat whose bot may pick where it works (Works on is not Off and no team computer is its own): select_computer
   * is mounted, and the harness refuses a pick on any turn but a person's own message. */
  computerSelection?: boolean;
  /** A room's thread: the wait tools are not mounted, since a room holds no wait. */
  room?: boolean;
  imageGeneration?: boolean;
  donebotMedia?: boolean;
  /** A cloud computer can be had here (Boat): the meeting tools are mounted. */
  meetings?: boolean;
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.DONEBOT_SKILL_AUTHORING_ENABLED === "1",
    sharedComputers: env.DONEBOT_SHARED_COMPUTERS_ENABLED === "1",
    voiceNotes: env.DONEBOT_VOICE_NOTES === "1",
    xResearch: env.DONEBOT_X_RESEARCH === "1",
    research: env.DONEBOT_RESEARCH === "1",
    cloudHome: env.DONEBOT_CLOUD_HOME === "1",
    memoryEnabled: env.DONEBOT_MEMORY_ENABLED !== "0",
    chief: env.DONEBOT_CHIEF_OF_STAFF === "1",
    botId: env.DONEBOT_BOT_ID ?? "",
    team: env.DONEBOT_TEAM_PEOPLE === "1",
    mausbot: env.DONEBOT_MAUSBOT === "1",
    computerSelection: env.DONEBOT_COMPUTER_SELECTION === "1",
    room: env.DONEBOT_ROOM === "1",
    imageGeneration: env.DONEBOT_IMAGE_GENERATION === "1",
    donebotMedia: env.DONEBOT_MEDIA === "1",
    meetings: env.DONEBOT_MEETINGS === "1",
  };
}
