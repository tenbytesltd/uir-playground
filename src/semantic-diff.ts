import { UIRRuntime, type UIRNode, type UIRPackageData } from "./runtime.ts";

export type SemanticDiffItem = {
  key: string;
  status: "added" | "removed" | "changed" | "same";
  before?: UIRNode;
  after?: UIRNode;
  fields: string[];
};

function stableNodeKey(node: UIRNode) {
  const marker = ":node:";
  const index = node.id.indexOf(marker);
  return index >= 0 ? node.id.slice(index + marker.length) : node.id;
}

function bindingSignature(node: UIRNode) {
  return node.bindings.map((binding) => `${binding.slot}:${binding.role}:${binding.value}`).sort().join("|");
}

function childSignature(node: UIRNode) {
  return node.children.map((id) => id.includes(":node:") ? id.split(":node:")[1] : id).join("|");
}

function changedFields(before: UIRNode, after: UIRNode) {
  const fields: string[] = [];
  if (before.role !== after.role) fields.push("role");
  if (before.content !== after.content) fields.push("content");
  if (before.salience !== after.salience) fields.push("salience");
  if (before.pieceName !== after.pieceName) fields.push("resolution");
  if ((before.gap ?? "") !== (after.gap ?? "")) fields.push("gap");
  if (bindingSignature(before) !== bindingSignature(after)) fields.push("bindings");
  if (childSignature(before) !== childSignature(after)) fields.push("children");
  return fields;
}

export function diffPackages(beforePackage: UIRPackageData, afterPackage: UIRPackageData) {
  const beforeRuntime = new UIRRuntime(beforePackage);
  const afterRuntime = new UIRRuntime(afterPackage);
  const before = new Map(beforeRuntime.allNodes().map((node) => [stableNodeKey(node), node]));
  const after = new Map(afterRuntime.allNodes().map((node) => [stableNodeKey(node), node]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const items: SemanticDiffItem[] = keys.map((key) => {
    const previous = before.get(key);
    const next = after.get(key);
    if (!previous) return { key, status: "added", after: next, fields: ["node"] };
    if (!next) return { key, status: "removed", before: previous, fields: ["node"] };
    const fields = changedFields(previous, next);
    return { key, status: fields.length ? "changed" : "same", before: previous, after: next, fields };
  });
  return {
    added: items.filter((item) => item.status === "added").length,
    removed: items.filter((item) => item.status === "removed").length,
    changed: items.filter((item) => item.status === "changed").length,
    same: items.filter((item) => item.status === "same").length,
    items,
  };
}
