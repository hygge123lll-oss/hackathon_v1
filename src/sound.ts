// 音效 —— 全部用 Web Audio 现场合成,零素材依赖。
class Sfx {
  muted = false;
  private ctx: AudioContext | null = null;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;

  /** 需要在用户手势里先调用一次以解锁 AudioContext */
  unlock() {
    this.ensure();
  }

  private ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(freq: number, dur: number, opts?: { type?: OscillatorType; gain?: number; delay?: number; slideTo?: number }) {
    if (this.muted) return;
    try {
      const ctx = this.ensure();
      const t0 = ctx.currentTime + (opts?.delay ?? 0);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = opts?.type ?? 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts?.slideTo) osc.frequency.linearRampToValueAtTime(opts.slideTo, t0 + dur);
      const peak = opts?.gain ?? 0.12;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch {
      /* 音频不可用时静默 */
    }
  }

  /** 化验单卡片弹出:清脆的"叮" */
  card() {
    this.tone(880, 0.12, { type: 'triangle', gain: 0.1 });
    this.tone(1320, 0.18, { type: 'triangle', gain: 0.08, delay: 0.07 });
  }

  /** 回合转场:低沉一声 */
  turn() {
    this.tone(150, 0.4, { type: 'sine', gain: 0.16, slideTo: 90 });
  }

  /** 专家来电 */
  expert() {
    this.tone(660, 0.1, { type: 'square', gain: 0.05 });
    this.tone(660, 0.1, { type: 'square', gain: 0.05, delay: 0.15 });
  }

  /** 危急报警:监护仪急促三连音,循环 */
  alarmOn() {
    if (this.alarmTimer) return;
    const beepTriple = () => {
      this.tone(960, 0.09, { type: 'square', gain: 0.06 });
      this.tone(960, 0.09, { type: 'square', gain: 0.06, delay: 0.16 });
      this.tone(960, 0.09, { type: 'square', gain: 0.06, delay: 0.32 });
    };
    beepTriple();
    this.alarmTimer = setInterval(beepTriple, 1100);
  }

  alarmOff() {
    if (this.alarmTimer) {
      clearInterval(this.alarmTimer);
      this.alarmTimer = null;
    }
  }

  /** 死亡:监护仪拉平的长直音 */
  flatline() {
    this.alarmOff();
    this.tone(830, 2.6, { type: 'sine', gain: 0.09 });
  }

  /** 治愈:上扬琶音 */
  cure() {
    this.alarmOff();
    this.tone(523, 0.22, { type: 'triangle', gain: 0.1 });
    this.tone(659, 0.22, { type: 'triangle', gain: 0.1, delay: 0.14 });
    this.tone(784, 0.36, { type: 'triangle', gain: 0.1, delay: 0.28 });
  }
}

export const sfx = new Sfx();
// 背景音乐:独立于语音/音效的开关,按病情阶段切换曲目。
type BgmMode = 'normal' | 'critical';

class Bgm {
  muted = false;
  private current: HTMLAudioElement | null = null;
  private mode: BgmMode | null = null;
  private readonly tracks: Record<BgmMode, string> = {
    normal: '/audio/daily-vlog.mp3',
    critical: '/audio/morning-steps.mp3',
  };

  unlock() {
    if (!this.current) return;
    void this.current.play().catch(() => undefined);
  }

  play(mode: BgmMode) {
    if (this.muted) {
      this.stop();
      return;
    }
    if (this.mode === mode && this.current && !this.current.paused) return;
    const previous = this.current;
    this.mode = mode;
    const audio = new Audio(this.tracks[mode]);
    audio.loop = true;
    audio.volume = mode === 'critical' ? 0.18 : 0.12;
    this.current = audio;
    void audio.play().catch(() => undefined);
    if (previous) {
      previous.pause();
      previous.src = '';
    }
  }

  stop() {
    if (this.current) {
      this.current.pause();
      this.current.src = '';
      this.current = null;
    }
    this.mode = null;
  }
}

export const bgm = new Bgm();

