import { spawn } from 'node:child_process'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'

type Phase = 'active' | 'critical' | 'recovering' | 'dead' | 'cured';

type PatientEmotion =
  | 'neutral'
  | 'pain'
  | 'fear'
  | 'nausea'
  | 'weak'
  | 'relieved'
  | 'confused'
  | 'impatient'
  | 'crying'
  | 'laugh'
  | 'angry';

interface PatientInfo {
  age: number;
  gender: string;
}

interface PatientSpeechContext {
  state?: {
    hp?: number;
    hpMax?: number;
    phase?: Phase;
    vitals?: { hr?: number; temp?: number; spo2?: number };
  };
  performance?: {
    emotion?: PatientEmotion;
    intensity?: number;
  };
}

interface VoiceShape {
  voiceId: string;
  speed: number;
  pitch: number;
  vol: number;
}

const DEFAULT_LLM_RELAY_HOST = '127.0.0.1';
const DEFAULT_LLM_RELAY_PORT = 18788;

function resolveLlmRelay(mode: string) {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.LLM_RELAY_HOST || env.VITE_LLM_RELAY_HOST || DEFAULT_LLM_RELAY_HOST;
  const rawPort = env.LLM_RELAY_PORT || env.VITE_LLM_RELAY_PORT || String(DEFAULT_LLM_RELAY_PORT);
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid LLM relay port: ${rawPort}`);
  }

  return { host, port };
}

function readJson(req: IncomingMessage) {
  return new Promise<any>((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 12000) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function patientBucket(patient: PatientInfo) {
  const isFemale = patient.gender?.includes('女');
  const age = Number(patient.age || 30);
  if (age < 14) return isFemale ? 'childFemale' : 'childMale';
  if (age >= 60) return isFemale ? 'elderlyFemale' : 'elderlyMale';
  return isFemale ? 'adultFemale' : 'adultMale';
}

function pickVoice(env: Record<string, string>, patient: PatientInfo) {
  const bucket = patientBucket(patient);
  const fallback = env.PPIO_TTS_VOICE || (bucket.includes('Female') ? 'female-shaonv' : 'male-qn-qingse');
  const voiceMap: Record<string, string | undefined> = {
    childFemale: env.PPIO_TTS_VOICE_CHILD_FEMALE || env.PPIO_TTS_VOICE_CHILD,
    childMale: env.PPIO_TTS_VOICE_CHILD_MALE || env.PPIO_TTS_VOICE_CHILD,
    adultFemale: env.PPIO_TTS_VOICE_ADULT_FEMALE,
    adultMale: env.PPIO_TTS_VOICE_ADULT_MALE,
    elderlyFemale: env.PPIO_TTS_VOICE_ELDERLY_FEMALE || env.PPIO_TTS_VOICE_ADULT_FEMALE,
    elderlyMale: env.PPIO_TTS_VOICE_ELDERLY_MALE || env.PPIO_TTS_VOICE_ADULT_MALE,
  };
  return voiceMap[bucket] || fallback;
}

function baseVoiceShape(env: Record<string, string>, patient: PatientInfo): VoiceShape {
  const bucket = patientBucket(patient);
  const base: Record<string, Omit<VoiceShape, 'voiceId'>> = {
    childFemale: { speed: 1.08, pitch: 4, vol: 1 },
    childMale: { speed: 1.06, pitch: 3, vol: 1 },
    adultFemale: { speed: 0.98, pitch: 1, vol: 1 },
    adultMale: { speed: 0.96, pitch: -1, vol: 1 },
    elderlyFemale: { speed: 0.82, pitch: -4, vol: 0.92 },
    elderlyMale: { speed: 0.78, pitch: -6, vol: 0.92 },
  };
  return { voiceId: pickVoice(env, patient), ...base[bucket] };
}

function textVoiceDelta(text: string) {
  const delta = { speed: 0, pitch: 0, vol: 0 };
  if (/疼|痛|难受|受不了|撑不住|救命/.test(text)) {
    delta.speed += 0.04;
    delta.pitch += 1.2;
    delta.vol += 0.04;
  }
  if (/喘|呼吸|憋|胸闷|上不来气/.test(text)) {
    delta.speed += 0.08;
    delta.pitch += 0.8;
    delta.vol -= 0.04;
  }
  if (/怕|害怕|担心|紧张|不会死/.test(text)) {
    delta.speed += 0.06;
    delta.pitch += 1.4;
  }
  if (/哭|想哭|呜|崩溃/.test(text)) {
    delta.speed -= 0.03;
    delta.pitch += 2;
    delta.vol -= 0.08;
  }
  if (/笑|哈哈|好多了|谢谢|舒服多了|不疼了|治好了/.test(text)) {
    delta.speed += 0.04;
    delta.pitch += 1;
    delta.vol += 0.02;
  }
  if (/烦|生气|别|不想|你到底|太慢/.test(text)) {
    delta.speed += 0.07;
    delta.pitch -= 0.5;
    delta.vol += 0.08;
  }
  return delta;
}

function performanceVoiceDelta(context: PatientSpeechContext) {
  const delta = { speed: 0, pitch: 0, vol: 0 };
  const intensity = clamp(Number(context.performance?.intensity ?? 0.45), 0, 1);
  switch (context.performance?.emotion) {
    case 'pain':
      delta.speed += 0.05 * intensity;
      delta.pitch += 1.8 * intensity;
      delta.vol += 0.04 * intensity;
      break;
    case 'fear':
      delta.speed += 0.08 * intensity;
      delta.pitch += 2.1 * intensity;
      break;
    case 'nausea':
      delta.speed -= 0.04 * intensity;
      delta.pitch -= 0.5 * intensity;
      delta.vol -= 0.04 * intensity;
      break;
    case 'weak':
      delta.speed -= 0.12 * intensity;
      delta.pitch -= 1.2 * intensity;
      delta.vol -= 0.16 * intensity;
      break;
    case 'relieved':
      delta.speed -= 0.03 * intensity;
      delta.pitch += 0.5 * intensity;
      delta.vol -= 0.02 * intensity;
      break;
    case 'crying':
      delta.speed -= 0.06 * intensity;
      delta.pitch += 2.4 * intensity;
      delta.vol -= 0.1 * intensity;
      break;
    case 'laugh':
      delta.speed += 0.05 * intensity;
      delta.pitch += 1.4 * intensity;
      delta.vol += 0.02 * intensity;
      break;
    case 'angry':
    case 'impatient':
      delta.speed += 0.08 * intensity;
      delta.pitch -= 0.6 * intensity;
      delta.vol += 0.08 * intensity;
      break;
    case 'confused':
      delta.speed -= 0.02 * intensity;
      delta.pitch += 0.8 * intensity;
      break;
  }
  return delta;
}

function stateVoiceDelta(context: PatientSpeechContext) {
  const delta = { speed: 0, pitch: 0, vol: 0 };
  const state = context.state;
  if (!state) return delta;

  const hp = Number(state.hp ?? 100);
  const hpMax = Number(state.hpMax ?? 100);
  const hpRatio = hpMax > 0 ? hp / hpMax : 1;
  if (hpRatio < 0.35) {
    delta.speed -= 0.11;
    delta.pitch -= 1.2;
    delta.vol -= 0.14;
  } else if (hpRatio < 0.6) {
    delta.speed -= 0.04;
    delta.pitch -= 0.4;
    delta.vol -= 0.06;
  }

  if (state.phase === 'critical') {
    delta.speed += 0.03;
    delta.pitch += 0.8;
    delta.vol -= 0.08;
  }
  if (state.phase === 'recovering' || state.phase === 'cured') {
    delta.speed -= 0.04;
    delta.pitch += 0.4;
    delta.vol += 0.02;
  }
  if ((state.vitals?.hr ?? 0) >= 120) delta.speed += 0.04;
  if ((state.vitals?.spo2 ?? 100) < 94) delta.speed += 0.05;
  return delta;
}

function resolveVoiceShape(env: Record<string, string>, patient: PatientInfo, context: PatientSpeechContext, text: string) {
  const shape = baseVoiceShape(env, patient);
  for (const delta of [textVoiceDelta(text), performanceVoiceDelta(context), stateVoiceDelta(context)]) {
    shape.speed += delta.speed;
    shape.pitch += delta.pitch;
    shape.vol += delta.vol;
  }
  shape.speed = clamp(Number(env.PPIO_TTS_SPEED || shape.speed), 0.72, 1.24);
  shape.pitch = Math.round(clamp(Number(env.PPIO_TTS_PITCH || shape.pitch), -8, 8));
  shape.vol = clamp(Number(env.PPIO_TTS_VOL || shape.vol), 0.68, 1.12);
  return shape;
}

function hexAudioFromResponse(data: any) {
  return data.audio || data.audio_hex || data.data?.audio || data.data?.audio_hex || data.result?.audio || data.result?.audio_hex;
}

function ttsProxyPlugin(): Plugin {
  let env: Record<string, string> = {};

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    try {
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      const patient = (body.patient || {}) as PatientInfo;
      const context = (body.context || {}) as PatientSpeechContext;
      if (!text) {
        res.statusCode = 400;
        res.end('Missing text');
        return;
      }

      const apiKey = env.PPIO_TTS_API_KEY || env.PPIO_API_KEY || env.VITE_LLM_API_KEY;
      const endpoint = env.PPIO_TTS_ENDPOINT || 'https://api.ppio.com/v3/minimax-speech-2.8-turbo';
      if (!apiKey) {
        res.statusCode = 500;
        res.end('Missing PPIO_TTS_API_KEY or PPIO_API_KEY');
        return;
      }

      const voice = resolveVoiceShape(env, patient, context, text);
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          stream: false,
          text,
          audio_setting: {
            format: env.PPIO_TTS_FORMAT || 'mp3',
            bitrate: Number(env.PPIO_TTS_BITRATE || 128000),
            channel: Number(env.PPIO_TTS_CHANNEL || 1),
            force_cbr: env.PPIO_TTS_FORCE_CBR === 'true',
            sample_rate: Number(env.PPIO_TTS_SAMPLE_RATE || 32000),
          },
          output_format: 'hex',
          voice_setting: {
            voice_id: voice.voiceId,
            vol: voice.vol,
            pitch: voice.pitch,
            speed: voice.speed,
            latex_read: false,
            text_normalization: false,
          },
          aigc_watermark: env.PPIO_TTS_WATERMARK === 'true',
          stream_options: {
            exclude_aggregated_audio: false,
          },
          subtitle_enable: false,
          continuous_sound: false,
        }),
      });

      if (!upstream.ok) {
        res.statusCode = upstream.status;
        res.end((await upstream.text()).slice(0, 500));
        return;
      }

      const contentType = upstream.headers.get('content-type') || '';
      let audio: Buffer;
      if (contentType.includes('audio/')) {
        audio = Buffer.from(await upstream.arrayBuffer());
      } else {
        const data = await upstream.json();
        const hex = hexAudioFromResponse(data);
        if (!hex || typeof hex !== 'string') {
          res.statusCode = 502;
          res.end('PPIO TTS response missing hex audio: ' + JSON.stringify(data).slice(0, 500));
          return;
        }
        audio = Buffer.from(hex, 'hex');
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.end(audio);
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    name: 'patient-tts-proxy',
    configResolved(config) {
      env = loadEnv(config.mode, process.cwd(), '');
    },
    configureServer(server) {
      server.middlewares.use('/api/tts/patient-speech', handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/tts/patient-speech', handle);
    },
  };
}

// 患者头像生图代理:浏览器 → /api/img/patient-portrait → PPIO seedream,密钥只在服务端
function imgProxyPlugin(): Plugin {
  let env: Record<string, string> = {};

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    try {
      const body = await readJson(req);
      const patient = (body.patient || {}) as PatientInfo & { personality?: string };
      const age = Number(patient.age || 30);
      const gender = String(patient.gender || '').includes('女') ? '女' : '男';
      const personality = String(patient.personality || '').slice(0, 40);

      const apiKey = env.PPIO_IMG_API_KEY || env.PPIO_TTS_API_KEY || env.PPIO_API_KEY || env.VITE_LLM_API_KEY;
      const endpoint = env.PPIO_IMG_ENDPOINT || 'https://api.ppio.com/v3/seedream-5.0-lite';
      if (!apiKey) {
        res.statusCode = 500;
        res.end('Missing PPIO_IMG_API_KEY or PPIO_TTS_API_KEY');
        return;
      }

      // 只描述外观与"身体不适",绝不把疾病诊断写进提示词,防止画面泄底
      const prompt = `儿童绘本卡通风格的半身人物头像:${age}岁${gender}性,性格特点:${personality || '普通人'}。因为身体不舒服来医院看病,表情略显不适但依然可爱。厚实的深棕色描边,扁平明快的色块,奶油色纯色背景,人物居中,不要文字,不要水印,不要写实风格`;

      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          prompt,
          size: env.PPIO_IMG_SIZE || '1920x1920', // 接口下限 368 万像素
          watermark: false,
        }),
      });
      if (!upstream.ok) {
        res.statusCode = upstream.status;
        res.end((await upstream.text()).slice(0, 500));
        return;
      }
      const data = (await upstream.json()) as { images?: string[] };
      const url = data.images?.[0];
      if (!url || typeof url !== 'string') {
        res.statusCode = 502;
        res.end('Image API response missing url: ' + JSON.stringify(data).slice(0, 300));
        return;
      }
      // 把签名 URL 的图在服务端取回转发,前端拿到的是稳定的字节流
      const img = await fetch(url);
      if (!img.ok) {
        res.statusCode = 502;
        res.end('Fetch generated image failed: ' + img.status);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', img.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(await img.arrayBuffer()));
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    name: 'patient-portrait-proxy',
    configResolved(config) {
      env = loadEnv(config.mode, process.cwd(), '');
    },
    configureServer(server) {
      server.middlewares.use('/api/img/patient-portrait', handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/img/patient-portrait', handle);
    },
  };
}

// 随 dev server 自动拉起 h2 中继(见 scripts/llm-relay.mjs;端口被占说明已有实例,会自动退出)
function llmRelay(options: { host: string; port: number }): Plugin {
  return {
    name: 'llm-relay',
    configureServer() {
      const child = spawn(process.execPath, ['scripts/llm-relay.mjs'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          LLM_RELAY_HOST: options.host,
          LLM_RELAY_PORT: String(options.port),
        },
      })
      process.on('exit', () => child.kill())
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const relay = resolveLlmRelay(mode);

  return {
    plugins: [react(), llmRelay(relay), ttsProxyPlugin(), imgProxyPlugin()],
    server: {
      // OminiGate 不允许浏览器跨域直连,且只在 HTTP/2 上流式;
      // 浏览器 → Vite(/llm-proxy) → 本地中继 → 网关
      proxy: {
        '/llm-proxy': {
          target: `http://${relay.host}:${relay.port}`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/llm-proxy/, ''),
        },
      },
    },
  };
})
