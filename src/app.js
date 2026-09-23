import { createDetector, BiteTracker, HAND_CONNECTIONS } from "./detector.js";

const $ = (id) => document.getElementById(id);

const el = {
  video: $("video"),
  overlay: $("overlay"),
  boot: $("boot"),
  bootStatus: $("bootStatus"),
  start: $("start"),
  hud: $("hud"),
  stateDot: $("stateDot"),
  stateText: $("stateText"),
  fpsText: $("fpsText"),
  gaugeFill: $("gaugeFill"),
  gaugeMark: $("gaugeMark"),
  distText: $("distText"),
  countText: $("countText"),
  alarm: $("alarm"),
  veil: $("veil"),
  veilBtn: $("veilBtn"),
  toggle: $("toggle"),
  settingsBtn: $("settingsBtn"),
  settings: $("settings"),
  camera: $("camera"),
  history: $("history"),
  testAlarm: $("testAlarm"),
  resetStats: $("resetStats"),
};

const ctx = el.overlay.getContext("2d");

/* ------------------------------------------------------------------ settings */

const SETTINGS_KEY = "sontop.settings.v1";
const STATS_KEY = "sontop.stats.v1";

const DEFAULTS = {
  threshold: 0.22,
  dwell: 900,
  cooldown: 6000,
  sound: true,
  speech: true,
  vibrate: true,
  notify: false,
  debug: false,
  mirror: true,
  blackout: false,
  alertStyle: "full",
  deviceId: "",
};

const settings = { ...DEFAULTS, ...read(SETTINGS_KEY, {}) };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode — settings just won't persist */
  }
}

/* --------------------------------------------------------------------- state */

const tracker = new BiteTracker({
  threshold: settings.threshold,
  dwellMs: settings.dwell,
  cooldownMs: settings.cooldown,
});

let detector = null;
let stream = null;
let running = false;
let wakeLock = null;
let rafId = 0;
// Bumped on every pause/resume so a frame callback queued before a pause can't
// start a second loop chain when it finally fires.
let loopGen = 0;
let lastTick = 0;
let smoothedFps = 0;
const TARGET_INTERVAL = 1000 / 18;

/* --------------------------------------------------------------------- alarm */

let audioCtx = null;
let beepTimer = 0;
let alarmOn = false;
let mutedEpisode = false;
let testUntil = 0;
let speechTimer = 0;
let speechUnlocked = false;
let koVoice = null;
let lastSpokeAt = 0;
const SPEECH_INTERVAL = 2800;

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx?.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function beep(freq = 880, ms = 160, gain = 0.18) {
  const ac = ensureAudio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0.0001, ac.currentTime);
  amp.gain.exponentialRampToValueAtTime(gain, ac.currentTime + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + ms / 1000);
  osc.connect(amp).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + ms / 1000 + 0.02);
}

/**
 * Speech needs two things the detection loop can't provide on its own.
 *
 * iOS only lets speechSynthesis start from a user gesture, so the first call has
 * to happen inside the start click — a silent utterance there unlocks it for
 * every later one. And getVoices() is empty until the engine has loaded, so the
 * Korean voice is picked up on `voiceschanged` rather than read once at startup.
 */
function initSpeech() {
  if (!("speechSynthesis" in window)) return;
  loadVoice();
  speechSynthesis.addEventListener?.("voiceschanged", loadVoice);
  if (speechUnlocked) return;
  const warm = new SpeechSynthesisUtterance(" ");
  warm.volume = 0;
  speechSynthesis.speak(warm);
  speechUnlocked = true;
}

function loadVoice() {
  const voices = speechSynthesis.getVoices?.() ?? [];
  koVoice = voices.find((v) => v.lang?.toLowerCase().startsWith("ko")) ?? null;
}

function say(text = "손 내려") {
  if (!("speechSynthesis" in window)) return;
  // Chrome can leave `speaking` stuck true; if it has outlasted a couple of
  // rounds, clear it rather than going silent for the rest of the session.
  if (speechSynthesis.speaking && performance.now() - lastSpokeAt > SPEECH_INTERVAL * 2) {
    speechSynthesis.cancel();
  } else if (speechSynthesis.speaking || speechSynthesis.pending) {
    return; // still talking — don't stack utterances up
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  if (koVoice) u.voice = koVoice;
  u.rate = 1.05;
  lastSpokeAt = performance.now();
  speechSynthesis.speak(u);
}

function startSpeaking() {
  stopSpeaking();
  if (!settings.speech || mutedEpisode) return;
  say();
  speechTimer = setInterval(() => {
    if (alarmOn && settings.speech && !mutedEpisode) say();
    else stopSpeaking();
  }, SPEECH_INTERVAL);
}

function stopSpeaking() {
  clearInterval(speechTimer);
  speechTimer = 0;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/**
 * The alarm is a *state*, not an event: it mirrors whether a fingertip is at the
 * mouth right now, so it keeps going until the hand actually comes away. The
 * Sound and speech follow that state. The one-shot reactions (counting, haptics,
 * system notification) are separate and rate-limited, so a flurry of short bites
 * isn't counted five times.
 */
function setAlarm(on) {
  if (on === alarmOn) return;
  alarmOn = on;
  el.alarm.hidden = !on;
  if (on) {
    startBeeping();
    startSpeaking();
  } else {
    stopBeeping();
    stopSpeaking();
    mutedEpisode = false; // the next episode starts audible again
  }
}

function startBeeping() {
  stopBeeping();
  if (!settings.sound || mutedEpisode) return;
  beep(920, 150);
  setTimeout(() => {
    if (alarmOn && settings.sound && !mutedEpisode) beep(1180, 200);
  }, 180);
  beepTimer = setInterval(() => {
    if (alarmOn && settings.sound && !mutedEpisode) beep(920, 120);
    else stopBeeping();
  }, 900);
}

function stopBeeping() {
  clearInterval(beepTimer);
  beepTimer = 0;
}

/** Fires once per episode, subject to the re-alert interval. */
function announce({ count = true } = {}) {
  if (settings.vibrate && navigator.vibrate) navigator.vibrate([120, 80, 120, 80, 200]);

  if (settings.notify && "Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification("손 내려!", { body: "손톱 뜯는 동작이 감지됐어요.", icon: "./icons/icon-192.png", tag: "sontop" });
  }

  if (count) bumpStats();
}

/* --------------------------------------------------------------------- stats */

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bumpStats() {
  const stats = read(STATS_KEY, {});
  stats[todayKey()] = (stats[todayKey()] ?? 0) + 1;
  write(STATS_KEY, stats);
  renderStats();
}

function renderStats() {
  const stats = read(STATS_KEY, {});
  el.countText.textContent = `오늘 ${stats[todayKey()] ?? 0}회`;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, n: stats[key] ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.n));

  el.history.replaceChildren(
    ...days.map(({ label, n }) => {
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML = `<span class="day"></span><span class="bar"></span><span class="n"></span>`;
      row.querySelector(".day").textContent = label;
      row.querySelector(".bar").style.width = `${(n / max) * 60}%`;
      row.querySelector(".bar").style.opacity = n ? "1" : "0.2";
      row.querySelector(".n").textContent = `${n}회`;
      return row;
    })
  );
}

/* -------------------------------------------------------------------- camera */

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  el.camera.replaceChildren(
    ...cams.map((c, i) => {
      const o = document.createElement("option");
      o.value = c.deviceId;
      o.textContent = c.label || `카메라 ${i + 1}`;
      return o;
    })
  );
  if (settings.deviceId) el.camera.value = settings.deviceId;
}

async function openCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const constraints = {
    audio: false,
    video: settings.deviceId
      ? { deviceId: { exact: settings.deviceId }, width: { ideal: 960 }, height: { ideal: 720 } }
      : { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } },
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  el.video.srcObject = stream;
  await el.video.play();
  await new Promise((res) => {
    if (el.video.videoWidth) return res();
    el.video.onloadedmetadata = () => res();
  });
  el.overlay.width = el.video.videoWidth;
  el.overlay.height = el.video.videoHeight;
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    /* not fatal — the screen may just dim */
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && running && !wakeLock) keepAwake();
});

/* ---------------------------------------------------------------------- loop */

function loop(now, gen) {
  if (!running || gen !== loopGen) return;
  schedule();

  if (now - lastTick < TARGET_INTERVAL) return;
  const dt = now - lastTick;
  lastTick = now;
  smoothedFps = smoothedFps ? smoothedFps * 0.85 + (1000 / dt) * 0.15 : 1000 / dt;

  let result;
  try {
    result = detector.detect(el.video, now);
  } catch (err) {
    console.error(err);
    return;
  }

  const { ratio, face, hands, mouth, tip } = result;
  const verdict = tracker.update(ratio, now);

  if (verdict.fire) announce();
  setAlarm(verdict.active || now < testUntil);

  render(ratio, verdict, { face, hands, mouth, tip });
}

function schedule() {
  const gen = loopGen;
  if (el.video.requestVideoFrameCallback) {
    el.video.requestVideoFrameCallback((now) => loop(now, gen));
  } else {
    rafId = requestAnimationFrame((now) => loop(now, gen));
  }
}

/* -------------------------------------------------------------------- render */

function render(ratio, verdict, marks) {
  el.fpsText.textContent = `${Math.round(smoothedFps)} fps`;

  const max = 0.8;
  const pct = ratio == null ? 0 : Math.max(0, Math.min(1, 1 - ratio / max)) * 100;
  el.gaugeFill.style.width = `${pct}%`;
  el.gaugeFill.dataset.hot = verdict.near ? "1" : "0";
  el.gaugeMark.style.left = `${Math.max(0, Math.min(1, 1 - settings.threshold / max)) * 100}%`;
  el.distText.textContent = ratio == null ? "거리 –" : `거리 ${ratio.toFixed(2)}`;

  let state = "lost";
  let text = "얼굴/손 미감지";
  if (verdict.active) {
    state = "alarm";
    text = "감지!";
  } else if (verdict.near) {
    state = "near";
    text = "가까움";
  } else if (ratio != null) {
    state = "ok";
    text = "감시 중";
  } else if (marks.face) {
    state = "ok";
    text = "감시 중 (손 없음)";
  }
  el.stateDot.dataset.state = state;
  el.stateText.textContent = text;

  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  if (!settings.debug) return;

  ctx.lineWidth = Math.max(2, el.overlay.width / 400);

  if (marks.mouth) {
    ctx.strokeStyle = "#34d399";
    ctx.beginPath();
    ctx.arc(marks.mouth.x, marks.mouth.y, ctx.lineWidth * 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(96,165,250,0.85)";
  for (const hand of marks.hands) {
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(hand[a].x * el.overlay.width, hand[a].y * el.overlay.height);
      ctx.lineTo(hand[b].x * el.overlay.width, hand[b].y * el.overlay.height);
      ctx.stroke();
    }
  }

  if (marks.tip && marks.mouth) {
    ctx.strokeStyle = verdict.near ? "#ef4444" : "rgba(232,238,245,0.55)";
    ctx.beginPath();
    ctx.moveTo(marks.tip.x, marks.tip.y);
    ctx.lineTo(marks.mouth.x, marks.mouth.y);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ lifecycle */

async function start() {
  el.start.disabled = true;
  const status = (msg, isError = false) => {
    el.bootStatus.textContent = msg;
    el.bootStatus.toggleAttribute("data-error", isError);
  };

  try {
    ensureAudio(); // must be created inside the click handler to be allowed to play
    initSpeech(); // likewise — iOS unlocks speech only from a user gesture
    status("카메라 권한 요청 중…");
    await openCamera();
    await listCameras();

    if (!detector) detector = await createDetector(status);

    status("");
    el.boot.hidden = true;
    el.hud.hidden = false;
    el.toggle.hidden = false;
    el.settingsBtn.hidden = false;
    el.veilBtn.hidden = false;
    setBlackout(settings.blackout);
    running = true;
    loopGen++;
    lastTick = performance.now();
    keepAwake();
    schedule();
  } catch (err) {
    console.error(err);
    el.start.disabled = false;
    status(explain(err), true);
  }
}

function explain(err) {
  const name = err?.name ?? "";
  if (name === "NotAllowedError") return "카메라 권한이 거부됐습니다. 브라우저 설정에서 허용해 주세요.";
  if (name === "NotFoundError") return "사용할 수 있는 카메라가 없습니다.";
  if (name === "NotReadableError") return "다른 앱이 카메라를 쓰고 있습니다.";
  if (!window.isSecureContext) return "HTTPS 또는 localhost에서만 카메라를 쓸 수 있습니다.";
  return `시작 실패: ${err?.message ?? err}`;
}

function setRunning(next) {
  running = next;
  loopGen++;
  el.toggle.textContent = next ? "일시정지" : "재개";
  if (next) {
    lastTick = performance.now();
    tracker.reset();
    keepAwake();
    schedule();
  } else {
    cancelAnimationFrame(rafId);
    testUntil = 0;
    setAlarm(false);
    wakeLock?.release?.();
    wakeLock = null;
    el.stateDot.dataset.state = "";
    el.stateText.textContent = "일시정지";
  }
}

/* ------------------------------------------------------------------- controls */

function bindRange(id, key, format, apply) {
  const input = $(id);
  const out = $(`${id}Out`);
  input.value = settings[key];
  out.textContent = format(settings[key]);
  input.addEventListener("input", () => {
    settings[key] = Number(input.value);
    out.textContent = format(settings[key]);
    apply(settings[key]);
    write(SETTINGS_KEY, settings);
  });
}

function bindCheck(id, key, onChange) {
  const input = $(id);
  input.checked = settings[key];
  input.addEventListener("change", async () => {
    settings[key] = input.checked;
    write(SETTINGS_KEY, settings);
    await onChange?.(input.checked, input);
  });
}

bindRange("threshold", "threshold", (v) => v.toFixed(2), (v) => (tracker.threshold = v));
bindRange("dwell", "dwell", (v) => (v ? `${(v / 1000).toFixed(1)}초` : "즉시"), (v) => (tracker.dwellMs = v));
bindRange("cooldown", "cooldown", (v) => `${(v / 1000).toFixed(0)}초`, (v) => (tracker.cooldownMs = v));

bindCheck("sound", "sound");
bindCheck("speech", "speech");
bindCheck("vibrate", "vibrate");
bindCheck("debug", "debug");
bindCheck("mirror", "mirror", (on) => document.body.classList.toggle("mirrored", on));
bindCheck("notify", "notify", async (on, input) => {
  if (!on) return;
  if (!("Notification" in window)) {
    input.checked = settings.notify = false;
    write(SETTINGS_KEY, settings);
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    input.checked = settings.notify = false;
    write(SETTINGS_KEY, settings);
  }
});

const alertStyleInput = $("alertStyle");
alertStyleInput.value = settings.alertStyle;
alertStyleInput.addEventListener("change", () => {
  settings.alertStyle = alertStyleInput.value;
  el.alarm.dataset.style = settings.alertStyle;
  write(SETTINGS_KEY, settings);
});

el.camera.addEventListener("change", async () => {
  settings.deviceId = el.camera.value;
  write(SETTINGS_KEY, settings);
  try {
    await openCamera();
  } catch (err) {
    console.error(err);
  }
});

function setBlackout(on) {
  settings.blackout = on;
  el.veil.hidden = !on;
  el.veilBtn.textContent = on ? "보기" : "가리기";
  el.veilBtn.setAttribute("aria-pressed", String(on));
  write(SETTINGS_KEY, settings);
}

el.veilBtn.addEventListener("click", () => setBlackout(!settings.blackout));
el.start.addEventListener("click", start);
el.toggle.addEventListener("click", () => setRunning(!running));
el.settingsBtn.addEventListener("click", () => {
  renderStats();
  el.settings.showModal();
});
el.testAlarm.addEventListener("click", () => {
  // Long enough to hear the repeat, which is the part worth rehearsing.
  testUntil = performance.now() + 4500;
  setAlarm(true);
  announce({ count: false }); // a rehearsal shouldn't land in today's tally
  setTimeout(() => {
    if (!tracker.active) setAlarm(false);
  }, 4600);
});
el.resetStats.addEventListener("click", () => {
  write(STATS_KEY, {});
  renderStats();
});

// Tapping silences the current episode but leaves the warning up — the whole
// point is that it stays until the hand comes away from the mouth.
el.alarm.addEventListener("click", () => {
  mutedEpisode = true;
  stopBeeping();
  stopSpeaking();
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, button")) return;
  if (e.key === " ") {
    e.preventDefault();
    if (!el.toggle.hidden) setRunning(!running);
  }
  if (e.key === "h" || e.key === "H") {
    if (!el.veilBtn.hidden) setBlackout(!settings.blackout);
  }
});

/* ---------------------------------------------------------------------- init */

document.body.classList.toggle("mirrored", settings.mirror);
el.alarm.dataset.style = settings.alertStyle;
renderStats();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

if (!navigator.mediaDevices?.getUserMedia) {
  el.bootStatus.textContent = "이 브라우저는 카메라를 지원하지 않습니다.";
  el.bootStatus.setAttribute("data-error", "");
  el.start.disabled = true;
} else if (!window.isSecureContext) {
  el.bootStatus.textContent = "HTTPS 또는 localhost에서 열어야 카메라를 쓸 수 있습니다.";
  el.bootStatus.setAttribute("data-error", "");
}
