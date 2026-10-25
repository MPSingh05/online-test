import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as clock from '../lib/clock.js';
import { gradeAttempt } from '../lib/grading.js';

const t0 = Date.parse('2026-10-25T10:00:00Z');
const min = 60_000;
const newAttempt = () => ({ startedAt: new Date(t0).toISOString(), deadline: new Date(t0 + 20 * min).toISOString() });

test('pausing freezes the time left and resuming keeps it', () => {
  const attempt = newAttempt();
  assert.equal(clock.remainingMs(attempt, t0 + 5 * min), 15 * min);

  clock.pause(attempt, t0 + 5 * min);
  assert.ok(clock.isPaused(attempt));
  assert.equal(attempt.pauseCount, 1);
  assert.equal(clock.remainingMs(attempt, t0 + 50 * min), 15 * min, 'frozen however long it stays paused');
  clock.pause(attempt, t0 + 6 * min); // pausing again changes nothing
  assert.equal(attempt.pausedAt, new Date(t0 + 5 * min).toISOString());

  clock.resume(attempt, t0 + 50 * min);
  assert.equal(clock.isPaused(attempt), false);
  assert.equal(attempt.pausedMs, 45 * min);
  assert.equal(attempt.deadline, new Date(t0 + 65 * min).toISOString(), 'deadline moved on by the pause');
  assert.equal(clock.remainingMs(attempt, t0 + 50 * min), 15 * min);
  clock.resume(attempt, t0 + 51 * min); // resuming a running test changes nothing
  assert.equal(attempt.pausedMs, 45 * min);

  clock.pause(attempt, t0 + 60 * min);
  clock.resume(attempt, t0 + 70 * min);
  assert.equal(attempt.pausedMs, 55 * min, 'paused time adds up');
  assert.equal(attempt.pauseCount, 2);
});

test('a paused test never runs out of time', () => {
  const attempt = newAttempt();
  const grace = 30_000;
  assert.equal(clock.isExpired(attempt, grace, t0 + 20 * min + 10_000), false, 'within the grace period');
  assert.ok(clock.isExpired(attempt, grace, t0 + 21 * min));
  clock.pause(attempt, t0 + 19 * min);
  assert.equal(clock.isExpired(attempt, grace, t0 + 300 * min), false);
  clock.resume(attempt, t0 + 300 * min);
  assert.equal(clock.isExpired(attempt, grace, t0 + 300 * min + 30_000), false, 'one minute was left when paused');
  assert.ok(clock.isExpired(attempt, grace, t0 + 302 * min));
});

test('time taken leaves out the time spent paused', () => {
  const testRecord = { config: { timeLimitMin: 20, passPercent: 50 }, questions: [] };
  const result = gradeAttempt(testRecord, {
    answers: {},
    startedAt: new Date(t0).toISOString(),
    submittedAt: new Date(t0 + 50 * min).toISOString(),
    pausedMs: 40 * min,
  });
  assert.equal(result.timeTakenSec, 10 * 60);
});
