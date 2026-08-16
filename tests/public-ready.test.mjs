import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("repository declares public deployment and privacy boundary", async () => {
  const readme = await read("../README.md");
  const pages = await read("../.github/workflows/pages.yml");
  assert.match(readme, /nothing is uploaded/i);
  assert.match(readme, /\.uir\.zip/);
  assert.match(readme, /GitHub URL/);
  assert.match(pages, /actions\/deploy-pages/);
});
