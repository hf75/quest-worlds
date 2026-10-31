// Wie "npm run dev", nur mit Filmuhr: Die Seite läuft dann nach einer Uhr, die film.js von Bild zu Bild weiterstellt, und ihre Bilder landen auf der Platte.
//   $env:FILM_DIR = '<Ordner>'; npx vite --config tools/dev/vite.film.config.ts --port 5173 --strictPort
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig, mergeConfig, type Plugin, type UserConfigFnObject } from 'vite';
import base from '../../vite.config.ts';

const OUT = process.env.FILM_DIR ?? 'previews/film';

function film(): Plugin {
  return {
    name: 'worlds-film',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace('<head>', '<head><script src="/tools/dev/film_clock.js"></script>');
      },
    },
    configureServer(server) {
      server.middlewares.use('/__film', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!/^[\w/.-]+$/.test(name) || name.includes('..')) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const path = join(OUT, name);
        mkdirSync(dirname(path), { recursive: true });
        const file = createWriteStream(path);
        req.pipe(file);
        file.on('finish', () => {
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig((env) => mergeConfig((base as UserConfigFnObject)(env), { plugins: [film()] }));
