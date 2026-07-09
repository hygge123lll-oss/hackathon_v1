// LLM 本地中继:OminiGate 只对 curl 的 HTTP/2 正常流式,对 Node 的 http/https/http2
// 客户端一律整段缓冲(实测)。所以传输层直接用 curl 子进程,逐块转发,保住打字机效果。
// 链路:浏览器 → Vite(/llm-proxy) → 本中继(:8788) → curl --http2 → 网关
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const TARGET = 'https://api.ominigate.ai';
const DEFAULT_PORT = 18788;
const HOST = process.env.LLM_RELAY_HOST || '127.0.0.1';
const PORT = Number.parseInt(
  process.env.LLM_RELAY_PORT || process.env.VITE_LLM_RELAY_PORT || String(DEFAULT_PORT),
  10,
);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid LLM relay port: ${process.env.LLM_RELAY_PORT || process.env.VITE_LLM_RELAY_PORT}`);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const args = [
      '-sN', '--http2', '--max-time', '300', '-i',
      '-X', req.method ?? 'POST',
      '-H', `content-type: ${req.headers['content-type'] ?? 'application/json'}`,
      '-H', `authorization: ${req.headers.authorization ?? ''}`,
      '--data-binary', '@-',
      TARGET + req.url,
    ];
    // stdbuf -o0:curl 输出到管道时默认块缓冲,强制无缓冲逐块转发
    // (注:该网关实测不做真流式——整段生成完一次性下发,前端已用本地打字机兜底)
    const curl = spawn('stdbuf', ['-o0', 'curl', ...args]);
    curl.stdin.end(body);

    // -i 让 curl 先吐上游的状态行+响应头,解析完再原样流转 body
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    const canWrite = () => !res.destroyed && !res.writableEnded;
    const sendJsonError = (status, message) => {
      if (!canWrite()) return;
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message } }));
    };
    curl.stdout.on('data', (chunk) => {
      if (!canWrite()) {
        curl.kill();
        return;
      }
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const head = headerBuf.subarray(0, sep).toString();
      const rest = headerBuf.subarray(sep + 4);
      const status = Number(head.match(/^HTTP\/[\d.]+ (\d+)/)?.[1] ?? 200);
      const ctype = head.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() ?? 'application/json';
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': ctype, 'cache-control': 'no-cache' });
      }
      if (rest.length) res.write(rest);
      headersDone = true;
    });
    curl.on('close', (code) => {
      if (!canWrite()) return;
      if (!headersDone && !res.headersSent) {
        sendJsonError(502, `relay: curl exit ${code}`);
        return;
      }
      res.end();
    });
    curl.on('error', (e) => {
      sendJsonError(502, `relay: ${e.message}`);
    });
    // 客户端中途断开时终止上游(res 'close' 在响应结束后也会触发,那时 curl 已退出,kill 是无害空操作)
    res.on('close', () => curl.kill());
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('[llm-relay] 已有实例在跑,本进程退出');
    process.exit(0);
  }
  if (e.code === 'EACCES') {
    console.error(`[llm-relay] 无法监听 ${HOST}:${PORT}。请换一个端口,例如在 .env 中设置 LLM_RELAY_PORT=18789`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, HOST, () => console.log(`[llm-relay] curl 传输中继就绪 ${HOST}:${PORT} → ${TARGET}`));
