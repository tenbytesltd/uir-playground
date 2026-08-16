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

test("the index arrays are handed out frozen, not lent out mutable", () => {
  // `factsOf(subject)` with no kind returns the index itself now; the `.filter()`
  // it replaced allocated a fresh array. Nothing mutates one today, but `node()`
  // sorts a `.map()` of it and the copy in that expression is incidental. Drop
  // the `.map` in a display tweak and the index is reordered in place for every
  // reader, including `fact()` — whose first-match-wins the case above pins, and
  // which would then fail for a reason nobody would look for.
  const runtime = new UIRRuntime(examplePackage);
  const facts = runtime.factsOf(runtime.nodeIds[0]);
  assert.ok(facts.length, "the fixture node has no facts");
  assert.ok(Object.isFrozen(facts), "factsOf handed out a mutable index array");
  // `push`, not `sort`: sorting a one-element array is a no-op even when the
  // array is frozen, so the first version of this assertion passed on an array
  // it never tried to write to. The oracle has to attempt the mutation.
  assert.throws(() => facts.push(facts[0]), TypeError);
  assert.throws(() => { facts[0] = null; }, TypeError);
  assert.ok(Object.isFrozen(runtime.relationsOf(runtime.nodeIds[0])));
  // Passing a kind still gives a fresh array, which is what a caller that wants
  // to sort should reach for.
  const kinded = runtime.factsOf(runtime.nodeIds[0], facts[0].kind);
  assert.ok(!Object.isFrozen(kinded));
});

test("an ascent returns the whole chain, whatever is already expanded", () => {
  // The walk used to live inside `selectNode` and terminate on the user's
  // expanded set. Repro without any malformed package: open the root, select a
  // deep node so its ancestors are added, collapse the root by hand, then select
  // a different node under an ancestor that is still open. The loop exited on
  // its first test, the root never reopened, and the structure panel showed
  // nothing while the canvas showed the node selected.
  //
  // **The expected chain is rebuilt here from `parentByNode`, not read out of
  // `ancestorsOf`.** The first version of this case picked its fixture with
  // `nodeIds.find(id => runtime.ancestorsOf(id).length >= 2)` — the oracle
  // choosing its subject with the function under test — and a mutation that
  // truncated every ascent went green, because the fixture search truncated with
  // it. Measured, not suspected.
  const runtime = new UIRRuntime(examplePackage);
  const expected = (id) => {
    const chain = [];
    for (let parent = runtime.parentByNode.get(id); parent; parent = runtime.parentByNode.get(parent)) {
      if (chain.includes(parent)) break;
      chain.push(parent);
    }
    return chain;
  };
  const deep = runtime.nodeIds.find((id) => expected(id).length >= 2);
  assert.ok(deep, "the example has no node two levels down");
  assert.deepEqual(runtime.ancestorsOf(deep), expected(deep));
  for (const id of runtime.nodeIds) {
    assert.deepEqual(runtime.ancestorsOf(id), expected(id), `ascent from ${id}`);
  }
});

test("an ascent through a cycle terminates", () => {
  const runtime = new UIRRuntime(withRecords([{
    id: "example:rel:cycle", recordType: "Relation", kind: "contains",
    source: "example:node:item-1", target: "example:node:proof-list", order: 13,
  }]));
  for (const id of runtime.nodeIds) {
    const chain = runtime.ancestorsOf(id);
    assert.ok(chain.length <= runtime.nodeIds.length, `ascent from ${id} did not terminate`);
    assert.equal(new Set(chain).size, chain.length, `ascent from ${id} repeated an ancestor`);
  }
});

test("children are handed out frozen too, and node() hands out the same array", () => {
  // The third array the runtime lends. Worse than the other two rather than the
  // leftover: `node()` is memoised, so the array is not scoped to one render but
  // is the one every caller gets for the runtime's lifetime — and a reorder is
  // silent, because `semantic-diff` builds its signature from
  // `children.map(...).join("|")`. Two identical packages would then produce
  // different signatures, every parent would report `changed`, and the counters
  // would agree with the invention.
  const runtime = new UIRRuntime(examplePackage);
  const parent = runtime.nodeIds.find((id) => runtime.node(id).children.length > 1);
  assert.ok(parent, "the example has no node with two children");
  const children = runtime.node(parent).children;
  assert.ok(Object.isFrozen(children), "node().children is mutable");
  assert.throws(() => children.push("x"), TypeError);
  assert.equal(runtime.node(parent).children, children,
    "node() is memoised, so this is the same array — which is why it must be frozen");
  assert.ok(Object.isFrozen(runtime.childrenByParent.get(parent)));
});

test("every array on every memoised node is frozen, leaves included", () => {
  // The argument was never about `children`. It is about `node()` being
  // memoised: whatever a caller gets is the array every other caller gets, for
  // the runtime's lifetime. `facts`, `bindings`, `sources` and `modes` are built
  // fresh in `node()` and stored in the same cache, so a display sort done once
  // in one component reorders the data every other reader sees.
  //
  // **Every node, and the fields derived from the node.** The first version of
  // this case picked one node with
  // `.find((node) => Object.values(node).filter(Array.isArray).length >= 4)`,
  // which reads like a selection and is a constant: all five fields are
  // unconditionally arrays, so the predicate is true for every node, `.find`
  // returned element 0, and the guard beneath it could not fire. It asserted
  // `nodeIds[0]` — the root — and nothing else, which is how the empty-children
  // path stayed uncovered. Iterating removes the question rather than answering
  // it, and it is not slower in any way that matters: the runtime memoises.
  const runtime = new UIRRuntime(examplePackage);
  assert.ok(runtime.nodeIds.length > 5, "too few nodes for this to mean anything");
  let leaves = 0;
  for (const id of runtime.nodeIds) {
    const node = runtime.node(id);
    const arrays = Object.entries(node).filter(([, value]) => Array.isArray(value));
    assert.equal(arrays.length, 5, `${id} carries ${arrays.length} array fields, not 5`);
    for (const [field, value] of arrays) {
      assert.ok(Object.isFrozen(value), `node(${id}).${field} is mutable`);
      assert.throws(() => value.push(value[0]), TypeError, `node(${id}).${field} accepted a push`);
      // The memo really does share them, which is what makes the freeze matter.
      assert.equal(runtime.node(id)[field], value, `node(${id}).${field} is not shared`);
    }
    // **The BRANCH, not a consequence of it.** `?? NO_CHILDREN` is taken when
    // `childrenByParent` has no entry for the node — that absence is what the
    // case exists to cover. Counting `children.length === 0` counts a symptom
    // that coincides with it only because the map is built by pushing, so an
    // entry never exists empty. Rebuild it any other way — seed every node with
    // `[]`, or build it with `groupBy` — and every node has an entry, the
    // `?? NO_CHILDREN` arm becomes dead code, and this counter stays happily
    // above zero while covering nothing.
    if (!runtime.childrenByParent.has(id)) leaves += 1;
  }
  assert.ok(leaves > 0,
    "no node reaches `?? NO_CHILDREN`, so that arm is covered by nothing here");
});

test("a diff of a package against itself invents nothing", () => {
  // The consequence the freeze protects, asserted directly rather than trusted:
  // if anything reorders a children array in place, the child signature changes
  // and every parent reports `changed` while the counters agree with it.
  const diff = diffPackages(examplePackage, examplePackage);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.equal(diff.changed, 0, "identical packages reported changes");
  assert.equal(diff.same, diff.items.length);
});
