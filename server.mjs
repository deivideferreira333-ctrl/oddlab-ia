// Servidor local: entrega o site (pasta docs/) e roda o ciclo da IA a cada 10 minutos.
// Uso: npm start  ->  http://localhost:8787
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCycle } from './engine/cycle.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const PORT = Number(process.env.PORT) || 8787;
const EVERY = 10 * 60 * 1000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('não encontrado'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`OddLab IA em http://localhost:${PORT}`));

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try { await runCycle(); } catch (e) { console.error('[ciclo] falhou:', e.message); }
  running = false;
}
if (!process.argv.includes('--no-cycle')) {
  loop();
  setInterval(loop, EVERY);
}
