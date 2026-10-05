import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const protocol = 'webgal-editor-preview-sync.v1', maxFrame = 16 * 1024 * 1024;
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.txt':'text/plain; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.woff2':'font/woff2','.ico':'image/x-icon' };
function frame(data, opcode = 1) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data), n = body.length;
  const header = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
  header[0] = 128 | opcode;
  if (n < 126) header[1] = n; else if (n < 65536) { header[1] = 126; header.writeUInt16BE(n, 2); } else { header[1] = 127; header.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([header, body]);
}
export function createHost({ dist, port = 8895, host = '127.0.0.1', instanceRoot = path.dirname(dist) }) {
  const root = path.resolve(dist), connections = new Set(); let latest = null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok:true, processId:process.pid, instanceRoot:path.resolve(instanceRoot), connections:connections.size })); }
      if (url.pathname === '/api/stage') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok:!!latest, stage:latest })); }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
      const file = path.resolve(root, relative), rel = path.relative(root, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
      const real = await fs.realpath(file), realRel = path.relative(root, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) { res.writeHead(403); return res.end(); }
      let data = await fs.readFile(real);
      if (relative === 'index.html') {
        // Plain compiler output stays free of client-side extensions.
        let runtime = false; try { await fs.access(path.join(root, 'game/release-runtime.js')); runtime = true; } catch {}
        if (runtime) data = Buffer.from(data.toString().replace(/<head(?:\s[^>]*)?>/i, head => head + '<script>try{localStorage.setItem("lang","0")}catch{}</script><script src="/game/release-runtime.js"></script>'));
      }
      res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500); res.end('File unavailable'); }
  });
  // A passive editor-preview endpoint. It acknowledges engine registration and observes
  // snapshots; production scenes run through the native start.txt, never preview injection.
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/webgalsync' || !String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).includes(protocol) || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
    connections.add(socket); let buffer = Buffer.alloc(0), fragments = [], fragmentSize = 0, fragmented = false;
    const message = data => {
      let e; try { e = JSON.parse(data.toString()); } catch { return; }
      if (e.kind === 'request') socket.write(frame(JSON.stringify({ kind:'response', type:e.type, requestId:e.requestId, payload:{} })));
      if (e.kind === 'event' && e.type === 'stage.snapshot.updated') latest = e.payload.stageState ?? e.payload;
    };
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxFrame + 14) { socket.destroy(); return; }
      while (buffer.length >= 2) {
        const fin = !!(buffer[0] & 128), opcode = buffer[0] & 15, masked = !!(buffer[1] & 128); let len = buffer[1] & 127, offset = 2;
        if ((buffer[0] & 112) || !masked) { socket.destroy(); return; }
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(maxFrame)) { socket.destroy(); return; } len = Number(big); offset = 10; }
        if (len > maxFrame || (opcode >= 8 && (!fin || len > 125))) { socket.destroy(); return; }
        if (buffer.length < offset + 4 + len) return;
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
        for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + len);
        if (opcode === 8) { socket.end(frame(payload, 8)); return; }
        if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
        if (opcode === 10) continue;
        if (opcode === 1) { if (fragmented) { socket.destroy(); return; } if (fin) { message(payload); continue; } fragmented = true; }
        else if (opcode !== 0 || !fragmented) { socket.destroy(); return; }
        fragments.push(payload); fragmentSize += len;
        if (fragmentSize > maxFrame) { socket.destroy(); return; }
        if (fin) { message(Buffer.concat(fragments)); fragments = []; fragmentSize = 0; fragmented = false; }
      }
    };
    socket.on('data', receive); socket.on('error', () => connections.delete(socket)); socket.on('close', () => connections.delete(socket)); if (head.length) receive(head);
  });
  return { server, start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }), close: () => new Promise(resolve => { for (const socket of connections) socket.destroy(); server.close(resolve); }) };
}
