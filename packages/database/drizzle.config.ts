import { defineConfig } from 'drizzle-kit';

// Used only by `drizzle-kit generate`, which diffs src/schema against the
// migration snapshots; it never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
});
