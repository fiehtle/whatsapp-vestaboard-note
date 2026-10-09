import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('.env.local');
const values = {
  ADMIN_TOKEN: randomBytes(32).toString('hex'),
  CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CRON_SECRET: randomBytes(32).toString('hex'),
  KAPSO_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
};
try {
  await writeFile(output, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local with owner-only permissions. Keep it private; enter these values in your own Vercel project. Existing files are never overwritten.');
} catch (error) {
  if (error.code === 'EEXIST') console.error('.env.local already exists. Keeping your existing keys unchanged.');
  else console.error('Could not create the private environment file.');
  process.exitCode = 1;
}
