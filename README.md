# UIR Playground

**Inspect what the interface means.**

UIR Playground is the standalone developer tool for opening, rendering and inspecting [UIR](https://github.com/tenbytesltd/uir) packages. It is intentionally separate from the UIR public site: the public site explains the project; this repository is the tool you use on real packages.

## What you can test

- Open a local UIR package folder.
- Drop a local folder or `.uir.zip` archive anywhere on the Playground.
- Load a public `package.json`, `.uir.zip`, or GitHub URL.
- Inspect the semantic tree and select the same node in the rendered canvas.
- Switch between Render, Semantics, Resolution, Provenance and Gaps views.
- Inspect semantic facts, role → design-system resolution, presentation bindings, provenance and raw records.
- View a semantic graph.
- Set the current package as a baseline, load another package, and inspect a semantic diff.
- Share a deep link for public remote packages.

## Privacy model

Local folders and ZIP archives are read **only in browser memory**. There is no backend, upload endpoint, account or persistent storage: nothing is uploaded by the Playground.

Remote loading is explicit. When you enter a public URL or GitHub URL, the browser fetches that source directly. The remote host must allow CORS. Deep links contain only the remote URL; they never contain local package data.

ZIP loading rejects parent-path traversal, encrypted archives, ZIP64, more than 5,000 entries, and archives that expand beyond 64 MiB.

## Package expectations

The loader looks for a UIR `package.json` manifest with `formatVersion`, `packageId`, `packageVersion`, and a `model` collection list. Model shards are loaded from the paths declared by the manifest. When a shard includes a `sha256` ledger entry, the browser verifies it with Web Crypto before the package is presented as verified.

The Playground currently treats UIR format `1.0` as its reference format. Other versions are opened on a best-effort basis and surfaced in Diagnostics.

## Develop

```bash
npm install --no-audit --no-fund
npm run dev
```

Verification:

```bash
npm run check
npm test
npm run build
```

## Deployment

The repository contains a GitHub Pages workflow. After the repository is made public and Pages is configured to use **GitHub Actions**, pushes to the default branch build and deploy the static Vite application.

## Architecture

```text
folder / .uir.zip / URL / GitHub
              │
              ▼
        source loaders
              │
              ▼
          UIRRuntime
       ┌──────┼──────┐
       ▼      ▼      ▼
    Inspect  Graph   Diff
```

The source layer is deliberately separate from `UIRRuntime`. Every source resolves to the same `UIRPackageData`, and Inspect/Graph/Diff consume the same semantic runtime instead of implementing separate parsers.

## License

Apache-2.0.
