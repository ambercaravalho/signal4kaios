/* A call's microphone and speaker. The earpiece needs the telephony audio channel, which Beacon gets as a core app; Gecko keeps that channel's audio in its own graph, which can't take the microphone, so earpiece calls capture in a second context. The speaker uses the content channel (KaiOS lets only the phone app force telephony audio to the speaker), and there one context carries both, so Gecko's echo canceller hears what plays. */

import type { PlayReport } from './call-worklet';

export interface CallAudioEngine {
  callCapture(pcm: Float32Array): void;
  callPull(): Float32Array | null;
}

/** 16 kHz samples kept queued in the worklet, which plays on through main-thread stalls of up to that long. Starts at 150 ms, grows by 40 ms after each stall that ran it dry (the app's own start-up stalls for over 200 ms), and shrinks by 20 ms after 10 s without one, down to 100 ms. */
const PLAYBACK_START = 2400;
const PLAYBACK_MIN = 1600;
const PLAYBACK_MAX = 4800;
const PLAYBACK_GROW = 640;
const PLAYBACK_SHRINK = 320;
const PLAYBACK_CALM_MS = 10_000;
const WORKLET_URL = 'build/call-worklet.js';

type AudioChannelManager = { volumeControlChannel: string };

function audioChannelManager(): AudioChannelManager | null {
  const b2g = (navigator as unknown as { b2g?: { audioChannelManager?: AudioChannelManager } }).b2g;
  return (b2g && b2g.audioChannelManager) || null;
}

async function workletContext(channel: string): Promise<AudioContext> {
  const ctx = new AudioContext({ audioChannel: channel } as AudioContextOptions);
  await ctx.audioWorklet.addModule(WORKLET_URL);
  return ctx;
}

export class CallAudioIO {
  private contexts: AudioContext[] = [];
  private nodes: AudioWorkletNode[] = [];
  private player: AudioWorkletNode | null = null;
  private sent = 0;
  private starved = 0;
  private flowing = false;
  private target = PLAYBACK_START;
  private calmSince = 0;
  private stream: MediaStream | null = null;
  private speaker = false;
  private stopped = false;
  private generation = 0;
  private prevVolumeChannel: string | null = null;

  constructor(private readonly engine: CallAudioEngine) {}

  /** Opens the microphone and starts playing; rejects when the microphone is refused or audio can't start. */
  async start(speaker = false): Promise<void> {
    this.speaker = speaker;
    // Echo cancellation picks the voice input, where the phone's DSP cancels echo. Gecko's gain control is too slow for its audio thread on the T440W, which then falls about 4% behind the microphone and drops audio.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const acm = audioChannelManager();
    if (acm) this.prevVolumeChannel = acm.volumeControlChannel;
    await this.open();
  }

  get speakerOn(): boolean {
    return this.speaker;
  }

  /** Moves the call between the earpiece and the speaker by rebuilding the audio graph; the microphone stays open. */
  async setSpeaker(on: boolean): Promise<void> {
    if (this.stopped || on === this.speaker) return;
    this.speaker = on;
    if (this.stream) await this.open();
  }

  setMuted(muted: boolean): void {
    if (this.stream) this.stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.close();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setVolumeChannel(this.prevVolumeChannel);
  }

  private async open(): Promise<void> {
    this.close();
    const gen = ++this.generation;
    const live = () => !this.stopped && gen === this.generation && !!this.stream;
    const channel = this.speaker ? 'content' : 'telephony';
    try {
      if (this.speaker) {
        const ctx = await this.track(workletContext(channel), gen);
        if (!live()) return;
        const node = this.node(ctx, true, true);
        ctx.createMediaStreamSource(this.stream!).connect(node);
        node.connect(ctx.destination);
        this.player = node;
      } else {
        const [capCtx, playCtx] = await Promise.all([this.track(workletContext('normal'), gen), this.track(workletContext(channel), gen)]);
        if (!live()) return;
        const capture = this.node(capCtx, true, false);
        capCtx.createMediaStreamSource(this.stream!).connect(capture);
        const player = this.node(playCtx, false, true);
        player.connect(playCtx.destination);
        this.player = player;
      }
      await Promise.all(this.contexts.map((c) => (c.state === 'suspended' ? c.resume() : Promise.resolve())));
    } catch (err) {
      if (!live()) return;
      this.generation++;
      this.close();
      throw err;
    }
    if (live()) this.setVolumeChannel(channel);
  }

  /** Keeps a context for closing later, or closes it now when a newer graph or `stop` has replaced this one. */
  private async track(p: Promise<AudioContext>, gen: number): Promise<AudioContext> {
    const ctx = await p;
    if (this.stopped || gen !== this.generation) {
      ctx.close().catch(() => {});
      throw new Error('replaced');
    }
    this.contexts.push(ctx);
    return ctx;
  }

  private node(ctx: AudioContext, capture: boolean, play: boolean): AudioWorkletNode {
    const node = new AudioWorkletNode(ctx, 'call-io', { numberOfInputs: 1, numberOfOutputs: play ? 1 : 0, outputChannelCount: play ? [1] : [], processorOptions: { capture, play } });
    node.port.onmessage = (e: MessageEvent) => this.onMessage(node, e.data);
    if (play) node.port.postMessage({ prime: this.target });
    this.nodes.push(node);
    return node;
  }

  private close(): void {
    for (const node of this.nodes) {
      node.port.postMessage('stop');
      node.port.onmessage = null;
      node.disconnect();
    }
    for (const ctx of this.contexts) ctx.close().catch(() => {});
    this.nodes = [];
    this.contexts = [];
    this.player = null;
    this.sent = 0;
    this.starved = 0;
    this.flowing = false;
  }

  private onMessage(node: AudioWorkletNode, data: { pcm?: Float32Array } & Partial<PlayReport>): void {
    if (this.stopped || !data || this.nodes.indexOf(node) < 0) return;
    if (data.pcm instanceof Float32Array) this.engine.callCapture(data.pcm);
    if (node !== this.player || typeof data.played !== 'number') return;
    this.adapt(node, data.starved || 0);
    let queued = this.sent - data.played - (data.dropped || 0);
    while (queued < this.target) {
      const frame = this.engine.callPull();
      this.flowing = !!frame && frame.length > 0;
      if (!this.flowing) break;
      node.port.postMessage(frame);
      this.sent += frame!.length;
      queued += frame!.length;
    }
  }

  /** Grows the playback queue after a stall ran it dry while there was audio to play (not a pause in the peer's audio), and shrinks it after a calm spell. */
  private adapt(node: AudioWorkletNode, starved: number): void {
    const now = Date.now();
    const before = this.target;
    if (starved > this.starved && this.flowing) {
      this.target = Math.min(PLAYBACK_MAX, this.target + PLAYBACK_GROW);
      this.calmSince = now;
    } else if (!this.calmSince) {
      this.calmSince = now;
    } else if (now - this.calmSince > PLAYBACK_CALM_MS && this.target > PLAYBACK_MIN) {
      this.target = Math.max(PLAYBACK_MIN, this.target - PLAYBACK_SHRINK);
      this.calmSince = now;
    }
    this.starved = starved;
    if (this.target !== before) node.port.postMessage({ prime: this.target });
  }

  /** Points the volume keys at the call's channel, and back afterwards. */
  private setVolumeChannel(channel: string | null): void {
    const acm = audioChannelManager();
    if (!acm || channel === null) return;
    try {
      acm.volumeControlChannel = channel;
    } catch {
      // the volume keys keep their usual channel
    }
  }
}
