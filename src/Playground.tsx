import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useMemo, useState } from "react";
import { UIRRuntime, type PackageDiagnostic, type UIRNode, type UIRPackageData } from "./runtime.ts";

type CanvasMode = "render" | "semantics" | "resolution" | "provenance" | "gaps";
type TreeFilter = "all" | "gaps" | "unresolved" | "inferred";
type InspectorTab = "semantic" | "resolution" | "presentation" | "provenance" | "raw";
type Viewport = "desktop" | "tablet" | "phone";

const modeLabels: Record<CanvasMode, string> = { render: "Render", semantics: "Semantics", resolution: "Resolution", provenance: "Provenance", gaps: "Gaps" };

function concise(value: string, max = 44) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function modeBadge(node: UIRNode, mode: CanvasMode) {
  if (mode === "semantics") return node.role;
  if (mode === "resolution") return `${node.role} → ${node.pieceName}`;
  if (mode === "provenance") return node.modes.length ? node.modes.join(" · ") : "no provenance";
  if (mode === "gaps") return node.gap ? "explicit gap" : undefined;
  return undefined;
}

// `seen` is the ancestor chain, and it is not an optimisation. `contains` comes
// from the package and nothing validates it, so one relation pointing back up —
// or `A contains A` in a single record — made this function recurse until React
// threw `RangeError: Maximum call stack size exceeded` and the whole shell
// unmounted: white screen, no diagnostic, and Diagnostics itself unreachable
// because it unmounted too. `?source=` is fetched and rendered on page load, so
// the URL was the whole exploit.
//
// A new Set per branch rather than one shared across the walk: a node legitimately
// reachable by two different paths must still render under both. Only a repeat
// within one ANCESTOR CHAIN is a cycle.
function CanvasNode({ runtime, id, selectedId, mode, onSelect, seen = new Set<string>() }: { runtime: UIRRuntime; id: string; selectedId?: string; mode: CanvasMode; onSelect: (id: string) => void; seen?: Set<string> }) {
  const node = runtime.node(id);
  const branch = new Set(seen).add(id);
  const children = node.children.filter((child) => !branch.has(child)).map((child) => <CanvasNode key={child} runtime={runtime} id={child} selectedId={selectedId} mode={mode} onSelect={onSelect} seen={branch} />);
  const label = modeBadge(node, mode);
  const body = node.gap ?? node.content;
  const className = ["pg-node", selectedId === id ? "selected" : "", mode !== "render" ? "inspecting" : "", mode === "gaps" && node.gap ? "gap" : "", mode === "gaps" && !node.gap ? "dim" : ""].filter(Boolean).join(" ");
  const inspect = (event: ReactMouseEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation(); onSelect(id); };
  const common = { className, "data-node-id": id, "data-role": node.role, onClick: inspect, style: runtime.styleForNode(id) as CSSProperties };
  const badge = label ? <span className="node-badge">{label}</span> : null;
  switch (node.role) {
    case "document": return <main {...common}>{badge}{children}</main>;
    case "navigation": return <nav {...common}>{badge}{children}</nav>;
    case "region": return <section {...common}>{badge}{children}</section>;
    case "group": return <div {...common}>{badge}{children}</div>;
    case "heading": return <div {...common}>{badge}<h2>{body || node.key}</h2></div>;
    case "paragraph": return <p {...common}>{badge}{body || node.key}</p>;
    case "link": return <a {...common} href={node.href ?? "./"}>{badge}{body || node.key}</a>;
    case "button": return <button {...common} type="button">{badge}{body || node.key}</button>;
    case "code": return <pre {...common}>{badge}<code>{body || node.key}</code></pre>;
    case "list": return <ul {...common}>{badge}{children}</ul>;
    case "listitem": return <li {...common}>{badge}{body}{children}</li>;
    default: return <div {...common}>{badge}{body ? <span>{body}</span> : null}{children}</div>;
  }
}

function treeMatches(runtime: UIRRuntime, id: string, query: string, filter: TreeFilter, seen = new Set<string>()): boolean {
  const node = runtime.node(id);
  const search = !query || [node.id, node.key, node.role, node.content, node.pieceName].some((value) => value.toLowerCase().includes(query));
  const filtered = filter === "all" || (filter === "gaps" && Boolean(node.gap)) || (filter === "unresolved" && !node.piece) || (filter === "inferred" && node.modes.includes("inferred"));
  const branch = new Set(seen).add(id);
  return (search && filtered)
    || node.children.some((child) => !branch.has(child) && treeMatches(runtime, child, query, filter, branch));
}

function TreeNode({ runtime, id, selectedId, expanded, query, filter, onToggle, onSelect, seen = new Set<string>() }: { runtime: UIRRuntime; id: string; selectedId?: string; expanded: Set<string>; query: string; filter: TreeFilter; onToggle: (id: string) => void; onSelect: (id: string) => void; seen?: Set<string> }) {
  const node = runtime.node(id);
  const normalizedQuery = query.trim().toLowerCase();
  const ownMatchesSearch = !normalizedQuery || [node.id, node.key, node.role, node.content, node.pieceName].some((value) => value.toLowerCase().includes(normalizedQuery));
  const ownMatchesFilter = filter === "all" || (filter === "gaps" && Boolean(node.gap)) || (filter === "unresolved" && !node.piece) || (filter === "inferred" && node.modes.includes("inferred"));
  const branch = new Set(seen).add(id);
  const children = node.children.filter((child) => !branch.has(child));
  const childMatches = children.some((child) => treeMatches(runtime, child, normalizedQuery, filter, branch));
  if (!(ownMatchesSearch && ownMatchesFilter) && !childMatches) return null;
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(id) || Boolean(normalizedQuery) || filter !== "all";
  return <li className="tree-item">
    <div className={`tree-row ${selectedId === id ? "selected" : ""}`}>
      <button className="tree-toggle" type="button" disabled={!hasChildren} onClick={() => hasChildren && onToggle(id)}>{hasChildren ? (isOpen ? "−" : "+") : "·"}</button>
      <button className="tree-select" type="button" onClick={() => onSelect(id)}>
        <span className="tree-role">{node.role}</span><strong>{concise(node.content || node.key)}</strong><span className="tree-flags">{node.gap ? "△" : ""}{!node.piece ? " ◇" : ""}</span>
      </button>
    </div>
    {hasChildren && isOpen ? <ul className="tree-children">{children.map((child) => <TreeNode key={child} runtime={runtime} id={child} selectedId={selectedId} expanded={expanded} query={query} filter={filter} onToggle={onToggle} onSelect={onSelect} seen={branch} />)}</ul> : null}
  </li>;
}

function DefinitionRows({ rows }: { rows: [string, string | number | undefined][] }) {
  return <dl className="definition-list">{rows.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>;
}

function Inspector({ runtime, node, tab, onTab }: { runtime: UIRRuntime; node?: UIRNode; tab: InspectorTab; onTab: (tab: InspectorTab) => void }) {
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "semantic", label: "Semantic" }, { id: "resolution", label: "Resolution" }, { id: "presentation", label: "Presentation" }, { id: "provenance", label: "Provenance" }, { id: "raw", label: "Raw" },
  ];
  if (!node) return <aside className="inspector"><div className="empty-panel">Select a node to inspect it.</div></aside>;
  return <aside className="inspector">
    <header className="panel-header"><div><span>INSPECTOR</span><strong>{concise(node.content || node.key, 30)}</strong></div><code>{node.role}</code></header>
    <div className="inspector-tabs">{tabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => onTab(item.id)}>{item.label}</button>)}</div>
    <div className="inspector-body">
      {tab === "semantic" ? <><p className="section-label">Interface meaning</p><code className="id-block">{node.id}</code><DefinitionRows rows={[["Role", node.role], ["Salience", node.salience], ["Parent", node.parent?.split(":").at(-1)], ["Children", node.children.length], ["Controls", node.controls?.split(":").at(-1)]]} />{node.content ? <blockquote>{node.content}</blockquote> : null}{node.gap ? <div className="gap-card"><strong>Explicit gap</strong><p>{node.gap}</p></div> : null}<p className="section-label">Facts</p><div className="chip-grid">{node.facts.map((fact, i) => <span key={`${fact.kind}-${i}`}>{fact.kind}<small>{fact.plane}</small></span>)}</div></> : null}
      {tab === "resolution" ? <><p className="section-label">Role → design system</p><div className="resolution-flow"><div><small>Role</small><strong>{node.role}</strong></div><span>→</span><div><small>Piece</small><strong>{node.pieceName}</strong></div></div><DefinitionRows rows={[["Identity", node.piece], ["Status", node.piece ? "resolved" : "unresolved"]]} />{!node.piece ? <div className="note">No role → piece resolution is present. The semantic node remains inspectable.</div> : null}</> : null}
      {tab === "presentation" ? <><p className="section-label">Presentation bindings</p>{node.bindings.length ? <ul className="binding-list">{node.bindings.map((binding) => <li key={binding.slot}><span>{binding.slot}</span><strong>{binding.role}</strong><code>{binding.value}</code></li>)}</ul> : <div className="note">No presentation bindings on this node or resolved piece.</div>}</> : null}
      {tab === "provenance" ? <><p className="section-label">Provenance modes</p><div className="chip-row">{node.modes.length ? node.modes.map((item) => <span key={item}>{item}</span>) : <em>none declared</em>}</div><p className="section-label">Sources</p>{node.sources.length ? <ul className="source-list">{node.sources.map((source) => <li key={source}>{source}</li>)}</ul> : <div className="note">No source labels resolved.</div>}</> : null}
      {tab === "raw" ? <><p className="section-label">Underlying records</p><pre className="raw"><code>{JSON.stringify(runtime.rawForNode(node.id), null, 2)}</code></pre></> : null}
    </div>
  </aside>;
}

function Diagnostics({ diagnostics, open, onToggle }: { diagnostics: PackageDiagnostic[]; open: boolean; onToggle: () => void }) {
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  const successes = diagnostics.filter((item) => item.severity === "success").length;
  return <div className={`diagnostics ${open ? "open" : ""}`}>
    {open ? <div className="diagnostics-drawer"><header><strong>Package diagnostics</strong><button type="button" onClick={onToggle}>Close</button></header><ul>{diagnostics.map((item, i) => <li key={`${item.code}-${i}`} data-severity={item.severity}><span>{item.severity === "success" ? "✓" : item.severity === "warning" ? "△" : "×"}</span><div><strong>{item.message}</strong>{item.path ? <code>{item.path}</code> : null}</div></li>)}</ul></div> : null}
    <button className="diagnostics-bar" type="button" onClick={onToggle}><span className={errors ? "error" : "ok"}>{errors ? `× ${errors} errors` : "✓ package readable"}</span><span>{warnings ? `△ ${warnings} warnings` : "0 warnings"}</span><span>{successes} checks</span><span>Diagnostics {open ? "↓" : "↑"}</span></button>
  </div>;
}

export function Playground({ pkg }: { pkg: UIRPackageData }) {
  const runtime = useMemo(() => new UIRRuntime(pkg), [pkg]);
  const [selectedId, setSelectedId] = useState<string | undefined>(runtime.rootIds[0] ?? runtime.nodeIds[0]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(runtime.rootIds));
  const [mode, setMode] = useState<CanvasMode>("semantics");
  const [filter, setFilter] = useState<TreeFilter>("all");
  const [query, setQuery] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("semantic");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const stats = runtime.stats();
  const metadata = runtime.packageMetadata();
  const selected = selectedId && runtime.nodeIds.includes(selectedId) ? runtime.node(selectedId) : undefined;
  const diagnostics: PackageDiagnostic[] = [
    ...pkg.diagnostics,
    { severity: runtime.rootIds.length ? "success" : "error", code: "semantic.root", message: runtime.rootIds.length ? `${runtime.rootIds.length} render root${runtime.rootIds.length === 1 ? "" : "s"} discovered` : "No render root discovered" },
    ...(stats.gaps ? [{ severity: "warning" as const, code: "semantic.gaps", message: `${stats.gaps} explicit gap${stats.gaps === 1 ? "" : "s"} declared` }] : []),
    ...(stats.unresolved ? [{ severity: "warning" as const, code: "resolution.unresolved", message: `${stats.unresolved} node${stats.unresolved === 1 ? "" : "s"} without role → piece resolution` }] : []),
    // Reported, not merely survived. The walkers stop at a repeat inside one
    // ancestor chain, so a cyclic package renders a truncated tree instead of
    // killing the tab — and a truncated tree that says nothing would be a
    // package looking sound because something was not shown.
    ...(runtime.cyclicNodeIds.length ? [{ severity: "error" as const, code: "cycle.detected", message: `${runtime.cyclicNodeIds.length} node${runtime.cyclicNodeIds.length === 1 ? " lies" : "s lie"} on a contains cycle; the tree is cut where it repeats`, path: runtime.cyclicNodeIds.slice(0, 3).join(", ") }] : []),
  ];

  const toggleExpanded = (id: string) => setExpanded((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const selectNode = (id: string) => {
    setSelectedId(id);
    // The same guard upward. `parentByNode` is built from the same unvalidated
    // relations, so a cycle made this `while` spin forever — a hang rather than
    // a stack overflow, which is the worse of the two because nothing reports it.
    setExpanded((current) => { const next = new Set(current); let parent = runtime.parentByNode.get(id); while (parent && !next.has(parent)) { next.add(parent); parent = runtime.parentByNode.get(parent); } return next; });
  };
  const viewportLabel = viewport === "desktop" ? "responsive desktop" : viewport === "tablet" ? "768 px" : "390 px";

  return <div className="playground-shell">
    <header className="viewer-topbar"><div><span>PACKAGE</span><strong>{metadata.name}</strong></div><code>{pkg.manifest.packageVersion} · {stats.nodes} nodes · {stats.records.toLocaleString("en-US")} records</code></header>
    <div className="workspace">
      <aside className="structure">
        <header className="panel-header"><div><span>STRUCTURE</span><strong>Semantic tree</strong></div><code>{stats.nodes}</code></header>
        <div className="tree-tools"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes, roles, ids…" /><div className="filter-row">{(["all", "gaps", "unresolved", "inferred"] as TreeFilter[]).map((item) => <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div></div>
        <div className="tree-scroll">{runtime.rootIds.length ? <ul className="tree-root">{runtime.rootIds.map((root) => <TreeNode key={root} runtime={runtime} id={root} selectedId={selectedId} expanded={expanded} query={query} filter={filter} onToggle={toggleExpanded} onSelect={selectNode} />)}</ul> : <div className="empty-panel">No semantic root found.</div>}</div>
      </aside>
      <main className="stage">
        <div className="stage-toolbar"><div className="mode-switcher">{(Object.keys(modeLabels) as CanvasMode[]).map((item) => <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{modeLabels[item]}</button>)}</div><div className="viewport-switcher">{(["desktop", "tablet", "phone"] as Viewport[]).map((item) => <button key={item} type="button" className={viewport === item ? "active" : ""} onClick={() => setViewport(item)}>{item}</button>)}</div></div>
        <div className="canvas-scroll"><div className={`canvas ${viewport}`} data-mode={mode}><div className="canvas-meta"><span>{pkg.manifest.packageId}</span><span>{viewportLabel}</span></div>{runtime.rootIds.map((root) => <CanvasNode key={root} runtime={runtime} id={root} selectedId={selectedId} mode={mode} onSelect={selectNode} />)}{!runtime.rootIds.length ? <div className="canvas-empty"><strong>No renderable tree</strong><span>Open Diagnostics for package errors.</span></div> : null}</div></div>
      </main>
      <Inspector runtime={runtime} node={selected} tab={inspectorTab} onTab={setInspectorTab} />
    </div>
    <Diagnostics diagnostics={diagnostics} open={diagnosticsOpen} onToggle={() => setDiagnosticsOpen((value) => !value)} />
  </div>;
}
