import type { PackageDocument } from "./package-format.ts";

/** A reviewed template snapshot and its durable repository-publication receipt. */
export interface TemplatePublication {
  id: string;
  status: "ready" | "publishing" | "published" | "uncertain" | "refused";
  repository: string;
  directory: string;
  direct: boolean;
  account: string;
  name: string;
  createdAt: number;
  digest: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  document?: PackageDocument;
  result?: TemplateRepoPublish;
}

/** Only HTTPS links in the reviewed repository may appear in a publication result. */
export interface TemplateRepoPublish {
  kind: "commit" | "pull_request";
  url: string;
  link: string;
  branch: string;
}
