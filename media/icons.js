// Small inline SVG icon set shared by the webviews (no external icon font needed).
(function () {
  const P = {
    branch: '<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.6v4.8M11 7.1c0 2.4-3 2.4-5.4 3.6"/>',
    sync: '<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.8 1.8v2.9H8.9M4.2 14.2v-2.9h2.9"/>',
    down: '<path d="M8 2.5v10M4 8.8l4 4 4-4"/>',
    up: '<path d="M8 13.5v-10M4 7.2l4-4 4 4"/>',
    fetch: '<path d="M2.5 9.5a3 3 0 0 1 1.9-5.4 4 4 0 0 1 7.6 1 2.6 2.6 0 0 1-.4 5.2"/><path d="M8 7v7M6 12l2 2 2-2"/>',
    check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 2.5 4 5.5 4"/>',
    stash: '<rect x="2.5" y="3" width="11" height="3.5" rx=".8"/><path d="M3.5 6.5v6h9v-6M6.5 9h3"/>',
    graph: '<circle cx="4" cy="3.5" r="1.4"/><circle cx="4" cy="12.5" r="1.4"/><circle cx="12" cy="8" r="1.4"/><path d="M4 5v6M5.2 4.3c3 .8 5.6 1.8 5.8 2.6M5.2 11.7c3-.8 5.6-1.8 5.8-2.6"/>',
    undo: '<path d="M4.5 6.5h5.5a3.5 3.5 0 0 1 0 7H6"/><path d="M7 3.5l-3 3 3 3"/>',
    compare: '<path d="M5 2.5v11M11 2.5v11M2.5 6h5M8.5 10h5"/>',
    book: '<path d="M2.5 3.5c2-1 4-1 5.5 0v10c-1.5-1-3.5-1-5.5 0zM13.5 3.5c-2-1-4-1-5.5 0v10c1.5-1 3.5-1 5.5 0z"/>',
    repo: '<path d="M3.5 2.5h9v10h-9z"/><path d="M3.5 10.5h9M6 12.5v2l1-.7 1 .7v-2"/>',
    cloud: '<path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7.6 2.7 2.7 0 0 1 .1 5.4z"/>',
    warn: '<path d="M8 2l6.3 11H1.7z"/><path d="M8 6.5v3M8 11.5v.1"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v4M8 5v.1"/>',
    light: '<path d="M6 12.5h4M6.5 14.5h3M5 9.5a4 4 0 1 1 6 0c-.7.7-1 1.4-1 2H6c0-.6-.3-1.3-1-2z"/>',
    switch: '<path d="M3 5h9.5M10 2.5 12.5 5 10 7.5M13 11H3.5M6 8.5 3.5 11 6 13.5"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
    file: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>',
    tag: '<path d="M2.5 2.5h5.5l6 6-5.5 5.5-6-6z"/><circle cx="5.5" cy="5.5" r="1"/>',
    play: '<path d="M4.5 2.5l9 5.5-9 5.5z"/>',
    stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>',
    skip: '<path d="M3 3l7 5-7 5zM12.5 3v10"/>',
    edit: '<path d="M10.5 2.5l3 3-8 8h-3v-3z"/>',
    history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.5H5M8 5v3.3l2 1.5"/>',
    github: '<path d="M6 13.5c-3 1-3-1.5-4.5-2M10 15.5v-2.7c0-.8.1-1.1-.4-1.6 1.9-.2 3.9-.9 3.9-4.2a3.3 3.3 0 0 0-.9-2.3 3 3 0 0 0-.1-2.3s-.7-.2-2.3.9a8 8 0 0 0-4.2 0C4.4 2.2 3.7 2.4 3.7 2.4a3 3 0 0 0-.1 2.3 3.3 3.3 0 0 0-.9 2.3c0 3.3 2 4 3.9 4.2-.5.5-.5 1-.5 1.6v2.7"/>',
    drag: '<path d="M6 4h.1M10 4h.1M6 8h.1M10 8h.1M6 12h.1M10 12h.1" stroke-width="2.4"/>',
    arrowUp: '<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>',
    arrowDown: '<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>',
  };
  window.icon = function (name, extraClass) {
    return `<svg class="ico ${extraClass || ''}" viewBox="0 0 16 16" aria-hidden="true">${P[name] || ''}</svg>`;
  };
  window.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  };
  window.relTime = function (ms) {
    if (!ms) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    const units = [[60, 'min'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
    let u = units[0];
    for (const x of units) if (s >= x[0]) u = x;
    const n = Math.max(1, Math.round(s / u[0]));
    return `${n} ${u[1]}${n === 1 ? '' : 's'} ago`;
  };
})();
