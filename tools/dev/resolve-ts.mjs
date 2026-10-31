// Node lädt TypeScript direkt, verlangt aber die Dateiendung im Import. Der Quellcode schreibt sie nicht, wie im Browser üblich.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
