// ---------------------------------------------------------------------------
// Shared "shouted alert" sound
//
// Used by both the admin new-order alert AND the customer-facing "orders
// closing soon" reminders, so they're guaranteed to sound identical rather
// than two copies that could drift apart over time.
//
// Two layers, both generated in-browser (no audio file, nothing to fetch):
//  1. A harsh siren tone (Web Audio API) — this is what makes it read as
//     "loud alarm" rather than just a voice. Browser/OS volume is the only
//     hard ceiling; there is no way for page code to exceed "1.0" gain, so
//     this maxes out every gain/volume value it controls and uses a harsh
//     sawtooth wave (perceived as louder/more piercing than a pure tone).
//  2. The shouted phrase itself (SpeechSynthesisUtterance), repeated ten
//     times, using a male voice where available.
// Browsers block all audio — tones and speech alike — from playing before
// the user has interacted with the page at least once. Callers are
// responsible for "priming" (see primeAlertAudio) on a click/tap first.
export const ALERT_REPEAT_COUNT = 10;

// Known male voice names across the browsers/OSes people are likely to run
// this on (Chrome/Edge on Windows, Chrome on Android, Safari on macOS/iOS).
// The Web Speech API has no standard "gender" field, so name-matching is
// the only real option — availability still depends entirely on what voices
// the device/browser ships with.
const MALE_VOICE_HINTS = [
  "male", "david", "mark", "daniel", "alex", "fred", "george",
  "james", "thomas", "oliver", "arthur", "guy", "ryan", "eric", "matthew",
];

function getPreferredMaleVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const englishVoices = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const pool = englishVoices.length ? englishVoices : voices;
  const male = pool.find((v) => {
    const n = v.name.toLowerCase();
    return !n.includes("female") && MALE_VOICE_HINTS.some((hint) => n.includes(hint));
  });
  return male ?? null;
}

/**
 * One harsh siren "whoop": two oscillators stacked together (a rising
 * sawtooth plus a lower square wave underneath), both at max gain. Layering
 * two waveforms adds more broadband energy/harmonics than a single tone at
 * the same peak level, which is what makes it read as noticeably louder and
 * harsher rather than just "the same volume with a different timbre."
 */
function playSirenWhoop(ctx: AudioContext, startTime: number): number {
  const duration = 0.28;

  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sawtooth";
  osc1.frequency.setValueAtTime(500, startTime);
  osc1.frequency.exponentialRampToValueAtTime(1400, startTime + duration);
  gain1.gain.setValueAtTime(0, startTime);
  gain1.gain.linearRampToValueAtTime(1, startTime + 0.02);
  gain1.gain.linearRampToValueAtTime(0, startTime + duration);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(startTime);
  osc1.stop(startTime + duration + 0.02);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "square";
  osc2.frequency.setValueAtTime(250, startTime);
  osc2.frequency.exponentialRampToValueAtTime(700, startTime + duration);
  gain2.gain.setValueAtTime(0, startTime);
  gain2.gain.linearRampToValueAtTime(0.9, startTime + 0.02);
  gain2.gain.linearRampToValueAtTime(0, startTime + duration);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(startTime);
  osc2.stop(startTime + duration + 0.02);

  return duration;
}

// Fills the given window with back-to-back siren whoops — used to keep the
// siren running continuously underneath the whole shouted sequence, instead
// of just a brief intro, so there's no quiet gap at any point in the alert.
function playSirenLayer(ctx: AudioContext, totalDuration: number) {
  let t = ctx.currentTime;
  const end = ctx.currentTime + totalDuration;
  while (t < end) {
    const dur = playSirenWhoop(ctx, t);
    t += dur + 0.05;
  }
}

/**
 * Creates (or resumes) a shared AudioContext and touches the speech API
 * once, so both are primed and ready by the time a real alert needs to
 * fire. Must be called from a user-gesture handler (click/tap) at least
 * once before shoutAlert will produce sound — this is a browser autoplay
 * restriction, not something page code can bypass.
 */
export function primeAlertAudio(audioCtxRef: { current: AudioContext | null }) {
  if (typeof window === "undefined") return;
  if (!audioCtxRef.current) {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (Ctx) audioCtxRef.current = new Ctx();
  }
  audioCtxRef.current?.resume().catch(() => {});
  if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
}

export function shoutAlert(phrase: string, audioCtx?: AudioContext | null) {
  if (typeof window === "undefined") return;

  // Layer 1: siren whoops running continuously for the whole alert, not
  // just an intro — the voice shouts on top of it the entire time, so
  // there's constant sound rather than louder-then-quieter gaps.
  if (audioCtx) {
    playSirenLayer(audioCtx, ALERT_REPEAT_COUNT * 0.85);
  }

  // Layer 2: the shouted phrase, repeated.
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // clear anything queued from a previous alert
  const maleVoice = getPreferredMaleVoice();
  for (let i = 0; i < ALERT_REPEAT_COUNT; i++) {
    const utter = new SpeechSynthesisUtterance(phrase);
    if (maleVoice) utter.voice = maleVoice;
    utter.pitch = 1.1; // slightly raised — closer to how a real shout sounds
    utter.rate = 1.2; // fast/urgent
    utter.volume = 1; // max volume — the hard ceiling of the API
    window.speechSynthesis.speak(utter);
  }
}
