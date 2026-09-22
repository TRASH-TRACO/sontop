/**
 * Logic tests for the debounce layer — no camera, no models.
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BiteTracker } from "../src/detector.js";

/** Feeds `ratio` for `ms` at 20fps and returns how many times the alarm fired. */
function feed(tracker, ratio, ms, startAt = 0) {
  let fires = 0;
  let ends = 0;
  let t = startAt;
  const step = 50;
  for (; t < startAt + ms; t += step) {
    const r = tracker.update(ratio, t);
    if (r.fire) fires++;
    if (r.ended) ends++;
  }
  return { fires, ends, now: t };
}

test("a brief pass near the mouth does not fire", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 900, cooldownMs: 5000 });
  let now = 0;
  ({ now } = feed(tr, 0.6, 1000, now));
  const { fires } = feed(tr, 0.1, 400, now); // 0.4s inside the threshold
  assert.equal(fires, 0);
});

test("staying near the mouth past the dwell time fires once", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 900, cooldownMs: 5000 });
  const { fires } = feed(tr, 0.1, 2000);
  assert.equal(fires, 1, "should fire exactly once while the hand stays put");
});

test("dwell of 0 fires immediately", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 0, cooldownMs: 5000 });
  const { fires } = feed(tr, 0.05, 100);
  assert.equal(fires, 1);
});

test("hysteresis keeps the alarm up until the hand clearly leaves", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 300, cooldownMs: 5000, release: 1.35 });
  let now = 0;
  ({ now } = feed(tr, 0.1, 1000, now));
  assert.equal(tr.active, true);

  // 0.24 is above the 0.2 trigger but below the 0.27 release point.
  ({ now } = feed(tr, 0.24, 500, now));
  assert.equal(tr.active, true, "should not drop out on a small wobble");

  const { ends } = feed(tr, 0.5, 300, now);
  assert.equal(ends, 1);
  assert.equal(tr.active, false);
});

test("cooldown suppresses a repeat alarm, then allows one", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 200, cooldownMs: 3000 });
  let now = 0;
  let total = 0;

  for (let round = 0; round < 3; round++) {
    let r = feed(tr, 0.1, 600, now);
    total += r.fires;
    now = r.now;
    r = feed(tr, 0.9, 600, now); // hand away, alarm ends
    now = r.now;
  }
  // Rounds land at ~0s, ~1.2s, ~2.4s — all inside one 3s cooldown.
  assert.equal(total, 1);

  const after = feed(tr, 0.1, 600, now + 3000);
  assert.equal(after.fires, 1, "a later episode should fire again");
});

test("losing the face or hand (null ratio) is never near", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 0, cooldownMs: 1000 });
  const r = tr.update(null, 0);
  assert.equal(r.near, false);
  assert.equal(r.fire, false);
});

test("a flickering detection still counts if most of the window is near", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 600, cooldownMs: 5000, minRatio: 0.6 });
  let fires = 0;
  for (let t = 0; t < 2000; t += 50) {
    // One dropped frame in every four.
    const ratio = t % 200 === 150 ? 0.25 : 0.1;
    if (tr.update(ratio, t).fire) fires++;
  }
  assert.equal(fires, 1);
});

test("stays active for as long as the hand is there, then releases", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 500, cooldownMs: 5000 });
  let now = 0;
  let fires = 0;

  // A long bite: 30 seconds of the fingertip at the mouth.
  for (; now < 30000; now += 50) {
    const r = tr.update(0.12, now);
    if (r.fire) fires++;
    if (now > 1000) assert.equal(r.active, true, `dropped out at ${now}ms`);
  }
  assert.equal(fires, 1, "counted once, not once per re-alert interval");

  // Hand comes away — and only then does it release.
  const off = tr.update(0.9, now);
  assert.equal(off.active, false);
  assert.equal(off.ended, true);
});

test("a repeat bite inside the cooldown still raises the alarm, just isn't recounted", () => {
  const tr = new BiteTracker({ threshold: 0.2, dwellMs: 300, cooldownMs: 10000 });
  let now = 0;

  let r = feed(tr, 0.1, 800, now);
  now = r.now;
  assert.equal(r.fires, 1);

  r = feed(tr, 0.9, 400, now); // hand away
  now = r.now;
  assert.equal(tr.active, false);

  r = feed(tr, 0.1, 800, now); // straight back to the mouth
  now = r.now;
  assert.equal(tr.active, true, "alarm must come back up even inside the cooldown");
  assert.equal(r.fires, 0, "but it should not count a second time");
});
