import type { PackageDiagnostic, UIRManifest, UIRPackageData, UIRShard } from "./runtime";

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

    shards[entry.collection] = parsedShard as UIRShard;
    if (!entry.sha256) continue;
    const actual = await sha256(fileItem.file);
    if (!actual) diagnostics.push({ severity: "warning", code: "hash.unavailable", message: `SHA-256 could not be verified for ${entry.collection}.`, path: entry.path });
    else if (actual !== entry.sha256.toLowerCase()) diagnostics.push({ severity: "error", code: "hash.mismatch", message: `SHA-256 mismatch for ${entry.collection}`, path: entry.path });
    else diagnostics.push({ severity: "success", code: "hash.verified", message: `Verified ${entry.collection}`, path: entry.path });
  }

  const sourceName = root.replace(/\/$/, "").split("/").at(-1) || manifest.packageId;
  return { manifest, shards, sourceName, diagnostics };
}
