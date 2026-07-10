import React, { useEffect, useMemo, useRef } from 'react';
import ForceGraph from 'force-graph';

function flatten(nodes, out: any[] = []) {
  for (const n of nodes) {
    if (n.children) flatten(n.children, out);
    else out.push(n);
  }
  return out;
}

// Reads the current theme's graph colors from CSS variables on :root.
// Called whenever the theme (or first mount) changes so the force-graph
// re-paints with the right palette.
function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    node: cs.getPropertyValue('--graph-node').trim() || '#5e5ce6',
    link: cs.getPropertyValue('--graph-link').trim() || 'rgba(0,0,0,0.2)',
  };
}

export default function GraphView({ tree, resolvedLinks, linkIndexVersion, onOpenFile, dark }) {
  const hostRef = useRef<any>(null);
  const fgRef = useRef<any>(null);
  const colorsRef = useRef(readThemeColors());
  // Cache node objects by id across rebuilds. force-graph mutates x/y/vx/vy
  // onto each node; reusing the same object reference keeps positions and
  // velocities intact when other files change, so the layout doesn't reshuffle.
  const nodeCacheRef = useRef(new Map<string, any>());

  const graphData = useMemo(() => {
    const nodeCache = nodeCacheRef.current;
    const nodes: any[] = [];
    const seen = new Set<string>();
    for (const f of flatten(tree)) {
      if (!f.name.toLowerCase().endsWith('.md')) continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const displayName = f.name.replace(/\.md$/i, '');
      let node = nodeCache.get(f.id);
      if (node) {
        if (node.name !== displayName) node.name = displayName;
      } else {
        node = { id: f.id, name: displayName };
        nodeCache.set(f.id, node);
      }
      nodes.push(node);
    }
    for (const id of [...nodeCache.keys()]) {
      if (!seen.has(id)) nodeCache.delete(id);
    }
    // Edges come straight from the cache's resolvedLinks (source → dest paths) —
    // already resolved, no per-edge resolution needed.
    const links: any[] = [];
    for (const [source, dests] of resolvedLinks.entries()) {
      if (!seen.has(source)) continue;
      for (const dest of dests.keys()) {
        if (!seen.has(dest) || dest === source) continue;
        links.push({ source, target: dest });
      }
    }
    return { nodes, links };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkIndexVersion, tree, resolvedLinks]);

  useEffect(() => {
    if (!hostRef.current) return;
    const fg = (ForceGraph as any)()(hostRef.current)
      .graphData(graphData)
      .nodeLabel('name')
      .nodeRelSize(5)
      .linkColor(() => colorsRef.current.link)
      .nodeColor(() => colorsRef.current.node)
      .onNodeClick((node) => onOpenFile(node.id));
    fgRef.current = fg;

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      fg.width(width).height(height);
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      if (typeof fg._destructor === 'function') fg._destructor();
      fgRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (fgRef.current) fgRef.current.graphData(graphData);
  }, [graphData]);

  // Re-read CSS vars on theme change and force a re-render of nodes/links.
  useEffect(() => {
    colorsRef.current = readThemeColors();
    const fg = fgRef.current;
    if (fg) {
      fg.linkColor(() => colorsRef.current.link);
      fg.nodeColor(() => colorsRef.current.node);
    }
  }, [dark]);

  return <div ref={hostRef} className="graph-host" />;
}
