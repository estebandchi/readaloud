// Edge TTS Cloudflare Worker - Free neural voice proxy
// Deploy at: https://workers.cloudflare.com
// 1. Sign up free (no credit card)
// 2. Create a Worker, paste this code, deploy
// 3. Copy your Worker URL into ReadAloud Settings

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (request.method === 'GET') {
      return new Response('Edge TTS proxy is running. POST {text, voice} to synthesize.', { headers: cors });
    }

    if (request.method !== 'POST') return new Response('POST required', { status: 405, headers: cors });

    try {
      const { text, voice } = await request.json();
      if (!text) return new Response('{"error":"Missing text"}', { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });

      const audio = await synthesize(text, voice || 'en-US-JennyNeural');
      return new Response(audio, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function synthesize(text, voice) {
  // Connect to Edge TTS via WebSocket
  const resp = await fetch(WS_URL, { headers: { Upgrade: 'websocket' } });
  const ws = resp.webSocket;
  if (!ws) throw new Error('WebSocket upgrade failed');
  ws.accept();

  const requestId = crypto.randomUUID().replace(/-/g, '');
  const audioChunks = [];

  // Send config
  ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);

  // Send SSML
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>${escapeXml(text)}</voice></speak>`;
  ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);

  // Collect audio
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 30000);

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          clearTimeout(timeout);
          ws.close();
          // Merge chunks
          const total = audioChunks.reduce((s, c) => s + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const chunk of audioChunks) { merged.set(new Uint8Array(chunk), off); off += chunk.byteLength; }
          resolve(merged.buffer);
        }
      } else {
        // Binary: 2-byte header length + header + audio data
        const buf = event.data;
        if (buf.byteLength > 2) {
          const headerLen = new DataView(buf).getUint16(0);
          const audioStart = 2 + headerLen;
          if (audioStart < buf.byteLength) {
            audioChunks.push(buf.slice(audioStart));
          }
        }
      }
    });

    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket error')); });
    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      if (audioChunks.length > 0) {
        const total = audioChunks.reduce((s, c) => s + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const chunk of audioChunks) { merged.set(new Uint8Array(chunk), off); off += chunk.byteLength; }
        resolve(merged.buffer);
      } else {
        reject(new Error('No audio received'));
      }
    });
  });
}
