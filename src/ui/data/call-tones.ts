/* A call's ringing sounds, made with WebAudio so there's no audio file to ship or license: the ring for an incoming call on the ringer channel (the phone's ring volume and silent mode apply), and the ringback while the other phone rings. */

export type ToneKind = 'ring' | 'ringback';

interface Pattern {
  /** Seconds per repeat. */
  period: number;
  /** Notes as [start in seconds, frequency in Hz, length in seconds, peak gain]. */
  notes: Array<[number, number, number, number]>;
  /** Chimes fade out; a ringback holds steady. */
  decay: boolean;
}

const PATTERNS: Record<ToneKind, Pattern> = {
  ring: {
    period: 3,
    notes: [
      [0, 659.25, 0.45, 0.35],
      [0.25, 880, 0.6, 0.35],
      [0.8, 659.25, 0.45, 0.35],
      [1.05, 880, 0.6, 0.35],
    ],
    decay: true,
  },
  ringback: {
    period: 6,
    notes: [
      [0, 440, 2, 0.06],
      [0, 480, 2, 0.06],
    ],
    decay: false,
  },
};

/** Vibration with each ring, in ms on and off. */
const RING_VIBRATION = [500, 300, 500];

export class CallTone {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private next = 0;
  private kind: ToneKind | null = null;
  private vibrate = false;

  get playing(): ToneKind | null {
    return this.kind;
  }

  start(kind: ToneKind, channel: string, vibrate = false): void {
    if (this.kind === kind) return;
    this.stop();
    this.kind = kind;
    this.vibrate = vibrate;
    try {
      this.ctx = new AudioContext({ audioChannel: channel } as AudioContextOptions);
    } catch {
      this.ctx = null;
    }
    const pattern = PATTERNS[kind];
    this.next = this.ctx ? this.ctx.currentTime + 0.05 : 0;
    this.cycle(pattern);
    this.timer = setInterval(() => this.cycle(pattern), pattern.period * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    if (this.vibrate && navigator.vibrate) navigator.vibrate(0);
    this.kind = null;
    this.vibrate = false;
  }

  private cycle(pattern: Pattern): void {
    if (this.vibrate && navigator.vibrate) navigator.vibrate(RING_VIBRATION);
    const ctx = this.ctx;
    if (!ctx) return;
    // A timer that fired late starts the next repeat now rather than in the past.
    const at = Math.max(this.next, ctx.currentTime + 0.05);
    for (const [start, freq, length, peak] of pattern.notes) this.note(ctx, at + start, freq, length, peak, pattern.decay);
    this.next = at + pattern.period;
  }

  private note(ctx: AudioContext, at: number, freq: number, length: number, peak: number, decay: boolean): void {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.01);
    if (decay) gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    else {
      gain.gain.setValueAtTime(peak, at + length - 0.02);
      gain.gain.linearRampToValueAtTime(0, at + length);
    }
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }
}
