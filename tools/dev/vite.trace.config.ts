// Wie "npm run quest", nur dass der Verlauf aus src/trace.ts im Terminal erscheint. So lässt sich am PC mitlesen, was im Headset geschieht:
//   npx vite --config tools/dev/vite.trace.config.ts --mode quest --host --port 5174 --strictPort
import { defineConfig, mergeConfig, type Plugin, type UserConfigFnObject } from 'vite';
import base from '../../vite.config.ts';

function traceLog(): Plugin {
  return {
    name: 'worlds-trace',
    configureServer(server) {
      server.middlewares.use('/__trace', (req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          console.log(`[Quest ${new Date().toLocaleTimeString('de-DE')}] ${body}`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig((env) => mergeConfig((base as UserConfigFnObject)(env), { define: { 'import.meta.env.VITE_TRACE': '"1"' }, plugins: [traceLog()] }));
