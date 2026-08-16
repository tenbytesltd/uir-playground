import type { PackageDiagnostic, UIRManifest, UIRPackageData, UIRShard } from "./runtime.ts";

export type FileWithPath = { file: File; path: string };

type WebkitEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
};
type WebkitFileEntry = WebkitEntry & { file: (ok: (file: File) => void, fail?: (error: DOMException) => void) => void };
type WebkitDirectoryReader = { readEntries: (ok: (entries: WebkitEntry[]) => void, fail?: (error: DOMException) => void) => void };
type WebkitDirectoryEntry = WebkitEntry & { createReader: () => WebkitDirectoryReader };
type DataTransferItemWithEntry = { webkitGetAsEntry?: () => WebkitEntry | null };

export function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isManifest(value: unknown): value is UIRManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UIRManifest>;
  return typeof candidate.formatVersion === "string" && typeof candidate.packageId === "string" && typeof candidate.packageVersion === "string" && Array.isArray(candidate.model);
}

async function sha256(file: File) {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readFileEntry(entry: WebkitFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(reader: WebkitDirectoryReader) {
  return new Promise<WebkitEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
}

async function collectEntry(entry: WebkitEntry): Promise<FileWithPath[]> {
  if (entry.isFile) {
    const file = await readFileEntry(entry as WebkitFileEntry);
    return [{ file, path: normalizePath(entry.fullPath || file.name) }];
  }
  if (entry.isDirectory) {
    const reader = (entry as WebkitDirectoryEntry).createReader();
    const children: WebkitEntry[] = [];
    for (;;) {
      const batch = await readDirectoryBatch(reader);
      if (!batch.length) break;
      children.push(...batch);
    }
    return (await Promise.all(children.map(collectEntry))).flat();
  }
  return [];
}

export function filesFromInput(files: FileList) {
  return [...files].map((file) => ({ file, path: normalizePath(file.webkitRelativePath || file.name) }));
}

export async function filesFromDrop(dataTransfer: DataTransfer) {
  const items = [...dataTransfer.items] as unknown as DataTransferItemWithEntry[];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is WebkitEntry => Boolean(entry));
  if (entries.length) return (await Promise.all(entries.map(collectEntry))).flat();
  return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
}

export async function loadPackageFromFiles(files: FileWithPath[]): Promise<UIRPackageData> {
  const diagnostics: PackageDiagnostic[] = [];
  const parsed = new Map<string, unknown>();
  for (const item of files.filter((entry) => entry.path.toLowerCase().endsWith(".json"))) {
    try {
      parsed.set(item.path, JSON.parse(await item.file.text()));
    } catch {
      diagnostics.push({ severity: "error", code: "json.invalid", message: "Invalid JSON", path: item.path });
    }
  }

  const manifestCandidate = [...parsed.entries()]
    .filter(([path, value]) => path.endsWith("package.json") && isManifest(value))
    .sort(([a], [b]) => a.split("/").length - b.split("/").length)[0];
  if (!manifestCandidate) throw new Error("No UIR package manifest found. Choose the package directory containing package.json or a .uir.zip archive.");

  const [manifestPath, manifestValue] = manifestCandidate;
  const manifest = manifestValue as UIRManifest;
  const root = manifestPath.slice(0, -"package.json".length);
  const shards: Record<string, UIRShard> = {};
  diagnostics.push({ severity: "success", code: "manifest.found", message: `Manifest ${manifest.packageId} · ${manifest.packageVersion}`, path: manifestPath });

  if (manifest.formatVersion !== "1.0") {
    diagnostics.push({ severity: "warning", code: "format.version", message: `Format ${manifest.formatVersion} is read on a best-effort basis; the Playground reference format is 1.0.`, path: manifestPath });
  }

  for (const entry of manifest.model) {
    // **Validated per entry, and one bad entry costs that entry only.** Nothing
    // checked the shape: `{"sha256": 123}` reached `.toLowerCase()` on a number
    // and `{"path": null}` reached `.replaceAll` on null, and either TypeError
    // propagated out of this function and reached the visitor as a raw message
    // in the error bar, throwing the whole package away. The missing-shard
    // branch below already had the right answer for a broken entry — a
    // diagnostic — and this is that answer applied one step earlier.
    if (!entry || typeof entry.collection !== "string" || typeof entry.path !== "string"
        || (entry.sha256 !== undefined && typeof entry.sha256 !== "string")) {
      diagnostics.push({ severity: "error", code: "model.invalid", message: "Manifest model entry is not a readable collection/path pair", path: manifestPath });
      continue;
    }
    const relativePath = normalizePath(entry.path).replace(/^\.\//, "");
    const expectedPath = normalizePath(`${root}${relativePath}`);
    const fileItem = files.find((item) => normalizePath(item.path) === expectedPath)
      ?? files.find((item) => normalizePath(item.path).endsWith(`/${relativePath}`));
    const parsedShard = parsed.get(expectedPath)
      ?? [...parsed.entries()].find(([path]) => normalizePath(path).endsWith(`/${relativePath}`))?.[1];

    if (!fileItem || !parsedShard || typeof parsedShard !== "object") {
      diagnostics.push({ severity: "error", code: "model.missing", message: `Missing model collection ${entry.collection}`, path: entry.path });
      continue;
    }

    // **VERIFIED FIRST, admitted second.** The shard used to be registered on
    // the line above the ledger check, so a package whose `sha256` mismatched
    // was parsed, rendered on the canvas, walked by the graph and used as a
    // diff side — the only trace a red row inside a drawer that starts closed.
    // `README.md` says the browser verifies the ledger *before the package is
    // presented as verified*; this ordering is what makes that sentence true.
    if (entry.sha256) {
      const actual = await sha256(fileItem.file);
      if (!actual) {
        // **Name the ORIGIN, because the package is not where the answer is.**
        // `crypto.subtle` is absent on any page that is not a secure context —
        // not an exotic browser, but plain `http://` on anything other than
        // `localhost`. This tool ships desktop/tablet/phone canvas widths, so
        // checking the phone width on a real phone means `npm run dev -- --host`
        // and opening `http://192.168.x.x:5173` from the device. Every shard
        // that declares a `sha256` — the well-formed packages, the ones doing
        // the right thing — then fails here, `shards` stays empty and the canvas
        // reads "No renderable tree". It fails loudly, which is right; a message
        // that sends the reader to inspect the package would send them to the
        // wrong place.
        diagnostics.push({
          severity: "warning", code: "hash.unavailable",
          message: `Web Crypto is unavailable on this origin, so the SHA-256 of ${entry.collection} cannot be checked and the shard is not loaded. This is the page's origin, not the package: crypto.subtle exists only in a secure context — https, or localhost. Open this tool over https or on localhost.`,
          path: entry.path,
        });
        continue;
      }
      if (actual !== entry.sha256.toLowerCase()) {
        diagnostics.push({ severity: "error", code: "hash.mismatch", message: `SHA-256 mismatch for ${entry.collection}; the shard is not loaded`, path: entry.path });
        continue;
      }
      diagnostics.push({ severity: "success", code: "hash.verified", message: `Verified ${entry.collection}`, path: entry.path });
    } else {
      // A shard with no ledger entry used to produce NO diagnostic at all, so a
      // manifest that declared nothing showed a cleaner bill of health than one
      // that declared hashes and failed them. Declaring less must not read as
      // being sounder.
      diagnostics.push({ severity: "warning", code: "hash.absent", message: `${entry.collection} declares no SHA-256; it is loaded unverified`, path: entry.path });
    }
    shards[entry.collection] = parsedShard as UIRShard;
  }

  const sourceName = root.replace(/\/$/, "").split("/").at(-1) || manifest.packageId;
  return { manifest, shards, sourceName, diagnostics };
}
