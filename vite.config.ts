import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Google's MediaPipe runtime (used to compare pictures) is served from /mediapipe/, straight from node_modules.
const MP_DIR = 'node_modules/@mediapipe/tasks-vision/wasm/';
const MP_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
const mediapipe = (): Plugin => ({
  name: 'mediapipe-runtime',
  configureServer(server) {
    server.middlewares.use('/mediapipe/', (req, res, next) => {
      const f = (req.url ?? '').split('?')[0].replace(/^\//, '');
      if (!MP_FILES.includes(f)) return next();
      res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(readFileSync(MP_DIR + f));
    });
  },
  generateBundle() {
    for (const f of MP_FILES) this.emitFile({ type: 'asset', fileName: 'mediapipe/' + f, source: readFileSync(MP_DIR + f) });
  },
});

// The runtime for the CLIP AI (ONNX Runtime, as shipped with transformers.js) is served from /ort/ the same way,
// so it comes from this site and not from a third-party CDN.
const ORT_DIR = 'node_modules/@huggingface/transformers/dist/';
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const ortRuntime = (): Plugin => ({
  name: 'ort-runtime',
  configureServer(server) {
    server.middlewares.use('/ort/', (req, res, next) => {
      const f = (req.url ?? '').split('?')[0].replace(/^\//, '');
      if (!ORT_FILES.includes(f)) return next();
      res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(readFileSync(ORT_DIR + f));
    });
  },
  generateBundle() {
    for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: 'ort/' + f, source: readFileSync(ORT_DIR + f) });
  },
});

// Served at https://<user>.github.io/photo-organizer/ in production.
export default defineConfig(({ command }) => ({
  plugins: [react(), mediapipe(), ortRuntime()],
  worker: { format: 'es' },
  base: command === 'build' ? (process.env.BASE_PATH ?? '/photo-organizer/') : '/',
}));
