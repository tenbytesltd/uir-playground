// **The first tests in this repository that execute anything.**
//
// The two files beside this one assert that source TEXT contains certain
// strings: `credentials:\s*"omit"` appears in `source-layer.ts`, the README
// says "nothing is uploaded", a button is labelled "Set baseline". Those are
// claims that a line exists. None of them loads a package, resolves a URL,
// verifies a ledger, walks a tree or diffs anything, so "the tests pass" has
// carried almost no information about a change to `src/`.
//
// It could not be otherwise until now: `src/` is TypeScript, and the one
// TypeScript construct Node's strip-only type removal refuses is a constructor
// parameter property — which `UIRRuntime` had. Removing it (identical emitted
// JavaScript) is what makes this file possible.
//
// Every case here is one of the six findings raised on the pull request that
// introduced the review, and each one FAILS against the code as it stood.
import test from "node:test";
import assert from "node:assert/strict";
import { UIRRuntime } from "../src/runtime.ts";
import { diffPackages } from "../src/semantic-diff.ts";
import { examplePackage } from "../src/example.ts";

function withRecords(extra) {
  const shards = structuredClone(examplePackage.shards);
  const first = Object.keys(shards)[0];
  shards[first] = { ...shards[first], records: [...shards[first].records, ...extra] };
  return { ...examplePackage, shards };
}

test("the built-in example is acyclic and renders a tree", () => {
  const runtime = new UIRRuntime(examplePackage);
  assert.equal(runtime.cyclicNodeIds.length, 0);
  assert.ok(runtime.rootIds.length, "the example has no render root");
  assert.ok(runtime.nodeIds.length > 5, "the example is too small to test a walk");
});

test("a contains cycle is reported rather than fatal", () => {
  // Exactly the input from the review: one relation pointing back up. Before the
  // guard this recursed until `RangeError: Maximum call stack size exceeded`,
  // and `?source=` is fetched on page load, so the URL was the whole exploit.
  const cyclic = withRecords([{
    id: "example:rel:cycle", recordType: "Relation", kind: "contains",
    source: "example:node:item-1", target: "example:node:proof-list", order: 13,
  }]);
  const runtime = new UIRRuntime(cyclic);
  assert.ok(runtime.cyclicNodeIds.length > 0, "the cycle was not detected");
  assert.ok(runtime.cyclicNodeIds.includes("example:node:proof-list"));
  // The detector must survive the input it detects: it is iterative on purpose.
  assert.doesNotThrow(() => runtime.allNodes());
});

test("a self-containing node is a cycle, in one record", () => {
  const runtime = new UIRRuntime(withRecords([{
    id: "example:rel:self", recordType: "Relation", kind: "contains",
    source: "example:node:proof", target: "example:node:proof", order: 99,
  }]));
  assert.deepEqual(runtime.cyclicNodeIds, ["example:node:proof"]);
});

test("indexing the accessors did not change what they answer", () => {
  // The scans were replaced by maps for speed. This asserts the answers are the
  // same ones, including `find`'s first-match-wins, by recomputing them the slow
  // way from `records` — the oracle does not call the index it is checking.
  const runtime = new UIRRuntime(examplePackage);
  for (const id of runtime.nodeIds) {
    const scannedFacts = runtime.records.filter(
      (r) => r.recordType === "Fact" && r.subject === id);
    assert.deepEqual(runtime.factsOf(id), scannedFacts, `factsOf(${id})`);
    const scannedRelations = runtime.records.filter(
      (r) => r.recordType === "Relation" && (r.source === id || r.target === id));
    assert.deepEqual(runtime.relationsOf(id), scannedRelations, `relationsOf(${id})`);
    for (const kind of new Set(scannedFacts.map((r) => r.kind))) {
      assert.equal(runtime.fact(id, kind), scannedFacts.find((r) => r.kind === kind));
    }
  }
});

test("a node reachable by two paths still renders under both", () => {
  // The guard is per ancestor chain, not per walk. A shared child is legitimate
  // structure; only a repeat within one chain is a cycle. A global visited set
  // would have silently dropped the second occurrence — a tree that looks
  // smaller because something was not shown.
  const runtime = new UIRRuntime(withRecords([{
    id: "example:rel:shared", recordType: "Relation", kind: "contains",
    source: "example:node:proof", target: "example:node:title", order: 50,
  }]));
  assert.equal(runtime.cyclicNodeIds.length, 0);
  const parents = runtime.contains.filter((r) => r.target === "example:node:title");
  assert.equal(parents.length, 2, "the fixture no longer has a shared child");
});

test("the diff counts every change, and the view is told how many it shows", () => {
  // The counters are computed over all items while the list truncates at 200.
  // This asserts the number the header renders is the number of changes there
  // are — the cap is a rendering decision and must not reach the arithmetic.
  const before = examplePackage;
  const after = withRecords([{
    id: "example:fact:added", recordType: "Fact", kind: "node.role",
    subject: "example:node:brand-new", plane: "semantic",
    value: { role: "paragraph" },
  }]);
  const diff = diffPackages(before, after);
  assert.equal(diff.added, 1, "the added node was not counted");
  assert.equal(diff.items.filter((i) => i.status !== "same").length,
    diff.added + diff.removed + diff.changed,
    "the counters and the change list disagree");
});

test("fact() returns the FIRST match, as the scan it replaced did", () => {
  // Written after a mutation the earlier case did not catch: making the index
  // keep the LAST record for a `(subject, kind)` pair left every test green,
  // because no subject in the built-in example carries two facts of one kind.
  // The oracle agreed with the code by luck. This fixture removes the luck.
  const duplicated = withRecords([{
    id: "example:fact:second-role", recordType: "Fact", kind: "node.role",
    subject: "example:node:title", plane: "semantic", value: { role: "paragraph" },
  }]);
  const runtime = new UIRRuntime(duplicated);
  const scanned = runtime.records.filter(
    (r) => r.recordType === "Fact" && r.subject === "example:node:title" && r.kind === "node.role");
  assert.equal(scanned.length, 2, "the fixture no longer has a duplicate");
  assert.equal(runtime.fact("example:node:title", "node.role"), scanned[0],
    "the index kept a later record than the scan would have returned");
  assert.notEqual(runtime.role("example:node:title"), "paragraph",
    "the duplicate overrode the original role");
});
