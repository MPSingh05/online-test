// The test timer. An attempt has a deadline; pausing freezes the time left, and resuming moves the
// deadline on by however long the test was paused. Paused time is kept in `pausedMs` so it can be left
// out of the time taken.

export const isPaused = (attempt) => Boolean(attempt.pausedAt);

// Milliseconds left on the clock; frozen while paused. Negative once the time is up.
export function remainingMs(attempt, now = Date.now()) {
  const stoppedAt = isPaused(attempt) ? Date.parse(attempt.pausedAt) : now;
  return Date.parse(attempt.deadline) - stoppedAt;
}

// Past the deadline by more than `graceMs` (an allowance for the browser's own auto-submit to arrive).
// A paused test never runs out of time.
export const isExpired = (attempt, graceMs, now = Date.now()) => !isPaused(attempt) && remainingMs(attempt, now) < -graceMs;

export function pause(attempt, now = Date.now()) {
  if (isPaused(attempt)) return;
  attempt.pausedAt = new Date(now).toISOString();
  attempt.pauseCount = (attempt.pauseCount ?? 0) + 1;
}

export function resume(attempt, now = Date.now()) {
  if (!isPaused(attempt)) return;
  const pausedFor = Math.max(0, now - Date.parse(attempt.pausedAt));
  attempt.deadline = new Date(Date.parse(attempt.deadline) + pausedFor).toISOString();
  attempt.pausedMs = (attempt.pausedMs ?? 0) + pausedFor;
  attempt.pausedAt = null;
}
