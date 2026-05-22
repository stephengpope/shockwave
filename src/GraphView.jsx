import React, { useEffect, useMemo, useRef } from 'react';
import ForceGraph from 'force-graph';

function flatten(nodes, out = []) {
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

export default function GraphView({ tree, pageIndex, outgoingByFile, linkIndexVersion, onOpenFile, dark }) {
  const hostRef = useRef(null);
  const fgRef = useRef(null);
  const colorsRef = useRef(readThemeColors());

  const graphData = useMemo(() => {
    const nodes = [];
    const seen = new Set();
    for (const f of flatten(tree)) {
      if (!f.name.toLowerCase().endsWith('.md')) continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      nodes.push({ id: f.id, name: f.name.replace(/\.md$/i, '') });
    }
    const links = [];
    for (const [source, targets] of outgoingByFile.entries()) {
      if (!seen.has(source)) continue;
      for (const t of targets) {
        const targetPath = pageIndex.get(t);
        if (!targetPath || !seen.has(targetPath)) continue;
        if (targetPath === source) continue;
        links.push({ source, target: targetPath });
      }
    }
    return { nodes, links };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkIndexVersion, tree, pageIndex]);

  useEffect(() => {
    if (!hostRef.current) return;
    const fg = ForceGraph()(hostRef.current)
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
