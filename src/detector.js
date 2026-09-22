/**
 * Nail-biting detector.
 *
 * Runs MediaPipe Tasks Vision entirely on-device: a face landmarker gives us the
 * mouth, a hand landmarker gives us the fingertips, and we watch the smallest
 * fingertip-to-mouth distance. That distance is divided by the face width so the
 * threshold stays meaningful whether you sit close to the camera or far from it.
 */

import { VENDOR_BASE, FACE_MODEL, HAND_MODEL } from "./config.js";

// Face mesh indices. Mouth ring points we measure to, plus the cheek pair we use
// as the scale reference.
const MOUTH = [13, 14, 0, 17, 61, 291, 37, 267, 84, 314];
const CHEEK_L = 234;
const CHEEK_R = 454;

// Hand landmark indices of the five fingertips.
const TIPS = [4, 8, 12, 16, 20];

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export async function createDetector(onProgress = () => {}) {
  onProgress("런타임 내려받는 중…");
  const { FilesetResolver, FaceLandmarker, HandLandmarker } = await import(
    /* @vite-ignore */ `${VENDOR_BASE}/vision_bundle.mjs`
  );

  onProgress("WASM 준비 중…");
  const fileset = await FilesetResolver.forVisionTasks(`${VENDOR_BASE}/wasm`);

  onProgress("모델 내려받는 중… (최초 1회, 약 10MB)");
  const [face, hand] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: FACE_MODEL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }),
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: HAND_MODEL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  ]);

  return new Detector(face, hand);
}

class Detector {
  #face;
  #hand;
  #lastFace = null;
  #faceTick = 0;

  constructor(face, hand) {
    this.#face = face;
    this.#hand = hand;
    /** Re-running the face model on every frame is wasted work: heads move far
     *  slower than hands, so we refresh it every Nth frame and reuse the mouth. */
    this.faceEvery = 3;
  }

  close() {
    this.#face?.close();
    this.#hand?.close();
  }

  /**
   * @returns {{ratio:number|null, face:object|null, hands:Array, mouth:object|null, tip:object|null}}
   *          `ratio` is the nearest fingertip-to-mouth distance in face widths,
   *          or null when either a face or a hand is missing from the frame.
   */
  detect(video, timestampMs) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return EMPTY;

    if (this.#faceTick % this.faceEvery === 0 || !this.#lastFace) {
      const res = this.#face.detectForVideo(video, timestampMs);
      this.#lastFace = res?.faceLandmarks?.[0] ?? null;
    }
    this.#faceTick++;

    const handRes = this.#hand.detectForVideo(video, timestampMs);
    const hands = handRes?.landmarks ?? [];
    const face = this.#lastFace;

    if (!face || hands.length === 0) {
      return { ratio: null, face, hands, mouth: null, tip: null };
    }

    // Normalized landmark coords are relative to width/height independently, so
    // they must go back to pixels before any distance is comparable.
    const px = (p) => ({ x: p.x * w, y: p.y * h });

    const faceWidth = dist(px(face[CHEEK_L]), px(face[CHEEK_R]));
    if (faceWidth < 1) return { ratio: null, face, hands, mouth: null, tip: null };

    const mouthPts = MOUTH.map((i) => px(face[i]));
    const mouth = centroid(mouthPts);

    let best = Infinity;
    let bestTip = null;
    for (const hand of hands) {
      for (const t of TIPS) {
        const tip = px(hand[t]);
        for (const m of mouthPts) {
          const d = dist(tip, m);
          if (d < best) {
            best = d;
            bestTip = tip;
          }
        }
      }
    }

    return { ratio: best / faceWidth, face, hands, mouth, tip: bestTip };
  }
}

const EMPTY = { ratio: null, face: null, hands: [], mouth: null, tip: null };

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/**
 * Turns the per-frame distance into an alarm decision.
 *
 * A single close frame is not a bite — the hand brushing past the chin produces
 * those constantly. We keep a short sliding window and fire only when the
 * fingertip stayed inside the threshold for most of it, then hold the alarm
 * until it clears a wider release threshold so it doesn't chatter.
 */
export class BiteTracker {
  constructor(opts = {}) {
    this.threshold = opts.threshold ?? 0.22;
    this.dwellMs = opts.dwellMs ?? 900;
    this.cooldownMs = opts.cooldownMs ?? 6000;
    this.minRatio = opts.minRatio ?? 0.6; // share of window frames that must be near
    this.release = opts.release ?? 1.35; // hysteresis multiplier
    this.window = [];
    this.active = false;
    // -Infinity, not 0: performance.now() starts near zero, so a plain 0 would
    // let the cooldown swallow the first alarm of the session.
    this.lastFiredAt = -Infinity;
  }

  reset() {
    this.window.length = 0;
    this.active = false;
  }

  /**
   * @param {number|null} ratio  distance in face widths, null when not visible
   * @param {number} now         performance.now()
   * @returns {{near:boolean, fire:boolean, ended:boolean, active:boolean}}
   */
  update(ratio, now) {
    const limit = this.active ? this.threshold * this.release : this.threshold;
    const near = ratio != null && ratio <= limit;

    this.window.push({ t: now, near });
    const cutoff = now - Math.max(this.dwellMs, 250);
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();

    let fire = false;
    let ended = false;

    if (!this.active && near && this.#windowSatisfied(now)) {
      this.active = true;
      if (now - this.lastFiredAt >= this.cooldownMs) {
        this.lastFiredAt = now;
        fire = true;
      }
    } else if (this.active && !near) {
      this.active = false;
      ended = true;
    }

    return { near, fire, ended, active: this.active };
  }

  #windowSatisfied(now) {
    if (this.dwellMs <= 0) return true;
    if (this.window.length < 2) return false;
    // The window has to actually cover the dwell period before its contents mean
    // anything — otherwise two near frames right after start would count as a
    // full second. The 0.8 slack absorbs the frame quantisation.
    if (now - this.window[0].t < this.dwellMs * 0.8) return false;
    const nearCount = this.window.reduce((n, s) => n + (s.near ? 1 : 0), 0);
    return nearCount / this.window.length >= this.minRatio;
  }
}
