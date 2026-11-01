import { Fragment, type ReactNode } from "react";

// fork: lets a translated sentence keep a link or <code> where its language puts it.
/** Splits a translated template at each `{name}` and drops in the matching node. */
export function interpolateNodes(
  template: string,
  nodes: Readonly<Record<string, ReactNode>>,
): ReactNode {
  const seen = new Map<string, number>();
  return template.split(/\{([A-Za-z0-9_]+)\}/g).map((part, index) => {
    if (index % 2 === 0) return part;
    if (!Object.hasOwn(nodes, part)) return `{${part}}`;
    const count = (seen.get(part) ?? 0) + 1;
    seen.set(part, count);
    return <Fragment key={`${part}:${count}`}>{nodes[part]}</Fragment>;
  });
}
