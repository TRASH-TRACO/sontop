/**
 * Where the runtime and the models come from.
 *
 * Both are fetched once and then kept by the service worker, so the app only
 * needs the network on a cold first load. To run fully self-hosted or offline,
 * copy `@mediapipe/tasks-vision` (its `vision_bundle.mjs` and `wasm/` folder)
 * and the two `.task` files next to this app and point these at them:
 *
 *   export const VENDOR_BASE = "../vendor/tasks-vision";
 *   export const MODEL_BASE = "../vendor/models";
 */

export const VENDOR_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";
export const MODEL_BASE = "https://storage.googleapis.com/mediapipe-models";

export const FACE_MODEL = `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;
export const HAND_MODEL = `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`;
