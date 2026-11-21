import type { TemplateScope } from "./share-folder.ts";

/** A template published to this team's library by an administrator. */
export interface TeamTemplate {
  slug: string;
  name: string;
  scope: TemplateScope;
  tagline: string;
  release: string;
  /** Digest of the exact published files, used to reject stale replacements and changed imports. */
  revision: string;
  addedBy: string;
  addedAt: number;
}

export const TEAM_TEMPLATE_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
