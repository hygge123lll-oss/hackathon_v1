import type { GameState } from '../game/types';
import type { CaseCard } from '../game/types';

type PatientInfo = CaseCard['patient'];

export interface PatientSpeechContext {
  state?: Pick<GameState, 'hp' | 'hpMax' | 'phase' | 'vitals'>;
}

let audioQueue: Promise<void> = Promise.resolve();
let currentAudio: HTMLAudioElement | null = null;
let resolveCurrentAudio: (() => void) | null = null;
let speechVolume = 1;
// 取消代数:cancel 后,仍在请求中的旧句子返回时直接丢弃,不再开口
let generation = 0;

/** 主音量 0~1,对正在播放的语音即时生效 */
export function setModelSpeechVolume(v: number) {
  speechVolume = Math.min(1, Math.max(0, v));
  if (currentAudio) currentAudio.volume = speechVolume;
}


function cleanSpeechText(text: string) {
  return text
    .replace(/[（(][^）)]{0,48}[）)]/g, '')
    .replace(/\[[^\]]{0,48}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function modelSpeechEnabled() {
  return String(import.meta.env.VITE_PATIENT_VOICE || '').trim() === 'true';
}

export function waitForModelSpeechIdle() {
  return audioQueue.catch(() => undefined);
}

export function cancelModelSpeech() {
  generation++;
  resolveCurrentAudio?.();
  resolveCurrentAudio = null;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  audioQueue = Promise.resolve();
}

export function speakPatientSentence(text: string, patient: PatientInfo, context: PatientSpeechContext = {}) {
  const input = cleanSpeechText(text);
  if (!input || !modelSpeechEnabled()) return;

  const gen = generation;
  audioQueue = audioQueue
    .catch(() => undefined)
    .then(async () => {
      if (gen !== generation) return;
      const res = await fetch('/api/tts/patient-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, patient, context }),
      });
      if (!res.ok) throw new Error('TTS HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
      const blob = await res.blob();
      if (gen !== generation) return;
      const url = URL.createObjectURL(blob);
      try {
        currentAudio = new Audio(url);
        currentAudio.preload = 'auto';
        currentAudio.volume = speechVolume;
        await currentAudio.play();
        await new Promise<void>((resolve) => {
          resolveCurrentAudio = resolve;
          if (!currentAudio) return resolve();
          currentAudio.onended = () => {
            resolveCurrentAudio = null;
            resolve();
          };
          currentAudio.onerror = () => {
            resolveCurrentAudio = null;
            resolve();
          };
        });
      } finally {
        URL.revokeObjectURL(url);
        resolveCurrentAudio = null;
        currentAudio = null;
      }
    });
}




