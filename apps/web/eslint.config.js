import base from '@opspilot/config/eslint';
// eslint-config-next already exports flat config entries in v16.
import next from 'eslint-config-next/core-web-vitals';

// Next ships its own parser and applies it to every file, which would disable
// the type-aware rules from the shared base config (and break linting of this
// file). Its rules run fine on the typescript-eslint AST, so keep the rules and
// plugins and drop the language options.
const nextRules = next.map(({ languageOptions: _languageOptions, ...config }) => config);

const config = [...base, ...nextRules, { ignores: ['.next/**', 'next-env.d.ts'] }];

export default config;
