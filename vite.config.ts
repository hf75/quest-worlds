import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Die Quest verlangt für WebXR HTTPS. Im Modus "quest" gibt es deshalb ein selbst signiertes Zertifikat.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'quest' ? [basicSsl()] : [],
  build: { target: 'es2022' },
}));
