import { filesFromDrop, filesFromInput, loadPackageFromFiles, type FileWithPath } from "./package-loader.ts";
import type { PackageDiagnostic, UIRManifest, UIRPackageData } from "./runtime.ts";

const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export type PackageSource = { kind: "example" | "local" | "remote"; label: string; url?: string };

function cleanArchivePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "..")) throw new Error(`Unsafe ZIP entry path: ${path}`);
  return parts.join("/");
}

function u16(view: DataView, offset: number) { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number) { return view.getUint32(offset, true); }

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, which since
// TypeScript 5.7 means `Uint8Array<ArrayBufferLike>` — a view that MIGHT be
// backed by a `SharedArrayBuffer`, and `Blob` does not accept one. Nothing here
// ever is: every view in this file comes from `file.arrayBuffer()`, from a
// `subarray` of it, or from `Response.arrayBuffer()`, each of which is a plain
// `ArrayBuffer`. The annotation states what the code already guarantees, which
// is not the same thing as casting the guarantee away.
async function inflateRaw(bytes: Uint8Array<ArrayBuffer>) {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress deflated ZIP files. Open the package directory instead.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(file: File): Promise<FileWithPath[]> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const minEocd = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minEocd; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Invalid ZIP: end-of-central-directory record not found.");

  const entryCount = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported yet.");
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`ZIP contains ${entryCount} entries; limit is ${MAX_ZIP_ENTRIES}.`);

  const decoder = new TextDecoder("utf-8");
  const entries: FileWithPath[] = [];
  let totalUncompressed = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || u32(view, cursor) !== 0x02014b50) throw new Error("Invalid ZIP central directory.");
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const fileNameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const rawName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + fileNameLength));
    cursor += 46 + fileNameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`Encrypted ZIP entry not supported: ${rawName}`);
    if (rawName.endsWith("/")) continue;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 entries are not supported yet.");

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error("ZIP expands beyond the 64 MiB safety limit.");
    if (localOffset + 30 > bytes.length || u32(view, localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${rawName}.`);

    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array<ArrayBuffer>;
    if (method === 0) data = compressed.slice();
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`ZIP compression method ${method} is not supported (${rawName}).`);
    if (data.byteLength !== uncompressedSize) throw new Error(`ZIP entry size mismatch for ${rawName}.`);

    const path = cleanArchivePath(rawName);
    const blob = new Blob([data], { type: path.endsWith(".json") ? "application/json" : "application/octet-stream" });
    entries.push({ file: new File([blob], path.split("/").at(-1) ?? "entry", { type: blob.type }), path });
  }
  return entries;
}

export async function loadPackageFromZip(file: File): Promise<UIRPackageData> {
  const pkg = await loadPackageFromFiles(await unzip(file));
  pkg.diagnostics.unshift({ severity: "success", code: "archive.loaded", message: `Read ${file.name} locally in browser memory`, path: file.name });
  pkg.sourceName = file.name.replace(/\.zip$/i, "");
  return pkg;
}

function isZipUrl(url: URL) { return /(?:\.uir)?\.zip$/i.test(url.pathname); }

async function githubToRaw(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "github.com" || parts.length < 2) return undefined;
  const [owner, repoWithGit] = parts;
  const repo = repoWithGit.replace(/\.git$/i, "");
  if (parts[2] === "blob" && parts[3]) return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${parts[3]}/${parts.slice(4).join("/")}`);
  if (parts[2] === "tree" && parts[3]) {
    const path = parts.slice(4).join("/").replace(/\/$/, "");
    return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${parts[3]}/${path ? `${path}/` : ""}package.json`);
  }
  if (parts.length === 2) {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub repository lookup failed (${response.status}).`);
    const metadata = await response.json() as { default_branch?: string };
    if (!metadata.default_branch) throw new Error("GitHub did not return a default branch.");
    return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${metadata.default_branch}/package.json`);
  }
  return undefined;
}

export async function resolveRemotePackageUrl(input: string) {
  const value = input.trim();
  if (!value) throw new Error("Enter a package URL or GitHub repository URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid https:// URL."); }
  if (url.protocol !== "https:") throw new Error("Remote packages must use HTTPS.");
  const raw = await githubToRaw(url);
  if (raw) url = raw;
  if (!isZipUrl(url) && !url.pathname.endsWith("package.json")) url.pathname = `${url.pathname.replace(/\/$/, "")}/package.json`;
  return url;
}

async function fetchChecked(url: URL) {
  let response: Response;
  try { response = await fetch(url, { mode: "cors", credentials: "omit" }); }
  catch { throw new Error(`Could not fetch ${url.href}. The host must allow browser CORS.`); }
  if (!response.ok) throw new Error(`Remote package request failed (${response.status}) for ${url.href}.`);
  return response;
}

function looksLikeManifest(value: unknown): value is UIRManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<UIRManifest>;
  return typeof manifest.packageId === "string" && typeof manifest.packageVersion === "string" && Array.isArray(manifest.model);
}

export async function loadPackageFromUrl(input: string): Promise<{ pkg: UIRPackageData; resolvedUrl: string }> {
  const resolved = await resolveRemotePackageUrl(input);
  if (isZipUrl(resolved)) {
    const response = await fetchChecked(resolved);
    const blob = await response.blob();
    const name = resolved.pathname.split("/").at(-1) || "remote.uir.zip";
    const pkg = await loadPackageFromZip(new File([blob], name, { type: blob.type || "application/zip" }));
    pkg.diagnostics.unshift({ severity: "success", code: "remote.loaded", message: `Loaded remote archive from ${resolved.hostname}`, path: resolved.href });
    return { pkg, resolvedUrl: resolved.href };
  }

  const manifestResponse = await fetchChecked(resolved);
  const manifestText = await manifestResponse.text();
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(manifestText); } catch { throw new Error("Remote package manifest is not valid JSON."); }
  if (!looksLikeManifest(manifestValue)) throw new Error("Remote package.json is not a recognizable UIR manifest.");

  const files: FileWithPath[] = [{ file: new File([manifestText], "package.json", { type: "application/json" }), path: "package.json" }];
  const root = new URL("./", resolved);
  // The archive path caps entries; this one capped nothing, so a manifest
  // declaring 20,000 shards was 20,000 sequential fetches from the visitor's
  // browser with no way to cancel. Same limit, same reason.
  if (manifestValue.model.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Remote manifest declares ${manifestValue.model.length} model entries; limit is ${MAX_ZIP_ENTRIES}.`);
  }
  for (const entry of manifestValue.model) {
    // **`entry.path` is whatever the manifest says, and `new URL(x, root)` only
    // stays under `root` while `x` is relative.** `looksLikeManifest` checks
    // `Array.isArray(model)` and nothing about the entries, so
    // `"path": "https://elsewhere.example/beacon?v=1"` discarded `root` and this
    // loop fetched it. `credentials: "omit"` and CORS stop the RESPONSE being
    // read; they do not stop the REQUEST being sent, and a beacon needs only the
    // request. `?source=` is fetched on page load, so one shared link aimed every
    // visitor's browser wherever the manifest author chose — including at hosts
    // only that visitor's network can route to.
    //
    // Checked on the RESOLVED url rather than by pattern-matching the string:
    // `./x`, `%2e%2e/x` and `/../x` all differ as text and resolve identically,
    // and it is the resolution that decides where the fetch goes.
    if (typeof entry.path !== "string" || !entry.path) {
      throw new Error("Remote manifest has a model entry without a path.");
    }
    let shardUrl: URL;
    try { shardUrl = new URL(entry.path, root); }
    catch { throw new Error(`Remote manifest declares an unreadable model path: ${entry.path}`); }
    if (!shardUrl.href.startsWith(root.href)) {
      throw new Error(`Remote model entry leaves the package: ${entry.path}`);
    }
    const response = await fetchChecked(shardUrl);
    const text = await response.text();
    files.push({ file: new File([text], entry.path.split("/").at(-1) || "model.json", { type: "application/json" }), path: entry.path.replace(/^\.\//, "") });
  }

  const pkg = await loadPackageFromFiles(files);
  const remoteDiagnostic: PackageDiagnostic = { severity: "success", code: "remote.loaded", message: `Loaded public package from ${resolved.hostname}`, path: resolved.href };
  pkg.diagnostics.unshift(remoteDiagnostic);
  pkg.sourceName = `${manifestValue.packageId} · remote`;
  return { pkg, resolvedUrl: resolved.href };
}

export async function loadPackageFromSelection(files: FileWithPath[]) {
  if (files.length === 1 && /(?:\.uir)?\.zip$/i.test(files[0].file.name)) return loadPackageFromZip(files[0].file);
  return loadPackageFromFiles(files);
}

export { filesFromDrop, filesFromInput };
