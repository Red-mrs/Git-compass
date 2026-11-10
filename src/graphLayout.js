'use strict';
// Computes the "railway" lanes of a commit graph. Pure function, no vscode dependency.
//
// Input: commits ordered so that children come before their parents (git log default).
// Output per row: { col, lines } where `lines` are segments [fromCol, fromY, toCol, toY]
// with Y in {0 = top of row, 1 = middle (the commit dot), 2 = bottom of row}.
// Lanes never move sideways, so a lane keeps its column (and colour) for its whole life.

function computeGraph(commits) {
  const lanes = []; // lane index -> sha that the lane is "waiting for" (or null = free)
  const rows = [];
  let width = 0;

  const freeSlot = () => {
    let k = lanes.indexOf(null);
    if (k === -1) { k = lanes.length; lanes.push(null); }
    return k;
  };

  for (const c of commits) {
    const lines = [];
    let col = lanes.indexOf(c.sha);
    const hasChild = col !== -1;
    if (!hasChild) col = freeSlot();

    // pass-through lanes and lanes converging into this commit
    for (let j = 0; j < lanes.length; j++) {
      const s = lanes[j];
      if (s === null) continue;
      if (s === c.sha) {
        lines.push([j, 0, col, 1]);
        if (j !== col) lanes[j] = null;
      }
    }
    const passThrough = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== col && lanes[j] !== null) passThrough.push(j);
    }

    // parents
    const parents = c.parents || [];
    lanes[col] = parents.length ? parents[0] : null;
    if (parents.length) lines.push([col, 1, col, 2]);
    for (let p = 1; p < parents.length; p++) {
      let k = lanes.indexOf(parents[p]);
      if (k === -1) { k = freeSlot(); lanes[k] = parents[p]; }
      lines.push([col, 1, k, 2]);
    }
    for (const j of passThrough) lines.push([j, 0, j, 2]);

    // trim trailing free lanes so the graph does not grow forever
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    let rowWidth = col + 1;
    for (const l of lines) rowWidth = Math.max(rowWidth, l[0] + 1, l[2] + 1);
    width = Math.max(width, rowWidth);
    rows.push({ col, lines, merge: parents.length > 1, root: parents.length === 0 });
  }
  return { rows, width };
}

module.exports = { computeGraph };
