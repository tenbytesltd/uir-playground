import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/source-layer.ts", import.meta.url), "utf8");
const lab = await readFile(new URL("../src/PlaygroundLab.tsx", import.meta.url), "utf8");
const runtime = await readFile(new URL("../src/runtime.ts", import.meta.url), "utf8");

test("custom-source boundary stays explicit and local-first", () => {
  assert.match(source, /loadPackageFromZip/);
  assert.match(source, /loadPackageFromUrl/);
  assert.match(source, /MAX_ZIP_UNCOMPRESSED_BYTES/);
  assert.match(source, /credentials:\s*"omit"/);
  assert.match(lab, /Open \.uir\.zip/);
  assert.match(lab, /Open folder/);
  assert.match(lab, /Copy link/);
  assert.match(lab, /Set baseline/);
});

test("viewer, graph and diff share one runtime", () => {
  assert.match(runtime, /export class UIRRuntime/);
  assert.match(lab, /new UIRRuntime\(pkg\)/);
  assert.match(lab, /diffPackages\(before, after\)/);
});
