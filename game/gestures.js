// Turns MediaPipe Hands landmarks into the small gesture vocabulary the game uses.
//
// The caller video is a FaceTime window capture. It is not mirrored, so a hand
// pointing to the right of the picture is the player's left hand. `mirror: true`
// flips that for a local webcam preview.
//
// Landmarks are normalized to the image: (0,0) top left, (1,1) bottom right.
// Indices follow the MediaPipe Hands model:
//   0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky.

const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { thumb: 3, index: 6, middle: 10, ring: 14, pinky: 18 };
const MCP = { thumb: 2, index: 5, middle: 9, ring: 13, pinky: 17 };

export const GESTURE_LABELS = {
  none: '',
  point: 'Point',
  fist: 'Fist',
  open_palm: 'Open palm',
  thumbs_up: 'Thumbs up',
};

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * A finger counts as extended when its tip is clearly farther from the wrist
 * and from its own knuckle than the middle joint is. This is orientation
 * independent and works for a hand held sideways as well as upright.
 */
export function fingerExtended(landmarks, name) {
  const wrist = landmarks[0];
  const tip = landmarks[TIP[name]];
  const pip = landmarks[PIP[name]];
  const mcp = landmarks[MCP[name]];
  if (!wrist || !tip || !pip || !mcp) return false;
  return distance(tip, mcp) > distance(pip, mcp) * 1.15 && distance(tip, wrist) > distance(pip, wrist) * 0.9;
}

/** Bounding box of the hand in normalized image coordinates. */
export function handBox(landmarks) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** True when the hand is held up near the face, for the lobby calibration. */
export function handRaised(landmarks) {
  if (!landmarks || landmarks.length < 21) return false;
  const scale = distance(landmarks[0], landmarks[9]);
  return landmarks[0].y < 0.68 && scale > 0.055;
}

/** Image-space direction of the index finger. */
export function pointDirection(landmarks) {
  const dx = landmarks[8].x - landmarks[5].x;
  const dy = landmarks[8].y - landmarks[5].y;
  if (Math.hypot(dx, dy) < 0.035) return null;
  if (Math.abs(dx) > Math.abs(dy) * 1.25) return dx > 0 ? 'right' : 'left';
  if (Math.abs(dy) > Math.abs(dx) * 1.25) return dy < 0 ? 'up' : 'down';
  return null;
}

/**
 * @param {Array<{x:number,y:number}>} landmarks
 * @param {{ handednessScore?: number, mirror?: boolean }} options
 */
export function classifyHand(landmarks, { handednessScore = 1, mirror = false } = {}) {
  const empty = { gesture: 'none', direction: null, imageDirection: null, raised: false, extended: {}, center: { x: 0.5, y: 0.5 }, size: 0, confidence: 0 };
  if (!Array.isArray(landmarks) || landmarks.length < 21) return empty;

  const box = handBox(landmarks);
  const size = Math.max(box.w, box.h);
  if (size < 0.055) return { ...empty, size };

  const extended = {
    thumb: fingerExtended(landmarks, 'thumb'),
    index: fingerExtended(landmarks, 'index'),
    middle: fingerExtended(landmarks, 'middle'),
    ring: fingerExtended(landmarks, 'ring'),
    pinky: fingerExtended(landmarks, 'pinky'),
  };
  const fingersOut = ['index', 'middle', 'ring', 'pinky'].filter(f => extended[f]).length;
  const thumbTip = landmarks[4];
  const thumbMcp = landmarks[2];
  const thumbUp = thumbTip.y < thumbMcp.y - 0.04 && Math.abs(thumbTip.y - thumbMcp.y) > Math.abs(thumbTip.x - thumbMcp.x) * 0.55;

  let gesture = 'none';
  let imageDirection = null;
  if (fingersOut === 0 && extended.thumb && thumbUp) {
    gesture = 'thumbs_up';
  } else if (fingersOut === 4) {
    gesture = 'open_palm';
  } else if (fingersOut === 0) {
    gesture = 'fist';
  } else if (extended.index && fingersOut === 1) {
    gesture = 'point';
    imageDirection = pointDirection(landmarks);
    if (!imageDirection) gesture = 'none';
  }

  // Picture right is the player's left when the caller feed is not mirrored.
  let direction = null;
  if (imageDirection === 'left') direction = mirror ? 'left' : 'right';
  else if (imageDirection === 'right') direction = mirror ? 'right' : 'left';
  else if (imageDirection) direction = imageDirection;

  return {
    gesture,
    direction,
    imageDirection,
    raised: handRaised(landmarks),
    extended,
    center: { x: (landmarks[0].x + landmarks[5].x + landmarks[9].x + landmarks[13].x + landmarks[17].x) / 5, y: (landmarks[0].y + landmarks[5].y + landmarks[9].y + landmarks[13].y + landmarks[17].y) / 5 },
    size,
    confidence: Math.max(0, Math.min(1, Number.isFinite(handednessScore) ? handednessScore : 1)),
  };
}
