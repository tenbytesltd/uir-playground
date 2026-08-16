// **What a stranger's package is allowed to make this tool do.**
//
// Every package here is untrusted by construction — a stranger's folder, ZIP,
// URL or `package.json` — and `?source=` is fetched and rendered on page load,
// so a link is an instruction to the visitor's browser rather than an offer.
// Nothing in this repository executed that path before this file: the existing
// contract test greps `source-layer.ts` for the string `credentials: "omit"`,
// which is a claim that a line exists.
//
// `loadPackageFromUrl` reaches the network, so `fetch` is replaced with a
// recorder. The point of each case is what was REQUESTED, not what came back —
// `credentials: "omit"` and CORS stop the response being read and do not stop
// the request being sent, and a beacon needs only the request.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPackageFromUrl } from "../src/source-layer.ts";
import { loadPackageFromFiles } from "../src/package-loader.ts";

const HOST = "https://packages.example/p/";

function serve(manifest, shards = {}) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    if (href === `${HOST}package.json`) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    const body = shards[href];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return asked;
}

function json(path, value) {
  const text = JSON.stringify(value);
  return { file: new File([text], path.split("/").at(-1), { type: "application/json" }), path };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("an absolute model path does not make the browser fetch somewhere else", async () => {
  // The failing input from the review. `new URL(x, root)` stays under `root`
  // only while `x` is relative, and `looksLikeManifest` checks `Array.isArray`
  // and nothing about the entries — so this shipped a GET to a host of the
  // manifest author's choosing, from every visitor who opened the link.
  const asked = serve({
    packageId: "p", packageVersion: "1", formatVersion: "1.0",
    model: [{ collection: "c", path: "https://beacon.example/x?v=1" }],
  });
  await assert.rejects(() => loadPackageFromUrl(`${HOST}package.json`),
    /leaves the package/);
  assert.ok(!asked.some((href) => href.startsWith("https://beacon.example")),
    `the beacon was requested: ${asked.join(", ")}`);
});

test("parent traversal is refused on the RESOLVED url, not on the spelling", async () => {
  // `./x`, `/../x` and `%2e%2e/x` differ as text and resolve identically, and it
  // is the resolution that decides where the fetch goes. A regex over the string
  // would pass one of these.
  for (const path of ["../../internal/secret.json", "/etc/passwd", "%2e%2e/up.json"]) {
    const asked = serve({
      packageId: "p", packageVersion: "1", formatVersion: "1.0",
      model: [{ collection: "c", path }],
    });
    await assert.rejects(() => loadPackageFromUrl(`${HOST}package.json`),
      /leaves the package/, `accepted ${path}`);
    assert.deepEqual(asked, [`${HOST}package.json`], `${path} caused a second request`);
  }
});

test("the model list is capped like the archive's entry list", async () => {
  const asked = serve({
    packageId: "p", packageVersion: "1", formatVersion: "1.0",
    model: Array.from({ length: 5001 }, (_, i) => ({ collection: `c${i}`, path: `${i}.json` })),
  });
  await assert.rejects(() => loadPackageFromUrl(`${HOST}package.json`), /limit is 5000/);
  assert.equal(asked.length, 1, "shards were fetched before the cap was applied");
});

test("a relative model path is still loaded", async () => {
  // The refusals above are worth nothing if the ordinary case broke with them.
  const shard = { collection: "c", records: [] };
  serve(
    { packageId: "p", packageVersion: "1", formatVersion: "1.0",
      model: [{ collection: "c", path: "model/c.json" }] },
    { [`${HOST}model/c.json`]: shard },
  );
  const { pkg } = await loadPackageFromUrl(`${HOST}package.json`);
  assert.deepEqual(pkg.shards.c, shard);
});

test("a shard whose ledger does not match is not loaded", async () => {
  // It used to be registered on the line ABOVE the ledger check, so a mismatched
  // package was parsed, rendered, walked by the graph and used as a diff side,
  // with one red row inside a drawer that starts closed as the only trace.
  const good = { collection: "c", records: [] };
  const files = [
    json("package.json", {
      formatVersion: "1.0", packageId: "p", packageVersion: "1",
      model: [{ collection: "c", path: "c.json", sha256: "0".repeat(64) }],
    }),
    json("c.json", good),
  ];
  const pkg = await loadPackageFromFiles(files);
  assert.equal(pkg.shards.c, undefined, "the unverified shard was admitted");
  assert.ok(pkg.diagnostics.some((d) => d.code === "hash.mismatch" && d.severity === "error"));
});

test("a shard whose ledger matches is loaded", async () => {
  const good = { collection: "c", records: [] };
  const files = [
    json("package.json", {
      formatVersion: "1.0", packageId: "p", packageVersion: "1",
      model: [{ collection: "c", path: "c.json", sha256: await sha256Hex(good) }],
    }),
    json("c.json", good),
  ];
  const pkg = await loadPackageFromFiles(files);
  assert.deepEqual(pkg.shards.c, good);
  assert.ok(pkg.diagnostics.some((d) => d.code === "hash.verified"));
});

test("a shard declaring no ledger says so instead of passing quietly", async () => {
  // Declaring less must not read as being sounder. With no diagnostic at all, a
  // manifest that declared nothing showed a cleaner bill of health than one that
  // declared hashes and failed them.
  const files = [
    json("package.json", {
      formatVersion: "1.0", packageId: "p", packageVersion: "1",
      model: [{ collection: "c", path: "c.json" }],
    }),
    json("c.json", { collection: "c", records: [] }),
  ];
  const pkg = await loadPackageFromFiles(files);
  assert.ok(pkg.shards.c, "an unverified-but-declared shard should still open");
  assert.ok(pkg.diagnostics.some((d) => d.code === "hash.absent" && d.severity === "warning"));
});

test("one malformed model entry costs that entry, not the package", async () => {
  // `{"sha256": 123}` reached `.toLowerCase()` on a number and `{"path": null}`
  // reached `.replaceAll` on null; either TypeError propagated out and the
  // visitor saw the raw message with the whole package thrown away.
  const files = [
    json("package.json", {
      formatVersion: "1.0", packageId: "p", packageVersion: "1",
      model: [
        { collection: "bad-hash", path: "c.json", sha256: 123 },
        { collection: "bad-path", path: null },
        { collection: "c", path: "c.json" },
      ],
    }),
    json("c.json", { collection: "c", records: [] }),
  ];
  const pkg = await loadPackageFromFiles(files);
  assert.ok(pkg.shards.c, "the readable entry was lost with the broken ones");
  assert.equal(pkg.diagnostics.filter((d) => d.code === "model.invalid").length, 2);
});
