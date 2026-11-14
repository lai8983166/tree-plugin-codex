export function layoutTree(items, collapsed = new Set()) {
  const root = { id: 'root', title: '本次讨论', children: [] };
  const map = new Map([['root', root], ...items.map(n => [n.id ?? n.turnId, { ...n, id: n.id ?? n.turnId, children: [] }])]);
  for (const item of items) {
    const node = map.get(item.id ?? item.turnId);
    let parent = item.kind || item.classification === 'ready' ? map.get(item.parentId) : root;
    // Defensive render guard for corrupt persisted data.
    const seen = new Set([node.id]); let cursor = parent;
    while (cursor && cursor.id !== 'root') { if (seen.has(cursor.id)) { parent = root; break; } seen.add(cursor.id); cursor = map.get(cursor.parentId); }
    (parent || root).children.push(node);
  }
  const nodes = [], edges = []; let leaf = 0, maxDepth = 0;
  function visit(node, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const children = collapsed.has(node.id) ? [] : node.children;
    const rendered = children.map(child => visit(child, depth + 1));
    node.x = 24 + depth * 290;
    node.y = rendered.length ? (rendered[0].y + rendered.at(-1).y) / 2 : 24 + leaf++ * 108;
    node.childCount = node.children.length; nodes.push(node);
    for (const child of rendered) edges.push({ from: node, to: child, provisional: child.kind ? child.kind === 'qa' && !child.turnId : child.classification !== 'ready' });
    return node;
  }
  visit(root, 0);
  return { nodes, edges, width: 48 + maxDepth * 290 + 220, height: Math.max(180, leaf * 108 + 24) };
}
