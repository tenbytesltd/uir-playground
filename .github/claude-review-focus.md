# What a review of this repository should look for

Deliberately not in `.github/workflows/`: kept as ordinary repo content so that
tuning these standards happens in a pull request that still gets reviewed. The
workflow that reads it refuses to run when a pull request's copy of the WORKFLOW
differs from the default branch's, so a focus kept in there would blind the very
pull request that tunes it.

## What this codebase is

A browser tool that opens a [UIR](https://github.com/tenbytesltd/uir) package —
from a local folder, a `.uir.zip`, a URL or a GitHub repository — and shows what
the interface it describes MEANS: the semantic tree, the role → design-system
resolution, presentation bindings, provenance, declared gaps, a graph and a
semantic diff. Vite + React + TypeScript, no backend, no server, no database.

Every source resolves to one `UIRPackageData` and every view reads one
`UIRRuntime` (`src/runtime.ts`). A change that gives a view its own parser is a
finding on its own, whatever else it does.

**This repository is PUBLIC.** It carries no measurement, no client, and no
figure. The figures UIR publishes about real code are measured in
`tenbytesltd/uir`, live in that repository's `docs/MEASURED.md`, and stay
private. A client's name, a customer's package, a screenshot of one, or a
an absolute path rooted on somebody's machine in a document — the kind that
starts with a home or user directory — are all the same finding: a private subject
reaching a repository that ships. It is the most serious finding available here.

## The defect class this project exists inside

**A number that improves, or a check that goes green, because something was not
looked at.** The parent project has a ledger of these; this tool is the surface
where a reader meets a package, so its version of the class is:

> *a package that declares less gets a cleaner bill of health than a package that
> declares more.*

Both instances that prompted this section are now closed, and they are recorded
because the shape recurs, not because the lines are still wrong:

- `if (!entry.sha256) continue` produced **no diagnostic at all**, so a manifest
  that declared hashes and failed them showed errors while one that declared none
  showed a clean bar. Stripping the ledger was the cheapest way to a green
  package. Now an absent ledger is a `hash.absent` warning.
- a mismatching shard was registered on the line ABOVE the ledger check, so it
  was parsed, rendered, walked by the graph and used as a diff side anyway, with
  one red row inside a drawer that starts closed as the only trace. Verification
  now precedes admission, and `README.md` says what the code does.

For any change touching diagnostics, verification or the counters in the
Diagnostics bar (`src/Playground.tsx:99`), ask what it would take to make a
package look *better* by declaring *less*. If there is an answer, that is the
finding.

## A limit is only a limit if it bounds what it names

`src/source-layer.ts:64` adds `uncompressedSize` — read from the archive's own
central directory — and refuses past 64 MiB. Then `src/source-layer.ts:74`
inflates, and `src/source-layer.ts:76` compares the result against the same
declared number. An archive that declares 1 KiB and ships a deflate stream
expanding to 1 GiB passes the limit, is fully decompressed into memory by
`inflateRaw`, and is only then found to be a lie. The cap is enforced against the
attacker's own statement about the thing the cap exists to bound.

The same shape applies to `MAX_ZIP_ENTRIES`, to any future asset budget, and to
any check phrased as *"the file says it is small"*. **A budget must be measured
against what was actually produced, not against what the input claims it will
produce.**

## Untrusted input, and where the boundary actually is

Every package this tool opens is untrusted — a stranger's ZIP, a stranger's URL,
a stranger's `package.json`. The boundary is worth reviewing at these points:

- `src/PlaygroundLab.tsx:86` — `?source=` and `?compare=` are **fetched on
  page load**, before any interaction. A link is therefore an instruction to the
  visitor's browser to fetch and render a chosen package, which is what turns
  every other item in this section from a bug into something a stranger can aim.
  `credentials: "omit"` and browser CORS keep the RESPONSE from being read; they
  do not keep the REQUEST from being sent, and a beacon needs only the request —
  which is why `loadPackageFromUrl` now refuses a model path that resolves
  outside the package rather than trusting the manifest.
- `src/source-layer.ts:9` `cleanArchivePath` is the only defence against ZIP
  entry paths escaping the package. It is a string check on a path that later
  becomes a lookup key.
- `src/runtime.ts:201` restricts a rendered `href` to `https://`. A rendered
  link whose target comes from package data must stay restricted; `javascript:`
  and `data:` reaching `src/Playground.tsx:41` would be an XSS in a tool whose
  whole job is to open strangers' files.
- `src/runtime.ts:296` `styleForNode` puts package-derived strings into a React
  `style` object. Values assembled by string concatenation (`cssScalar`,
  `cssGradient`) are the place a package could try to say something the tool did
  not mean to say.
- `src/source-layer.ts:105` reaches `api.github.com` unauthenticated. Rate
  limiting and error text are user-visible behaviour, not an implementation
  detail.

## What the gate does not cover, named rather than implied

`npm run check`, `npm test` and `npm run build` are the whole gate. Three tests
exist, and this is what they actually assert:

- `tests/public-ready.test.mjs` matches **prose in `README.md`** and the string
  `actions/deploy-pages` in a workflow. It cannot fail when the privacy boundary
  breaks; it fails when the README is reworded. It tests a document's wording,
  not the program's behaviour.
- `tests/source-contract.test.mjs` greps `src/source-layer.ts` for
  `credentials:\s*"omit"` and greps two components for button labels. A regex
  over source text is a claim that a line exists, not that the fetch omits
  credentials or that the button does anything.

That was the whole of it. `tests/runtime-behaviour.test.mjs` and
`tests/untrusted-package.test.mjs` now execute the runtime, the loader and the
remote path — cycle detection, index equivalence against a re-derived scan,
ledger verification, model-path containment — and every case was checked by
mutating the code it covers.

**Still not executed by anything: rendering.** There is no DOM environment, so
`CanvasNode`, `TreeNode` and the inspector are reached by no test. The cycle
guard in those three walkers is asserted indirectly, through the detector and
through `allNodes()`, not by rendering a cyclic package. A review should treat
"the tests pass" as saying something about `src/runtime.ts`, `src/package-loader.ts`
and `src/source-layer.ts`, and nothing about `src/Playground.tsx`.

Two more gaps in the build flow itself:

- **There is no lockfile.** `.github/workflows/ci.yml` and
  `.github/workflows/pages.yml` both run `npm install`, so every run resolves
  transitive dependencies fresh. Direct dependencies are exact-pinned in
  `package.json`, which is what has hidden this so far. On a public repository
  this is also the supply-chain surface: `npm install` executes install scripts
  from whatever resolved today. `npm ci` against a committed
  `package-lock.json` is the fix.
- **`pages.yml` deploys without running the tests.** It builds and publishes on
  push to the default branch, independently of `ci.yml`. Nothing orders them.

## Shapes that have recurred across this project

- **A hand-written list of places that must be complete.** Derive it; a list a
  human maintains goes stale silently.
- **A check that passes on a neighbour's evidence checks nothing.** Both tests in
  this repository are instances.
- **Prose about the program, in the program's own documents, that the program
  falsifies.** `README.md:29` is the live one.
- **A guard that does not survive its own rule.** Ask of every new guard: what
  input makes this guard the thing that fails? The sibling repository's path
  check failed on itself five commits running, each time because a comment
  spelled out an example of the thing being detected. **No rule stated in this
  file spells out an instance of what it forbids**, for the same reason: the day
  this repository grows a scanner, the illustration is the finding.
- **A picture is a claim.** A badge, a counter or a bar that encodes a
  proportion nobody computed is a false statement even when it looks right.

## Conventions worth defending

- One runtime. `UIRRuntime` is the only reader of package records.
- The source layer is separate from the runtime, and stays that way.
- Roles are read from the package. `src/runtime.ts:161` and
  `src/semantic-diff.ts:11` both hardcode the `:node:` id convention; a package
  that does not use it degrades quietly in the diff. Worth fixing, worth naming
  in any change nearby.
- `src/example.ts` is the built-in package a first-time visitor sees. It
  currently names a node `hero` (`src/example.ts:6`) — a word the parent
  repository's generic-language audit bans precisely because it names one
  product's screen rather than any interface. The example should describe an
  interface generically, like the language it demonstrates.

## Where this repository sits

- `tenbytesltd/uir` — the language, the reader, the measurer. Private.
- `tenbytesltd/uir-public-site` — explains the project. Public.
- **this repository** — the tool you point at a real package. Public.

A change that belongs in one of the other two is a finding here, and the reverse
holds: this repository must not grow an explanation of the language, and must not
grow a measurement of anyone's code.
