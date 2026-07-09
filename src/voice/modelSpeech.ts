import type { GameState } from '../game/types';
import type { CaseCard } from '../game/types';

type PatientInfo = CaseCard['patient'];

export interface PatientSpeechContext {
  state?: Pick<GameState, 'hp' | 'hpMax' | 'phase' | 'vitals'>;
}

let audioQueue: Promise<void> = Promise.resolve();
let currentAudio: HTMLAudioElement | null = null;
let resolveCurrentAudio: (() => void) | null = null;


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

  audioQueue = audioQueue
    .catch(() => undefined)
    .then(async () => {
      const res = await fetch('/api/tts/patient-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, patient, context }),
      });
      if (!res.ok) throw new Error('TTS HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        currentAudio = new Audio(url);
        currentAudio.preload = 'auto';
        currentAudio.volume = 1;
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




