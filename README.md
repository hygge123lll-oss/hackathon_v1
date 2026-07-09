# 诊断模拟器 v1 试玩版

一个面向试玩部署的 React + Vite 医疗诊断模拟游戏。当前版本包含普通接诊、鉴别接诊/伪装患者、患者语音、背景音乐、2D/3D 舞台切换等功能。

## 本地开发

```bash
npm install
npm run dev
```

本地默认地址通常是 `http://localhost:5173/`。

注意：完整线上 API 使用 Vercel `/api` Serverless Functions。本地只用 `npm run dev` 时，`/api/llm` 不会由 Vite 自动提供；如果要本地完整测试 LLM/TTS API，请使用 Vercel CLI：

```bash
npm install -g vercel
vercel dev
```

## 构建

```bash
npm run build
```

构建产物在 `dist/`。

## Vercel 部署

1. 将仓库导入 Vercel。
2. Framework 选择 `Vite`。
3. Build Command 使用：

```bash
npm run build
```

4. Output Directory 使用：

```bash
dist
```

5. 在 Vercel Project Settings -> Environment Variables 配置下面变量。

## 必需环境变量

前端变量：

```env
VITE_PATIENT_VOICE=true
VITE_LLM_BASE_URL=/api/llm
VITE_MODEL_PATIENT=deepseek/deepseek-v4-pro
VITE_MODEL_INTERPRETER=deepseek/deepseek-v4-pro
VITE_MODEL_EXPERT=deepseek/deepseek-v4-pro
VITE_MODEL_EVALUATOR=deepseek/deepseek-v4-pro
VITE_MODEL_CASE_GENERATOR=deepseek/deepseek-v4-pro
```

后端密钥变量，只放在 Vercel 环境变量里，不要提交真实 key：

```env
LLM_BASE_URL=https://api.ominigate.ai
LLM_API_KEY=你的LLM_KEY
PPIO_TTS_API_KEY=你的TTS_KEY
PPIO_TTS_WATERMARK=false
```

可选备用 LLM 通道：

```env
LLM_FALLBACK_BASE_URL=
LLM_FALLBACK_API_KEY=
```

## 线上接口

项目已内置 Vercel Serverless API：

- `/api/llm/v1/chat/completions`：代理 OpenAI-compatible LLM，请求密钥只在服务端读取。
- `/api/tts/patient-speech`：代理患者语音 TTS，请求密钥只在服务端读取。

因此部署后，玩家打开公网网址即可试玩完整版本，不需要在浏览器暴露真实 API key。

## 重要说明

- `.env` 已被 `.gitignore` 忽略，不会上传真实密钥。
- 背景音乐资源位于 `public/audio/`。
- 根目录如有原始音乐 mp3，仅用于本地备份，不是运行必需文件。

## 音乐署名

- 标题/菜单曲 `title-fluffing-a-duck.mp3`："Fluffing a Duck" — Kevin MacLeod (incompetech.com)，Licensed under Creative Commons: By Attribution 4.0（https://creativecommons.org/licenses/by/4.0/）。
