import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parsePackageDocument, type PackageDocument } from "../shared/package-format.ts";
import { writeShareFolder } from "../shared/share-folder.ts";
import type { TemplatePublication } from "../shared/template-publication.ts";
import { writeFileAtomic } from "./atomic.ts";
import { publishToRepo, repoFolder, repoName, type GithubConnection } from "./share-github-repo.ts";
import { GithubTemplateError } from "./share-github.ts";

const DAY = 24 * 60 * 60 * 1_000;
const ID = /^[a-f0-9-]{36}$/;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  version: z.literal(1), actor: z.string(), account: z.string(), binding: shaSchema,
  id: z.string().regex(ID), status: z.enum(["ready", "publishing", "published", "uncertain", "refused"]),
  repository: z.string(), directory: z.string(), folder: z.string(), slug: z.string(), direct: z.boolean(), name: z.string(),
  createdAt: z.number(), digest: shaSchema,
  files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: shaSchema })),
  document: z.unknown().optional(),
  result: z.object({ kind: z.enum(["commit", "pull_request"]), url: z.string(), link: z.string(), branch: z.string() }).optional(),
});
type Receipt = Omit<z.infer<typeof receiptSchema>, "document"> & { document?: PackageDocument };

export interface TemplatePublicationInput {
  repository: string;
  folder: string;
  direct: boolean;
  document: unknown;
}

export function createTemplatePublications(dataDir: string) {
  const directory = join(dataDir, "template-publications");
  const active = new Set<string>();
  const file = (id: string) => join(directory, `${id}.json`);
  const save = (receipt: Receipt) => writeFileAtomic(file(receipt.id), JSON.stringify(receipt), { mode: 0o600 });
  const read = (id: string): Receipt => {
    if (!ID.test(id) || !existsSync(file(id))) throw new GithubTemplateError("That template publication was not found.", 404);
    try {
      if (statSync(file(id)).size > 12 * 1024 * 1024) throw new Error("oversized");
      const parsed = receiptSchema.parse(JSON.parse(readFileSync(file(id), "utf8")));
      const { document, ...rest } = parsed;
      return { ...rest, ...(document === undefined ? {} : { document: parsePackageDocument(document, { trust: "file" }) }) };
    } catch { throw new GithubTemplateError("The publication record could not be read. Check GitHub before publishing again.", 409); }
  };
  const snapshot = ({ actor: _actor, binding: _binding, version: _version, folder: _folder, slug: _slug, ...view }: Receipt): TemplatePublication => view;
  const fingerprint = ({ repository, directory, direct, document, account }: Pick<Receipt, "repository" | "directory" | "direct" | "document" | "account">) =>
    digest(JSON.stringify({ repository, directory, direct, document, account }));
  const get = (actor: string, id: string) => {
    const receipt = read(id);
    if (receipt.actor !== actor) throw new GithubTemplateError("That template publication was not found.", 404);
    if (receipt.status === "publishing" && !active.has(id)) {
      receipt.status = "uncertain";
      delete receipt.document;
      save(receipt);
    }
    return receipt;
  };
  const prepare = (actor: string, connection: Extract<GithubConnection, { ok: true }>, input: TemplatePublicationInput): TemplatePublication => {
    const repository = repoName(input.repository), folder = repoFolder(input.folder);
    if (!repository || folder === null) throw new GithubTemplateError("Choose a GitHub repository and a plain folder path.");
    if (!connection.account || !connection.binding) throw new GithubTemplateError("Choose an active GitHub account.", 409);
    const document = parsePackageDocument(input.document, { trust: "file" });
    const slug = document.package.id;
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(slug)) throw new GithubTemplateError("The template id cannot be used as a repository folder.");
    const values = { repository: `${repository.owner}/${repository.repo}`, directory: [folder, slug].filter(Boolean).join("/"), direct: input.direct, document };
    const hash = fingerprint({ ...values, account: connection.account });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const names = readdirSync(directory).filter(name => ID.test(name.slice(0, -5)) && name.endsWith(".json"));
    if (names.length > 1_000) throw new GithubTemplateError("The publication journal needs maintenance before adding more templates.", 409);
    let pending = 0;
    for (const name of names) {
      const receipt = getForMaintenance(name.slice(0, -5));
      if (receipt.digest === hash && ["publishing", "uncertain"].includes(receipt.status)) {
        throw new GithubTemplateError("An earlier publication of this snapshot is unresolved. Check its receipt and GitHub before publishing again.", 409);
      }
      if (receipt.status === "ready" && receipt.createdAt < Date.now() - DAY ||
        ["published", "refused"].includes(receipt.status) && receipt.createdAt < Date.now() - 30 * DAY) {
        unlinkSync(file(receipt.id));
      } else if (receipt.status === "ready") pending++;
    }
    if (pending >= 20) throw new GithubTemplateError("Close an unused template review before creating another.", 409);
    const files = Object.entries(writeShareFolder(document, "department")).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: digest(value) }));
    const receipt: Receipt = { version: 1, actor, account: connection.account, binding: connection.binding, id: randomUUID(), status: "ready", createdAt: Date.now(),
      ...values, folder, slug, name: document.package.name, digest: hash, files };
    save(receipt);
    return snapshot(receipt);
  };
  function getForMaintenance(id: string): Receipt {
    const receipt = read(id);
    if (receipt.status === "publishing" && !active.has(id)) {
      receipt.status = "uncertain"; delete receipt.document; save(receipt);
    }
    return receipt;
  }
  const publish = async (actor: string, id: string, connect: (account: string) => Promise<Extract<GithubConnection, { ok: true }>>, assertActor: () => void): Promise<TemplatePublication> => {
    assertActor();
    const receipt = get(actor, id);
    if (receipt.status !== "ready") return snapshot(receipt);
    if (receipt.createdAt < Date.now() - DAY) throw new GithubTemplateError("This review expired. Prepare a new snapshot.", 409);
    if (!receipt.document || receipt.digest !== fingerprint(receipt) || receipt.folder !== repoFolder(receipt.folder) ||
      receipt.slug !== receipt.document.package.id || receipt.name !== receipt.document.package.name ||
      receipt.directory !== [receipt.folder, receipt.slug].filter(Boolean).join("/")) {
      throw new GithubTemplateError("The reviewed snapshot changed. Prepare a new snapshot.", 409);
    }
    receipt.status = "publishing";
    save(receipt);
    active.add(id);
    let writeStarted = false;
    try {
      const connection = await connect(receipt.account);
      assertActor();
      if (connection.binding !== receipt.binding || connection.account !== receipt.account) throw new GithubTemplateError("The GitHub connection changed. Prepare a new snapshot.", 409);
      const repository = repoName(receipt.repository)!;
      receipt.result = await publishToRepo(connection, { ...repository, folder: receipt.folder, slug: receipt.slug, direct: receipt.direct, name: receipt.name,
        files: writeShareFolder(receipt.document, "department") }, () => {
        assertActor();
        // This fsync precedes every external mutation; a crash never turns a write back into an unsubmitted review.
        if (!writeStarted) save(receipt);
        writeStarted = true;
      });
      assertActor();
      receipt.status = "published";
    } catch {
      receipt.status = writeStarted ? "uncertain" : "refused";
    } finally {
      active.delete(id);
    }
    delete receipt.document;
    save(receipt);
    assertActor();
    return snapshot(receipt);
  };
  return {
    prepare, publish,
    list: (actor: string) => {
      if (!existsSync(directory)) return [];
      return readdirSync(directory).filter(name => name.endsWith(".json") && ID.test(name.slice(0, -5))).slice(0, 1_001)
        .map(name => getForMaintenance(name.slice(0, -5))).filter(receipt => receipt.actor === actor)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(receipt => { const { document: _document, ...view } = snapshot(receipt); return view; });
    },
    get: (actor: string, id: string) => snapshot(get(actor, id)),
    discard: (actor: string, id: string) => {
      if (get(actor, id).status !== "ready") throw new GithubTemplateError("A submitted publication receipt must be retained.", 409);
      unlinkSync(file(id));
    },
  };
}
