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

Both live instances at the time this file was written:

- `src/package-loader.ts:109` — `if (!entry.sha256) continue`. A manifest entry
  with no ledger hash produces **no diagnostic at all**. A manifest that declares
  hashes and fails them shows errors; a manifest that declares none shows a clean
  bar. Stripping the ledger is the cheapest way to a green package.
- `src/package-loader.ts:111` — a missing Web Crypto is a `warning` and the
  package loads anyway, while `README.md:29` states the browser verifies the
  ledger *"before the package is presented as verified"*. There is no verified
  state: `UIRPackageData` (`src/runtime.ts:47`) has no such field and nothing
  gates on one. That sentence is a claim the code does not implement.

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
  visitor's browser to fetch and render a chosen package. `credentials: "omit"`
  and browser CORS are what keep that from reaching the visitor's own data;
  neither is tested (see below), and a change that relaxes either is serious.
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

So: **no test in this repository executes a load, a ZIP, a fetch, a render or a
diff.** There is no DOM test environment. Nothing exercises `UIRRuntime`,
`diffPackages` or `loadPackageFromFiles` on so much as the built-in example, and
`src/example.ts` is right there as a fixture. A review should treat "the tests
pass" as carrying almost no information about a change to `src/`, and should say
so when a pull request leans on it.

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
