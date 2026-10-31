// Wie "npm run dev", nur dass tools/dev/music_render.js seine Aufnahme nach previews/ schreiben darf:
//   npx vite --config tools/dev/vite.music.config.ts --port 5173 --strictPort
import { createWriteStream, mkdirSync } from 'node:fs';
import { defineConfig, mergeConfig, type Plugin, type UserConfigFnObject } from 'vite';
import base from '../../vite.config.ts';

function saveRecording(): Plugin {
  return {
    name: 'worlds-music',
    configureServer(server) {
      server.middlewares.use('/__musik', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!/^[\w-]+$/.test(name)) {
          res.statusCode = 400;
          res.end();
          return;
        }
        mkdirSync('previews', { recursive: true });
        const file = createWriteStream(`previews/${name}.wav`);
        req.pipe(file);
        file.on('finish', () => {
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig((env) => mergeConfig((base as UserConfigFnObject)(env), { plugins: [saveRecording()] }));
