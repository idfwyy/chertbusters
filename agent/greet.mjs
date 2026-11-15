// Greet on Chert's bridge_ready metadata, or shortly after a caller joins if it never arrives.
// The bridge can arrive after the fallback; it must still be observed without greeting twice.

// RoomEvent.RoomMetadataChanged in @livekit/rtc-node. The room's metadata is already updated when it fires.
const METADATA_CHANGED = 'roomMetadataChanged';

/**
 * True when the room metadata carries chert dev's bridge_ready signal.
 * @param {string | undefined} metadata
 */
export function bridgeReady(metadata) {
  try { return JSON.parse(metadata || '{}')?.chert_bridge_ready === true; } catch { return false; }
}

/**
 * Calls greet() once: at once if the signal is already in the room, otherwise when it arrives.
 * Returns a function that stops waiting.
 * @param {{ metadata?: string, on(event: string, listener: () => void): unknown, off(event: string, listener: () => void): unknown }} room
 * @param {() => unknown} greet
 * @returns {() => void}
 */
export function greetOnBridgeReady(room, greet) {
  let done = false;
  const stop = () => { done = true; room.off(METADATA_CHANGED, check); };
  function check() {
    if (done || !bridgeReady(room.metadata)) return;
    stop();
    try { greet(); } catch { /* the call ended first */ }
  }
  room.on(METADATA_CHANGED, check);
  check();
  return stop;
}

/** Greet once on bridge readiness or after a caller has waited delayMs. */
export function greetWithFallback(room, greet, onBridgeReady = () => {}, delayMs = 2000) {
  let greeted = false, stopped = false, joined = false, timer = null;
  const sayOnce = () => {
    if (stopped || greeted) return;
    greeted = true;
    clearTimeout(timer);
    greet();
  };
  const stopReady = greetOnBridgeReady(room, () => {
    onBridgeReady();
    sayOnce();
  });
  return {
    callerJoined() {
      if (stopped || joined) return;
      joined = true;
      if (!greeted) timer = setTimeout(sayOnce, delayMs);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      stopReady();
    },
  };
}
