// ── TrailLayouter — Sugiyama layout engine ────────────────────────────────────
// Ported from Sourcetrail TrailLayouter.cpp (see Sourcetrail-master reference).
// Pure JS, zero external dependencies. Browser-safe (no Node.js APIs).
//
// Usage:
//   const positions = TrailLayouter.layout(nodes, edges, options);
//   // nodes: [{id, width, height}]
//   // edges: [{source, target}]
//   // options: { rankDir: 'LR'|'TB', rankSep: 150, nodeSep: 30 }
//   // returns: { id → {x, y} }  (center-based coordinates)

'use strict';

const TrailLayouter = (() => {

    // ── Public API ────────────────────────────────────────────────────────────

    function layout(nodes, edges, options) {
        const rankDir  = (options && options.rankDir)  || 'LR';
        const rankSep  = (options && options.rankSep)  || 150;
        const nodeSep  = (options && options.nodeSep)  || 30;
        const horiz    = rankDir === 'LR';

        const { trailNodes, trailEdges, root } = _buildGraph(nodes, edges);
        if (!root) return {};

        _makeAcyclicIterative(trailNodes);
        _assignLongestPathLevels(root, trailNodes);
        _assignRemainingLevels(root, trailNodes);
        _insertVirtualNodes(trailEdges, trailNodes);

        const cols = _buildColumns(trailNodes);
        _reduceCrossings(cols);
        _computePositions(cols, horiz, rankSep, nodeSep);

        return _extractPositions(trailNodes);
    }

    // ── Stage 1: Build internal graph ─────────────────────────────────────────

    function _buildGraph(nodes, edges) {
        const nodeMap = {};
        const trailNodes = [];
        const trailEdges = [];

        for (const n of nodes) {
            const tn = {
                id: n.id, level: -1,
                pos: { x: 0, y: 0 },
                w: n.width || 120, h: n.height || 40,
                inEdges: [], outEdges: [],
                isVirtual: false,
            };
            nodeMap[n.id] = tn;
            trailNodes.push(tn);
        }

        for (const e of edges) {
            const origin = nodeMap[e.source];
            const target = nodeMap[e.target];
            if (!origin || !target || origin === target) continue;
            const te = { origin, target, virtual: [] };
            origin.outEdges.push(te);
            target.inEdges.push(te);
            trailEdges.push(te);
        }

        // Pick root: node with no incoming edges; fallback to first node
        let root = trailNodes.find(n => n.inEdges.length === 0) || trailNodes[0] || null;
        return { trailNodes, trailEdges, root };
    }

    // ── Stage 2: Cycle removal (iterative DFS) ────────────────────────────────

    function _makeAcyclicIterative(trailNodes) {
        const visiting = new Set();
        const visited  = new Set();
        const toSwitch = [];

        for (const start of trailNodes) {
            if (visited.has(start)) continue;
            const stack = [{ node: start, edgeIdx: 0 }];
            visiting.add(start);

            while (stack.length) {
                const top = stack[stack.length - 1];
                if (top.edgeIdx < top.node.outEdges.length) {
                    const e = top.node.outEdges[top.edgeIdx++];
                    if (visiting.has(e.target)) {
                        toSwitch.push(e);
                    } else if (!visited.has(e.target)) {
                        visiting.add(e.target);
                        stack.push({ node: e.target, edgeIdx: 0 });
                    }
                } else {
                    visiting.delete(top.node);
                    visited.add(top.node);
                    stack.pop();
                }
            }
        }

        for (const e of toSwitch) _switchEdge(e);
    }

    function _switchEdge(edge) {
        const { origin, target } = edge;
        origin.outEdges = origin.outEdges.filter(e => e !== edge);
        target.inEdges  = target.inEdges.filter(e => e !== edge);
        edge.origin = target;
        edge.target = origin;
        target.outEdges.push(edge);
        origin.inEdges.push(edge);
    }

    // ── Stage 3: Level assignment (longest-path BFS) ──────────────────────────

    function _assignLongestPathLevels(root, trailNodes) {
        // BFS forward to find the furthest frontier
        let frontier = new Set([root]);
        const pred = new Map();
        let level = 0;
        let lastFrontier = frontier;

        while (frontier.size) {
            const next = new Set();
            for (const node of frontier) {
                for (const e of node.outEdges) {
                    next.add(e.target);
                    pred.set(e.target, node);
                }
            }
            if (!next.size) break;
            lastFrontier = next;
            frontier = next;
            level++;
        }

        // Walk backwards from last frontier, assigning level numbers
        frontier = lastFrontier;
        while (frontier.size) {
            const prev = new Set();
            for (const node of frontier) {
                node.level = level;
                if (level > 0) {
                    const p = pred.get(node);
                    if (p) prev.add(p);
                }
            }
            frontier = prev;
            level--;
        }
    }

    // ── Stage 4: Assign levels to remaining unvisited nodes ───────────────────

    function _assignRemainingLevels(root, trailNodes) {
        const allNodes = new Set([root]);
        const queue    = [root];

        while (queue.length) {
            const node = queue.shift();
            for (const e of node.outEdges) {
                if (!allNodes.has(e.target)) {
                    allNodes.add(e.target);
                    queue.push(e.target);
                }
            }
            if (node.level < 0) {
                let maxLevel = -1;
                for (const e of node.inEdges) {
                    if (e.origin.level >= 0) maxLevel = Math.max(maxLevel, e.origin.level + 1);
                }
                node.level = maxLevel;
            }
        }

        // Nodes not reachable from root: assign level 0
        for (const n of trailNodes) {
            if (n.level < 0) n.level = 0;
        }
    }

    // ── Stage 5: Insert virtual nodes for long-span edges ─────────────────────

    function _insertVirtualNodes(trailEdges, trailNodes) {
        const newEdges = [];

        for (const edge of trailEdges) {
            let cur = edge;
            for (let i = cur.origin.level + 1; i < cur.target.level; i++) {
                const vn = {
                    id: `__virt_${trailNodes.length}`,
                    level: i, pos: { x: 0, y: 0 },
                    w: 1, h: 20,
                    inEdges: [], outEdges: [],
                    isVirtual: true,
                };
                trailNodes.push(vn);
                edge.virtual.push(vn);

                const ve = { origin: cur.origin, target: vn, virtual: [] };
                cur.origin.outEdges = cur.origin.outEdges.filter(e => e !== cur);
                cur.origin.outEdges.push(ve);
                vn.inEdges.push(ve);
                vn.outEdges.push(cur);
                cur.origin = vn;
                newEdges.push(ve);
            }
        }

        trailEdges.push(...newEdges);
    }

    // ── Stage 6: Build columns (group nodes by level) ─────────────────────────

    function _buildColumns(trailNodes) {
        const cols = [];
        for (const node of trailNodes) {
            const col = node.level + 1;
            while (cols.length <= col) cols.push([]);
            cols[col].push(node);
        }
        return cols;
    }

    // ── Stage 7: Reduce edge crossings (barycenter heuristic) ─────────────────

    function _reduceCrossings(cols) {
        for (let i = 1; i < cols.length; i++) {
            const nodes     = cols[i];
            const neighbors = (cols[i - 1].length === 1 && cols[i + 1] && cols[i + 1].length > 0)
                ? cols[i + 1] : cols[i - 1];
            const usePred = neighbors === cols[i - 1];

            const neighborIdx = new Map(neighbors.map((n, j) => [n, j]));
            const scored = nodes.map((node, j) => {
                const edges = usePred ? node.inEdges : node.outEdges;
                const conns = usePred
                    ? edges.map(e => neighborIdx.get(e.origin)).filter(v => v !== undefined)
                    : edges.map(e => neighborIdx.get(e.target)).filter(v => v !== undefined);
                const score = conns.length ? conns.reduce((a, b) => a + b, 0) / conns.length : j;
                return { node, score };
            });

            scored.sort((a, b) => a.score - b.score);
            cols[i] = scored.map(s => s.node);
        }
    }

    // ── Stage 8: Compute positions ────────────────────────────────────────────

    function _computePositions(cols, horiz, rankSep, nodeSep) {
        const widths  = cols.map(col => Math.max(...col.map(n => horiz ? n.w : n.h), 1));
        const heights = cols.map(col => col.reduce((s, n) => s + (horiz ? n.h : n.w) + nodeSep, -nodeSep));

        const maxH   = Math.max(...heights);
        const maxIdx = heights.indexOf(maxH);

        // Assign x (column axis) and y (within-column axis)
        let x = 0;
        for (let i = 0; i < cols.length; i++) {
            let y = -heights[i] / 2;
            for (const node of cols[i]) {
                const nodeH = horiz ? node.h : node.w;
                node.pos = horiz ? { x: x + widths[i] / 2, y: y + nodeH / 2 }
                                 : { x: y + nodeH / 2,     y: x + widths[i] / 2 };
                y += nodeH + nodeSep;
            }
            if (i + 1 < cols.length) x += widths[i] + rankSep;
        }

        // Align shorter columns to average position of their neighbors
        for (let i = maxIdx - 1; i >= 0; i--) _moveToAverage(cols[i], false, horiz);
        for (let i = maxIdx + 1; i < cols.length; i++) _moveToAverage(cols[i], true, horiz);
    }

    function _moveToAverage(nodes, forward, horiz) {
        if (!nodes.length) return;
        const idx = horiz ? 'y' : 'x';

        const sums = nodes.map(node => {
            const edges = forward ? node.inEdges : node.outEdges;
            const vals  = forward
                ? edges.map(e => e.origin.pos[idx] + (horiz ? e.origin.h : e.origin.w) / 2)
                : edges.map(e => e.target.pos[idx] + (horiz ? e.target.h : e.target.w) / 2);
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        });

        const validSums = sums.filter(v => v !== null);
        if (!validSums.length) return;
        const avg = validSums.reduce((a, b) => a + b, 0) / validSums.length;

        const totalH = nodes.reduce((s, n) => s + (horiz ? n.h : n.w), 0);
        const shift  = avg - totalH / 2 - nodes[0].pos[idx];
        for (const n of nodes) n.pos[idx] += shift;
    }

    // ── Stage 9: Extract output positions (real nodes only) ───────────────────

    function _extractPositions(trailNodes) {
        const out = {};
        for (const n of trailNodes) {
            if (!n.isVirtual && n.level >= 0) out[n.id] = { x: n.pos.x, y: n.pos.y };
        }
        return out;
    }

    return { layout };

})();
