// ESLint preset for Node services (api, worker) and Node-side packages.
import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

export default tseslint.config(...base, {
  languageOptions: {
    globals: globals.node,
  },
});
