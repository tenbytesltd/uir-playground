export type UIRRecord = {
  id: string;
  kind?: string;
  recordType: string;
  subject?: string;
  source?: string;
  target?: string;
  order?: number;
  outcome?: string;
  rationale?: string;
  plane?: string;
  provenance?: string;
  mode?: string;
  sources?: string[];
  locator?: string;
  value?: Record<string, unknown>;
};

export type UIRManifestEntry = {
  collection: string;
  path: string;
  sha256?: string;
};

export type UIRManifest = {
  formatVersion: string;
  packageId: string;
  packageVersion: string;
  readingProfile?: string;
  vocabularyVersion?: string;
  model: UIRManifestEntry[];
  assets?: unknown[];
};

export type UIRShard = {
  records?: UIRRecord[];
  [key: string]: unknown;
};

export type PackageDiagnostic = {
  severity: "success" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
};

export type UIRPackageData = {
  manifest: UIRManifest;
  shards: Record<string, UIRShard>;
  sourceName: string;
  diagnostics: PackageDiagnostic[];
};

export type InspectionBinding = {
  slot: string;
  role: string;
  value: string;
};

export type UIRNode = {
  id: string;
  key: string;
  role: string;
  salience: string;
  content: string;
  parent?: string;
  // **Every array on this type is `readonly`, and the reason is one property of
  // the object rather than one of its fields: `node()` is MEMOISED.** Whatever a
  // caller gets is the array every other caller gets, for the runtime's
  // lifetime — so a sort done once, for display, in one component, reorders the
  // data every other reader sees.
  //
  // The declared type is what invites the write. `.sort()` on a `string[]` is
  // ordinary code that compiles; on a `readonly string[]` it is a build error,
  // at the line that attempts it, before anything runs. The freeze underneath is
  // the second line of defence, not the first.
  //
  // `children` was made readonly one round before the other four, which is why
  // this note is here and not spread across them: the argument was never about
  // children.
  children: readonly string[];
  controls?: string;
  href?: string;
  gap?: string;
  piece?: string;
  pieceName: string;
  facts: readonly { kind: string; plane: string }[];
  bindings: readonly InspectionBinding[];
  sources: readonly string[];
  modes: readonly string[];
};

type ScalarStyle = Record<string, string | number | undefined>;

function nodeKey(subject: string) {
  return subject.split(":").at(-1) ?? subject;
}

const EMPTY: readonly UIRRecord[] = Object.freeze([]);
const NO_CHILDREN: readonly string[] = Object.freeze([]);

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

export class UIRRuntime {
  readonly manifest: UIRManifest;
  readonly records: UIRRecord[];
  readonly byId: Map<string, UIRRecord>;
  readonly facts: UIRRecord[];
  readonly relations: UIRRecord[];
  readonly contains: UIRRecord[];
  readonly parentByNode = new Map<string, string>();
  readonly childrenByParent = new Map<string, readonly string[]>();
  readonly controls: Map<string, string>;
  readonly gaps: UIRRecord[];
  readonly rootIds: string[];
  readonly nodeIds: string[];
  readonly sourceNames: Map<string, string>;

  // **Indexes, because every accessor below used to be a full scan and the
  // render path calls them per node.** `node()` reaches `fact` five times,
  // `factsOf` twice and one `boundValue` scan per binding; `CanvasNode` calls
  // `node()` once per node per render, `treeMatches` calls it for every
  // descendant of every ancestor on every keystroke in the search box, and
  // `stats()` calls `allNodes()` unconditionally. On a 4,000-record package
  // that is scans in the millions for one keypress.
  //
  // Built once in the constructor, off `records`, which is already complete by
  // then. Nothing here changes an answer — each map returns what the scan it
  // replaces returned, including the "first match wins" of `find`, and
  // `tests/runtime-behaviour.test.mjs` recomputes them the slow way to say so.
  private readonly factsBySubject = new Map<string, UIRRecord[]>();
  private readonly factBySubjectKind = new Map<string, UIRRecord>();
  private readonly relationsBySubject = new Map<string, UIRRecord[]>();
  private readonly pieceByRole = new Map<string, string>();
  private readonly valueByGroundRole = new Map<string, string>();
  private readonly nodeCache = new Map<string, UIRNode>();

  /** Node ids that lie on a `contains` cycle, empty when the graph is a tree. */
  readonly cyclicNodeIds: string[];

  // An explicit field rather than a constructor parameter property. The latter
  // is the one TypeScript construct Node's strip-only type removal refuses, and
  // it was the single thing standing between this runtime and being executed by
  // a test at all — `tests/` could assert that source text mentions `UIRRuntime`
  // and nothing more. It emits identical JavaScript.
  readonly pkg: UIRPackageData;

  constructor(pkg: UIRPackageData) {
    this.pkg = pkg;
    this.manifest = pkg.manifest;
    this.records = Object.values(pkg.shards).flatMap((shard) =>
      Array.isArray(shard.records) ? shard.records : [],
    );
    this.byId = new Map(this.records.map((record) => [record.id, record]));
    this.facts = this.records.filter((record) => record.recordType === "Fact");
    this.relations = this.records.filter((record) => record.recordType === "Relation");
    this.contains = this.relations
      .filter((record) => record.kind === "contains")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const record of this.facts) {
      if (!record.subject) continue;
      const bySubject = this.factsBySubject.get(record.subject);
      if (bySubject) bySubject.push(record);
      else this.factsBySubject.set(record.subject, [record]);
      // `set` only when absent, so this returns what `find` returned.
      const key = `${record.subject}\u0000${record.kind ?? ""}`;
      if (!this.factBySubjectKind.has(key)) this.factBySubjectKind.set(key, record);
      if (record.kind === "design.binding" && typeof record.value?.groundRole === "string"
          && !this.valueByGroundRole.has(record.value.groundRole)) {
        this.valueByGroundRole.set(record.value.groundRole, record.subject);
      }
    }
    for (const record of this.relations) {
      for (const end of [record.source, record.target]) {
        if (!end) continue;
        const bySubject = this.relationsBySubject.get(end);
        // A relation whose source and target are the same entity is listed
        // once, which is what `filter(source === s || target === s)` did.
        if (bySubject) { if (bySubject.at(-1) !== record) bySubject.push(record); }
        else this.relationsBySubject.set(end, [record]);
      }
    }

    const childrenUnderConstruction = new Map<string, string[]>();
    for (const relation of this.contains) {
      if (!relation.source || !relation.target) continue;
      const children = childrenUnderConstruction.get(relation.source) ?? [];
      children.push(relation.target);
      childrenUnderConstruction.set(relation.source, children);
      this.childrenByParent.set(relation.source, children);
      if (this.isNodeId(relation.source)) this.parentByNode.set(relation.target, relation.source);
    }

    this.controls = new Map(
      this.relations
        .filter((record) => record.kind === "controls" && record.source && record.target)
        .map((record) => [record.source as string, record.target as string]),
    );
    this.gaps = this.records.filter((record) => record.recordType === "Entity" && record.kind === "Gap");

    const explicitNodeIds = this.facts
      .filter((record) => record.subject && (record.kind === "node.role" || record.kind === "node.content"))
      .map((record) => record.subject as string);
    const relationNodeIds = this.contains.flatMap((relation) =>
      [relation.source, relation.target].filter(
        (value): value is string => Boolean(value && this.isNodeId(value)),
      ),
    );
    this.nodeIds = unique([...explicitNodeIds, ...relationNodeIds]);

    const surfaceIds = this.records
      .filter((record) => record.recordType === "Entity" && record.kind === "Surface")
      .map((record) => record.id);
    const surfaceRoots = surfaceIds.flatMap((surfaceId) =>
      (this.childrenByParent.get(surfaceId) ?? []).filter((id) => this.nodeIds.includes(id)),
    );
    const inferredRoots = this.nodeIds.filter((id) => !this.parentByNode.has(id));
    this.rootIds = unique(surfaceRoots.length ? surfaceRoots : inferredRoots);

    this.sourceNames = new Map(
      this.records
        .filter((record) => record.recordType === "Entity" && record.kind === "Source")
        .map((source) => {
          const description = this.fact(source.id, "source.description")?.value;
          const name = typeof description?.name === "string" ? description.name : nodeKey(source.id);
          return [source.id, name];
        }),
    );

    for (const selector of this.facts) {
      if (selector.kind !== "resolution.selector" || !selector.subject) continue;
      if (selector.value?.dimension !== "role" || typeof selector.value?.role !== "string") continue;
      const resolution = this.byId.get(selector.subject);
      if (resolution?.recordType !== "Entity" || typeof resolution.outcome !== "string") continue;
      // First selector wins, as the original loop's early `return` did.
      if (!this.pieceByRole.has(selector.value.role)) {
        this.pieceByRole.set(selector.value.role, resolution.outcome);
      }
    }

    // **Frozen, because these arrays are now HANDED OUT.** `factsOf(subject)`
    // with no kind returns the index array itself and `relationsOf` likewise;
    // the `.filter()` calls they replaced allocated a fresh array every time, so
    // a caller could do what it liked with the result. Nothing mutates one today
    // — every call site spreads, maps or stringifies — but the invitation is
    // there: `node()` sorts `nodeFacts.map(...)`, and the copy in that
    // expression is the `.map`, not anything deliberate. Drop it in a later edit
    // and the index is reordered in place for every other reader, including
    // `fact()`, whose first-match-wins is exactly what one of the tests pins.
    // That test would go red for a reason nobody would look for in a display
    // tweak, and only when the reordering happened to move the first record.
    //
    // Frozen rather than copied on every call: the borrow is the point, and a
    // mutation now throws at the line that attempts it instead of surfacing
    // somewhere else later.
    //
    // `childrenByParent` is here for the same reason and is the worse of the
    // three, not the leftover. `node().children` hands out the live array, and
    // `node()` is MEMOISED — so one mutation is not scoped to one render, it is
    // the array every caller gets for the runtime's lifetime. A reorder is also
    // silent rather than loud: `semantic-diff.ts` builds its signature from
    // `children.map(...).join("|")`, so two identical packages would produce
    // different signatures and every parent would report `changed`. The diff
    // would invent changes and the counters would agree with it.
    for (const list of this.factsBySubject.values()) Object.freeze(list);
    for (const list of this.relationsBySubject.values()) Object.freeze(list);
    for (const list of this.childrenByParent.values()) Object.freeze(list);

    this.cyclicNodeIds = this.findCycles();
  }

  /** Every node that lies on a `contains` cycle.
   *
   * `contains` comes from the package and nothing validated it. Three walkers
   * recursed into it unguarded, so one extra relation — or `A contains A` in a
   * single record — took the whole tab down with `RangeError: Maximum call
   * stack size exceeded`, before any interaction, because `?source=` is fetched
   * and rendered on load. The walkers now carry a visited set; this tells the
   * reader WHY the tree stops where it does, so a broken package is reported
   * rather than silently truncated.
   *
   * Iterative, not recursive: a detector that blows the stack on the input it
   * exists to detect is not a detector.
   */
  private findCycles(): string[] {
    const onCycle = new Set<string>();
    const state = new Map<string, 1 | 2>();  // 1 = on the current path, 2 = done
    for (const start of this.childrenByParent.keys()) {
      if (state.get(start)) continue;
      const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
      state.set(start, 1);
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const children = this.childrenByParent.get(frame.id) ?? [];
        if (frame.next >= children.length) {
          state.set(frame.id, 2);
          stack.pop();
          continue;
        }
        const child = children[frame.next];
        frame.next += 1;
        if (state.get(child) === 1) {
          onCycle.add(child);
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            onCycle.add(stack[i].id);
            if (stack[i].id === child) break;
          }
          continue;
        }
        if (state.get(child) === 2) continue;
        state.set(child, 1);
        stack.push({ id: child, next: 0 });
      }
    }
    return [...onCycle].sort();
  }

  private isNodeId(value: string) {
    return value.includes(":node:") || this.facts?.some(
      (record) => record.subject === value && record.kind === "node.role",
    ) === true;
  }

  fact(subject: string, kind: string) {
    return this.factBySubjectKind.get(`${subject}\u0000${kind}`);
  }

  /** The subject's facts. The un-kinded result is the index itself and is
   *  frozen; pass a kind, or copy, if you need to sort or splice. */
  factsOf(subject: string, kind?: string): readonly UIRRecord[] {
    const all = this.factsBySubject.get(subject) ?? EMPTY;
    return kind ? all.filter((record) => record.kind === kind) : all;
  }

  /** The relations touching this subject. Frozen, for the reason above. */
  relationsOf(subject: string): readonly UIRRecord[] {
    return this.relationsBySubject.get(subject) ?? EMPTY;
  }

  textValue(subject: string) {
    const value = this.fact(subject, "node.content")?.value;
    return value?.type === "text" && typeof value.value === "string" ? value.value : "";
  }

  role(subject: string) {
    const value = this.fact(subject, "node.role")?.value;
    return typeof value?.role === "string" ? value.role : "group";
  }

  salience(subject: string) {
    const value = this.fact(subject, "node.salience")?.value;
    return typeof value?.level === "string" ? value.level : "supporting";
  }

  sourceHref(subject: string) {
    const locators = [this.byId.get(subject), ...this.factsOf(subject)]
      .flatMap((record) => {
        const provenance = record?.provenance ? this.byId.get(record.provenance) : undefined;
        return provenance?.sources ?? [];
      })
      .map((source) => this.byId.get(source)?.locator)
      .filter((locator): locator is string => typeof locator === "string" && locator.startsWith("https://"));
    const candidates = unique(locators);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  resolutionPiece(role: string) {
    return this.pieceByRole.get(role);
  }

  bindingMap(subject: string | undefined) {
    const result = new Map<string, string>();
    if (!subject) return result;
    for (const binding of this.factsOf(subject, "presentation.binding")) {
      const value = binding.value;
      if (typeof value?.slot === "string" && value.outcome === "role" && typeof value.groundRole === "string") {
        result.set(value.slot, value.groundRole);
      }
    }
    return result;
  }

  boundValue(groundRole: string | undefined) {
    if (!groundRole) return undefined;
    return this.valueByGroundRole.get(groundRole);
  }

  literal(valueId: string | undefined): Record<string, unknown> | undefined {
    if (!valueId) return undefined;
    const variant = this.fact(valueId, "design-value.variant")?.value;
    return variant?.form === "literal" && variant.literal && typeof variant.literal === "object"
      ? (variant.literal as Record<string, unknown>)
      : undefined;
  }

  cssScalar(valueId: string | undefined): string | undefined {
    const value = this.literal(valueId);
    if (!value || typeof value.type !== "string") return undefined;
    if (value.type === "color" && Array.isArray(value.channels)) {
      const [r, g, b] = value.channels.map((channel) => Math.round(Number(channel) * 255));
      return `rgb(${r} ${g} ${b} / ${String(value.alpha ?? 1)})`;
    }
    if (value.type === "dimension") return `${String(value.value)}${String(value.unit)}`;
    if (value.type === "number" || value.type === "font-weight") return String(value.value);
    if (value.type === "duration") return `${String(value.value)}${String(value.unit)}`;
    if (value.type === "font-family" && Array.isArray(value.families)) {
      return value.families.map((entry) => (entry as { family?: string }).family).filter(Boolean).join(", ");
    }
    return undefined;
  }

  normalizedPercent(valueId: string | undefined) {
    const value = this.literal(valueId);
    if (value?.type !== "number" || typeof value.value !== "number") return undefined;
    return `${value.value * 100}%`;
  }

  cssGradient(valueId: string | undefined) {
    const value = this.literal(valueId);
    if (value?.type !== "gradient" || value.kind !== "radial") return undefined;
    const centerInline = this.normalizedPercent(typeof value.centerInline === "string" ? value.centerInline : undefined);
    const centerBlock = this.normalizedPercent(typeof value.centerBlock === "string" ? value.centerBlock : undefined);
    if (!centerInline || !centerBlock || !Array.isArray(value.stops)) return undefined;
    const stops = value.stops.map((entry) => {
      const stop = entry as { color?: string; position?: string };
      const color = this.cssScalar(stop.color);
      const position = this.normalizedPercent(stop.position);
      return color && position ? `${color} ${position}` : undefined;
    });
    if (stops.some((stop) => !stop)) return undefined;
    return `radial-gradient(circle at ${centerInline} ${centerBlock}, ${stops.join(", ")})`;
  }

  valueLabel(valueId: string | undefined) {
    if (!valueId) return "none";
    const definition = this.fact(valueId, "design-value.definition")?.value;
    const name = typeof definition?.name === "string" ? definition.name : nodeKey(valueId);
    const scalar = this.cssScalar(valueId);
    return scalar ? `${name} · ${scalar}` : name;
  }

  resolvedBindings(subject: string) {
    const bindings = this.bindingMap(this.resolutionPiece(this.role(subject)));
    for (const [slot, groundRole] of this.bindingMap(subject)) bindings.set(slot, groundRole);
    return bindings;
  }

  styleForNode(subject: string): ScalarStyle {
    const bindings = this.resolvedBindings(subject);
    const token = (slot: string) => this.cssScalar(this.boundValue(bindings.get(slot)));
    const typeValue = this.literal(this.boundValue(bindings.get("type")));
    const surfaceValueId = this.boundValue(bindings.get("surface"));
    const surface = this.literal(surfaceValueId);
    const style: ScalarStyle = {
      backgroundColor: surface?.type === "color" ? this.cssScalar(surfaceValueId) : undefined,
      backgroundImage: this.cssGradient(surfaceValueId),
      color: token("ink"),
      paddingInline: token("inset-inline"),
      paddingBlock: token("inset-block"),
      gap: token("inter-item-block") ?? token("inter-item-inline"),
      borderRadius: token("corner"),
      opacity: token("opacity"),
    };
    if (typeValue?.type === "typography") {
      style.fontFamily = this.cssScalar(typeof typeValue.family === "string" ? typeValue.family : undefined);
      style.fontSize = this.cssScalar(typeof typeValue.size === "string" ? typeValue.size : undefined);
      style.fontWeight = this.cssScalar(typeof typeValue.weight === "string" ? typeValue.weight : undefined);
      style.lineHeight = this.cssScalar(typeof typeValue.lineHeight === "string" ? typeValue.lineHeight : undefined);
      style.letterSpacing = this.cssScalar(typeof typeValue.tracking === "string" ? typeValue.tracking : undefined);
    }
    return style;
  }

  provenanceFor(records: UIRRecord[]) {
    const provenance = records
      .map((record) => (record.provenance ? this.byId.get(record.provenance) : undefined))
      .filter((record): record is UIRRecord => Boolean(record));
    return {
      modes: unique(provenance.map((record) => record.mode).filter(Boolean) as string[]).sort(),
      sources: unique(
        provenance.flatMap((record) => record.sources ?? []).map((source) => this.sourceNames.get(source) ?? nodeKey(source)),
      ).sort(),
    };
  }

  inspectionBindings(subject: string, piece: string | undefined): InspectionBinding[] {
    const bindings = this.bindingMap(piece);
    for (const [slot, groundRole] of this.bindingMap(subject)) bindings.set(slot, groundRole);
    return [...bindings.entries()]
      .map(([slot, groundRole]) => {
        const definition = this.fact(groundRole, "design-value.definition")?.value;
        return {
          slot,
          role: typeof definition?.name === "string" ? definition.name : nodeKey(groundRole),
          value: this.valueLabel(this.boundValue(groundRole)),
        };
      })
      .sort((a, b) => a.slot.localeCompare(b.slot));
  }

  node(subject: string): UIRNode {
    const cached = this.nodeCache.get(subject);
    if (cached) return cached;
    const role = this.role(subject);
    const piece = this.resolutionPiece(role);
    const pieceIdentity = piece ? this.fact(piece, "piece.identity")?.value : undefined;
    const entity = this.byId.get(subject);
    const nodeFacts = this.factsOf(subject);
    const provenance = this.provenanceFor([entity, ...nodeFacts].filter(Boolean) as UIRRecord[]);
    const controlled = this.controls.get(subject);
    const gap = this.gaps.find((record) => record.target === subject);
    const built: UIRNode = {
      id: subject,
      key: nodeKey(subject),
      role,
      salience: this.salience(subject),
      content: this.textValue(subject),
      parent: this.parentByNode.get(subject),
      children: this.childrenByParent.get(subject) ?? NO_CHILDREN,
      controls: controlled,
      href: controlled ? `#${nodeKey(controlled)}` : this.sourceHref(subject),
      gap: gap?.rationale,
      piece,
      pieceName: typeof pieceIdentity?.name === "string" ? pieceIdentity.name : piece ? nodeKey(piece) : "unresolved",
      // Frozen at the point of construction, all five, because the freeze and
      // the `readonly` answer different questions: the type stops the write
      // being written, the freeze stops one that reaches JavaScript anyway —
      // from a `.js` consumer, or through an `as` that discards the type.
      facts: Object.freeze(nodeFacts.map((record) => ({ kind: record.kind ?? "Fact", plane: record.plane ?? "unclassified" })).sort((a, b) => a.kind.localeCompare(b.kind))),
      bindings: Object.freeze(this.inspectionBindings(subject, piece)),
      sources: Object.freeze(provenance.sources),
      modes: Object.freeze(provenance.modes),
    };
    this.nodeCache.set(subject, built);
    return built;
  }

  /** Every ancestor of `subject`, nearest first, stopping at a repeat.
   *
   * Lives here rather than inline in the component for one reason: inline, it
   * was reachable by no test. There is no DOM environment, so a walk written
   * inside `selectNode` can only be read, and this one was wrong in a way
   * reading did not catch — it terminated on the user's EXPANDED set, which
   * conflates *already open* with *already walked on this ascent*, so an ascent
   * that met an open ancestor stopped there and left the rest of the chain
   * collapsed. The termination condition belongs to the walk, not to the UI
   * state it happens to be filling in.
   *
   * `parentByNode` comes from unvalidated `contains` relations, so a cycle would
   * otherwise spin this forever — a hang, which is worse than a crash because
   * nothing reports it.
   */
  ancestorsOf(subject: string): string[] {
    const chain: string[] = [];
    const walked = new Set<string>([subject]);
    let parent = this.parentByNode.get(subject);
    while (parent && !walked.has(parent)) {
      walked.add(parent);
      chain.push(parent);
      parent = this.parentByNode.get(parent);
    }
    return chain;
  }

  allNodes() {
    return this.nodeIds.map((id) => this.node(id));
  }

  rawForNode(subject: string) {
    return {
      entity: this.byId.get(subject) ?? null,
      facts: this.factsOf(subject),
      relations: this.relationsOf(subject),
    };
  }

  packageMetadata() {
    const metadata = this.fact(this.manifest.packageId, "package.metadata")?.value;
    return {
      name: typeof metadata?.name === "string" ? metadata.name : this.pkg.sourceName,
      summary: typeof metadata?.summary === "string" ? metadata.summary : undefined,
    };
  }

  stats() {
    const nodes = this.allNodes();
    return {
      records: this.records.length,
      nodes: nodes.length,
      gaps: nodes.filter((node) => node.gap).length,
      unresolved: nodes.filter((node) => !node.piece).length,
    };
  }
}
