import { useEffect, useMemo, useRef, useState } from "react";
import { Playground } from "./Playground.tsx";
import { filesFromDrop, filesFromInput, loadPackageFromSelection, loadPackageFromUrl, type PackageSource } from "./source-layer.ts";
import { diffPackages } from "./semantic-diff.ts";
import { UIRRuntime, type UIRPackageData } from "./runtime.ts";

type LabView = "inspect" | "graph" | "diff";

function sourceLabel(source: PackageSource) {
  return source.kind === "example" ? "BUILT-IN EXAMPLE" : source.kind === "local" ? "LOCAL · PRIVATE" : "REMOTE · PUBLIC";
}

function GraphView({ pkg }: { pkg: UIRPackageData }) {
  const runtime = useMemo(() => new UIRRuntime(pkg), [pkg]);
  const nodes = runtime.allNodes().slice(0, 120);
  const included = new Set(nodes.map((node) => node.id));
  const depthCache = new Map<string, number>();
  // The cache is seeded BEFORE recursing, not after. Writing it afterwards meant
  // a `contains` cycle never hit a cached entry and this recursed until the stack
  // died — the memo was there and could not break the loop it was walking.
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id); if (cached !== undefined) return cached;
    depthCache.set(id, 0);
    const parent = runtime.parentByNode.get(id);
    const depth = parent && included.has(parent) ? depthOf(parent) + 1 : 0;
    depthCache.set(id, depth); return depth;
  };
  const columns = new Map<number, typeof nodes>();
  for (const node of nodes) { const depth = depthOf(node.id); const column = columns.get(depth) ?? []; column.push(node); columns.set(depth, column); }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, column] of columns) column.forEach((node, index) => positions.set(node.id, { x: 30 + depth * 220, y: 30 + index * 68 }));
  const width = 260 + Math.max(0, ...columns.keys()) * 220;
  const height = 80 + Math.max(1, ...[...columns.values()].map((column) => column.length)) * 68;
  return <section className="lab-view"><header className="lab-view-header"><div><span>SEMANTIC GRAPH</span><strong>{pkg.manifest.packageId}</strong></div><p>{nodes.length} nodes · contains relations · deterministic layout</p></header><div className="graph-scroll"><svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="UIR semantic graph"><g className="graph-edges">{nodes.flatMap((node) => node.children.filter((child) => included.has(child)).map((child) => { const from = positions.get(node.id); const to = positions.get(child); return from && to ? <line key={`${node.id}-${child}`} x1={from.x + 176} y1={from.y + 22} x2={to.x} y2={to.y + 22} /> : null; }))}</g><g className="graph-nodes">{nodes.map((node) => { const position = positions.get(node.id)!; const label = (node.content || node.key).replace(/\s+/g, " ").trim(); return <g key={node.id} transform={`translate(${position.x} ${position.y})`}><title>{node.id}</title><rect width="176" height="44" rx="8"/><text className="graph-role" x="10" y="15">{node.role}</text><text className="graph-label" x="10" y="32">{label.length > 25 ? `${label.slice(0, 24)}…` : label}</text></g>; })}</g></svg></div>{runtime.nodeIds.length > nodes.length ? <div className="limit-note">Graph preview capped at 120 nodes; Inspector reads the complete package.</div> : null}</section>;
}

function DiffView({ before, after }: { before: UIRPackageData; after: UIRPackageData }) {
  const diff = useMemo(() => diffPackages(before, after), [before, after]);
  const changes = diff.items.filter((item) => item.status !== "same");
  const visible = changes.slice(0, 200);
  return <section className="lab-view"><header className="lab-view-header"><div><span>SEMANTIC DIFF</span><strong>{before.manifest.packageVersion} → {after.manifest.packageVersion}</strong></div><p>Matched by stable semantic node key; compares meaning, resolution, bindings and children.</p></header><div className="diff-stats"><div><strong>+{diff.added}</strong><span>added</span></div><div><strong>−{diff.removed}</strong><span>removed</span></div><div><strong>{diff.changed}</strong><span>changed</span></div><div><strong>{diff.same}</strong><span>unchanged</span></div></div><div className="diff-list">{visible.length ? visible.map((item) => <article key={item.key} data-status={item.status}><span>{item.status}</span><div><strong>{item.after?.content || item.before?.content || item.key}</strong><code>{item.key}</code></div><p>{item.fields.join(" · ")}</p></article>) : <div className="lab-empty"><strong>No semantic changes.</strong><span>The snapshots resolve to the same semantic nodes.</span></div>}</div>{changes.length > visible.length ? <div className="limit-note">Showing {visible.length} of {changes.length} changed nodes; the counts above are over all of them.</div> : null}</section>;
}

export function PlaygroundLab({ initialPackage }: { initialPackage: UIRPackageData }) {
  const [pkg, setPackage] = useState(initialPackage);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<PackageSource>({ kind: "example", label: "Built-in example" });
  const [baseline, setBaseline] = useState(initialPackage);
  const [baselineSource, setBaselineSource] = useState<PackageSource>({ kind: "example", label: "Built-in example" });
  const [view, setView] = useState<LabView>("inspect");
  const [remoteInput, setRemoteInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const directoryInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    directoryInput.current?.setAttribute("webkitdirectory", "");
    directoryInput.current?.setAttribute("directory", "");
  }, []);

  const updateAddress = (nextSource: PackageSource, compareSource = baselineSource) => {
    const url = new URL(window.location.href);
    nextSource.kind === "remote" && nextSource.url ? url.searchParams.set("source", nextSource.url) : url.searchParams.delete("source");
    compareSource.kind === "remote" && compareSource.url ? url.searchParams.set("compare", compareSource.url) : url.searchParams.delete("compare");
    window.history.replaceState({}, "", url);
  };

  const applyPackage = (nextPackage: UIRPackageData, nextSource: PackageSource) => {
    setPackage(nextPackage); setSource(nextSource); setRevision((value) => value + 1); setMessage(undefined); updateAddress(nextSource);
  };

  const loadRemote = async (input: string) => {
    setLoading(true); setMessage(undefined);
    try {
      const { pkg: nextPackage, resolvedUrl } = await loadPackageFromUrl(input);
      const nextSource: PackageSource = { kind: "remote", label: new URL(resolvedUrl).hostname, url: resolvedUrl };
      applyPackage(nextPackage, nextSource); setRemoteInput(resolvedUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load remote UIR package."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const params = new URLSearchParams(window.location.search);
    const sharedSource = params.get("source");
    const sharedCompare = params.get("compare");
    if (sharedSource) void loadPackageFromUrl(sharedSource).then(({ pkg: sharedPackage, resolvedUrl }) => {
      const nextSource: PackageSource = { kind: "remote", label: new URL(resolvedUrl).hostname, url: resolvedUrl };
      setPackage(sharedPackage); setSource(nextSource); setRemoteInput(resolvedUrl); setRevision((value) => value + 1);
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load shared UIR package."));
    if (sharedCompare) void loadPackageFromUrl(sharedCompare).then(({ pkg: sharedPackage, resolvedUrl }) => {
      setBaseline(sharedPackage); setBaselineSource({ kind: "remote", label: new URL(resolvedUrl).hostname, url: resolvedUrl });
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load shared comparison package."));
  }, []);

  const openLocalFiles = async (files: ReturnType<typeof filesFromInput>) => {
    setLoading(true); setMessage(undefined);
    try { const nextPackage = await loadPackageFromSelection(files); applyPackage(nextPackage, { kind: "local", label: nextPackage.sourceName }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not read this UIR package."); }
    finally { setLoading(false); }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setDragging(false); setLoading(true); setMessage(undefined);
    try { const nextPackage = await loadPackageFromSelection(await filesFromDrop(event.dataTransfer)); applyPackage(nextPackage, { kind: "local", label: nextPackage.sourceName }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not read the dropped UIR package."); }
    finally { setLoading(false); }
  };

  const setCurrentAsBaseline = () => { setBaseline(pkg); setBaselineSource(source); updateAddress(source, source); setView("diff"); };
  const useExample = () => { const exampleSource: PackageSource = { kind: "example", label: "Built-in example" }; setBaseline(initialPackage); setBaselineSource(exampleSource); setPackage(initialPackage); setSource(exampleSource); setRevision((value) => value + 1); setMessage(undefined); updateAddress(exampleSource, exampleSource); };
  const copyDeepLink = async () => {
    if (source.kind !== "remote" || !source.url) { setMessage("Local packages stay local and cannot be encoded in a share link. Load a public URL/GitHub package first."); return; }
    updateAddress(source);
    try { await navigator.clipboard.writeText(window.location.href); setMessage("Deep link copied. It stores only the public package URL, never package data."); }
    catch { setMessage("The deep link is in the address bar. Copy the current URL to share it."); }
  };

  return <div className={`lab ${dragging ? "dragging" : ""}`} onDragEnterCapture={(event) => { event.preventDefault(); setDragging(true); }} onDragOverCapture={(event) => event.preventDefault()} onDragLeaveCapture={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDropCapture={(event) => void handleDrop(event)}>
    <input ref={directoryInput} className="hidden" type="file" multiple onChange={(event) => { if (event.currentTarget.files) void openLocalFiles(filesFromInput(event.currentTarget.files)); event.currentTarget.value = ""; }} />
    <input ref={zipInput} className="hidden" type="file" accept=".zip,.uir.zip,application/zip" onChange={(event) => { if (event.currentTarget.files) void openLocalFiles(filesFromInput(event.currentTarget.files)); event.currentTarget.value = ""; }} />
    <header className="appbar">
      <a className="brand" href="./"><span>UIR</span><strong>PLAYGROUND</strong></a>
      <div className="source-identity"><span>TEST CUSTOM UIR</span><strong>{source.label}</strong><small>{sourceLabel(source)}</small></div>
      <div className="local-actions"><button type="button" onClick={() => directoryInput.current?.click()}>Open folder</button><button type="button" onClick={() => zipInput.current?.click()}>Open .uir.zip</button></div>
      <form className="remote-form" onSubmit={(event) => { event.preventDefault(); void loadRemote(remoteInput); }}><input value={remoteInput} onChange={(event) => setRemoteInput(event.target.value)} placeholder="package URL or github.com/owner/repo" /><button type="submit" disabled={loading}>{loading ? "Loading…" : "Load URL"}</button></form>
      <div className="tool-tabs">{(["inspect", "graph", "diff"] as LabView[]).map((item) => <button key={item} type="button" className={view === item ? "active" : ""} onClick={() => setView(item)}>{item}</button>)}</div>
      <div className="more-actions"><button type="button" onClick={setCurrentAsBaseline}>Set baseline</button><button type="button" onClick={() => void copyDeepLink()} disabled={source.kind !== "remote"}>Copy link</button>{source.kind !== "example" ? <button type="button" onClick={useExample}>Example</button> : null}</div>
    </header>
    {message ? <div className="message"><span>{message}</span><button type="button" onClick={() => setMessage(undefined)}>×</button></div> : null}
    {dragging ? <div className="drop-overlay"><strong>Drop folder or .uir.zip</strong><span>Local package data stays in this browser tab.</span></div> : null}
    <div className="contextline"><span>current <strong>{pkg.manifest.packageId}@{pkg.manifest.packageVersion}</strong></span><span>baseline <strong>{baseline.manifest.packageId}@{baseline.manifest.packageVersion}</strong></span><span>{source.kind === "local" ? "No network path" : source.kind === "remote" ? "Explicit CORS fetch" : "Built-in sample"}</span></div>
    <div className="lab-content">{view === "inspect" ? <Playground key={`${pkg.manifest.packageId}:${pkg.manifest.packageVersion}:${revision}`} pkg={pkg} /> : null}{view === "graph" ? <GraphView pkg={pkg} /> : null}{view === "diff" ? <DiffView before={baseline} after={pkg} /> : null}</div>
  </div>;
}
