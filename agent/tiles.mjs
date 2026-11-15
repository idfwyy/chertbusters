// Finds the caller tiles inside the FaceTime window capture that Chert sends.
//
// The capture is a screen recording of the FaceTime window: remote callers sit
// on a mostly black background, with our own self-view thumbnail, the call
// buttons, and name pills around them. We do not assume a fixed pixel layout.
// Every frame is reduced to a coarse luma grid, bright cells are grouped into
// connected boxes, and boxes that are too small, too low, or in the known
// corner-UI zones are dropped. The result is stabilised over two frames so a
// single compression artefact does not swap a player's camera.
//
// TILE_RECTS is the operator escape hatch for a line whose capture layout is
// unusual: "x,y,w,h;x,y,w,h" in normalized 0..1 coordinates. TILE_COUNT=1|2
// forces a count and falls back to equal columns when detection finds nothing.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function parseRects(value) {
  if (!value || typeof value !== 'string') return [];
  return value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const n = part.split(',').map(Number);
    if (n.length !== 4 || n.some(v => !Number.isFinite(v))) return null;
    const [x, y, w, h] = n;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) return null;
    return { x, y, w, h };
  }).filter(Boolean);
}

function wholeFrame(width, height) {
  return [{ id: 0, x: 0, y: 0, w: width, h: height, fallback: true }];
}

function splitFrame(width, height, count) {
  const n = count === 2 ? 2 : 1;
  if (n === 1) return wholeFrame(width, height);
  const gap = Math.round(width * 0.01);
  const w = Math.floor((width - gap) / 2);
  return [
    { id: 0, x: 0, y: 0, w, h: height, fallback: true },
    { id: 1, x: width - w, y: 0, w, h: height, fallback: true },
  ];
}

function boxesFromRects(rects, width, height) {
  return rects.map((r, i) => ({
    id: i,
    x: Math.round(r.x * width),
    y: Math.round(r.y * height),
    w: Math.round(r.w * width),
    h: Math.round(r.h * height),
    fallback: false,
  }));
}

function dilate(mask, gw, gh) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!mask[y * gw + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) out[ny * gw + nx] = 1;
    }
  }
  return out;
}

function erode(mask, gw, gh) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let all = 1;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= gw || ny < 0 || ny >= gh || !mask[ny * gw + nx]) { all = 0; break; }
    }
    if (all) out[y * gw + x] = 1;
  }
  return out;
}

function components(mask, gw, gh, step) {
  const seen = new Uint8Array(mask.length);
  const boxes = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1 || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let minX = i % gw, maxX = minX, minY = Math.floor(i / gw), maxY = minY;
    while (stack.length) {
      const cur = stack.pop();
      const x = cur % gw, y = Math.floor(cur / gw);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (mask[ni] === 1 && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    boxes.push({ x: minX * step, y: minY * step, w: (maxX - minX + 1) * step, h: (maxY - minY + 1) * step });
  }
  return boxes;
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

function iou(a, b) {
  const inter = overlap(a, b);
  if (!inter) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function mergeBoxes(boxes) {
  const list = boxes.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < list.length && !changed; i++) for (let j = i + 1; j < list.length; j++) {
      const inter = overlap(list[i], list[j]);
      if (!inter) continue;
      const small = Math.min(list[i].w * list[i].h, list[j].w * list[j].h);
      if (iou(list[i], list[j]) > 0.2 || inter > small * 0.72) {
        list[i] = union(list[i], list[j]);
        list.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return list;
}

/**
 * @param {Uint8Array} luma width*height luma plane
 * @param {number} width
 * @param {number} height
 * @param {{ step?: number, minLuma?: number, delta?: number, maxTiles?: number, rects?: {x:number,y:number,w:number,h:number}[], count?: number }} [opts]
 */
export function detectTiles(luma, width, height, opts = {}) {
  if (!luma || !width || !height) return wholeFrame(width || 0, height || 0);
  if (opts.rects?.length) return boxesFromRects(opts.rects, width, height);

  const step = opts.step || Math.max(8, Math.floor(width / 80));
  const gw = Math.floor(width / step), gh = Math.floor(height / step);
  if (gw < 4 || gh < 4) return wholeFrame(width, height);

  const cells = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let sum = 0, n = 0;
    const x0 = gx * step, y0 = gy * step;
    for (let y = y0; y < y0 + step && y < height; y += 2) for (let x = x0; x < x0 + step && x < width; x += 2) { sum += luma[y * width + x]; n++; }
    cells[gy * gw + gx] = n ? sum / n : 0;
  }

  const sorted = Array.from(cells).sort((a, b) => a - b);
  const background = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const threshold = Math.max(opts.minLuma ?? 26, background + (opts.delta ?? 14));
  let mask = new Uint8Array(gw * gh);
  for (let i = 0; i < cells.length; i++) mask[i] = cells[i] > threshold ? 1 : 0;
  // FaceTime's self-view sits in the lower-left corner and the call buttons in
  // the lower-right. Clear those UI zones before grouping: the self-view often
  // touches a caller tile, and one shared grid cell is enough to merge them.
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const nx = x / gw, ny = y / gh;
    if ((nx < 0.22 && ny > 0.62) || (nx > 0.8 && ny > 0.8)) mask[y * gw + x] = 0;
  }
  // Erode once instead of closing: a caller tile often touches the self-view
  // thumbnail along one edge, and any dilation would bridge them back together.
  // The box is one grid cell smaller on each side, which is inside the crop.
  mask = erode(mask, gw, gh);

  const minW = width * 0.08, minH = height * 0.14;
  let boxes = mergeBoxes(components(mask, gw, gh, step)).filter(b => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (b.w < minW || b.h < minH) return false;
    if (b.w * b.h > width * height * 0.82) return false;
    if (cy < height * 0.05 || cy > height * 0.82) return false;
    if (b.w / b.h < 0.28 || b.w / b.h > 3.6) return false;
    // FaceTime's self-view thumbnail sits lower left; call buttons lower right.
    if (cx < width * 0.28 && cy > height * 0.58) return false;
    if (cx > width * 0.78 && cy > height * 0.78) return false;
    return true;
  });

  boxes.sort((a, b) => b.w * b.h - a.w * a.h);
  boxes = boxes.slice(0, opts.maxTiles ?? 2);
  boxes.sort((a, b) => a.x - b.x);

  if (!boxes.length) {
    if (opts.count === 1 || opts.count === 2) return splitFrame(width, height, opts.count);
    return wholeFrame(width, height);
  }
  if (opts.count === 1) return [boxes[0]];
  if (opts.count === 2 && boxes.length === 1) return splitFrame(width, height, 2);

  return boxes.map((b, i) => ({
    id: i,
    x: clamp(Math.round(b.x), 0, width - 1),
    y: clamp(Math.round(b.y), 0, height - 1),
    w: clamp(Math.round(b.w), 1, width),
    h: clamp(Math.round(b.h), 1, height),
    fallback: false,
  })).map((b, i) => ({ ...b, w: Math.min(b.w, width - b.x), h: Math.min(b.h, height - b.y), id: i }));
}

function sameLayout(a, b, width, height) {
  if (a.length !== b.length) return false;
  const tolX = width * 0.06, tolY = height * 0.06;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > tolX || Math.abs(a[i].y - b[i].y) > tolY) return false;
    if (Math.abs(a[i].w - b[i].w) > tolX || Math.abs(a[i].h - b[i].h) > tolY) return false;
  }
  return true;
}

function assignIds(previous, boxes, state) {
  const used = new Set();
  const out = boxes.map(b => {
    let best = -1, bestIou = 0;
    for (let i = 0; i < previous.length; i++) {
      if (used.has(i)) continue;
      const score = iou(previous[i], b);
      if (score > bestIou) { bestIou = score; best = i; }
    }
    if (best >= 0 && bestIou > 0.25) {
      used.add(best);
      return { ...b, id: previous[best].id };
    }
    return { ...b, id: state.nextId++ };
  });
  return out;
}

/**
 * Keeps the last good layout until a new one has been seen twice.
 * @param {{stable:any[], pending:any[], pendingCount:number, nextId:number}} state
 */
export function stabilizeTiles(state, boxes, width, height) {
  if (!state.stable) { state.stable = []; state.pending = []; state.pendingCount = 0; state.nextId = 1; }
  if (!state.stable.length) {
    state.stable = assignIds([], boxes, state);
    return state.stable;
  }
  if (sameLayout(state.stable, boxes, width, height)) {
    state.pending = [];
    state.pendingCount = 0;
    return state.stable;
  }
  if (!state.pending.length || !sameLayout(state.pending, boxes, width, height)) {
    state.pending = boxes;
    state.pendingCount = 1;
  } else {
    state.pendingCount++;
  }
  if (state.pendingCount >= 2) {
    state.stable = assignIds(state.stable, state.pending, state);
    state.pending = [];
    state.pendingCount = 0;
  }
  return state.stable;
}
