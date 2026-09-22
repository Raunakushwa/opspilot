// Root config lints repo-level JS/TS files; each workspace package has its own config.
import base from '@opspilot/config/eslint/node';

export default [
  ...base,
  {
    ignores: ['apps/**', 'packages/**'],
  },
];
