// A generic publication guard, not a replacement for secret scanning or review.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const entry of entries) {
  const [metadata, path] = entry.split('\t');
  const mode = metadata.split(' ')[0];
  if (mode === '120000' || mode === '160000') { findings.push(`${path}: symlink/submodule needs explicit publication review`); continue; }
  if (/(^|\/)(\.vercel|node_modules|work|reports|artifacts|coverage|test-results|playwright-report)(\/|$)/.test(path) ||
      /\.(secret(?:\..*)?|pem|key|log|sqlite\d*|db|wav|ogg|mp3|mp4)$/i.test(path) ||
      /(^|\/)(config\.encrypted|delivery-state|queue-diagnostic)\.json$/.test(path) ||
      (/(^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example')) {
    findings.push(`${path}: private/generated file must not be tracked`); continue;
  }
  const body = readFileSync(path, 'utf8');
  const checks = [
    ['local user path', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[A-Za-z0-9_.-]+/],
    ['deployment/account identifier', /\b(?:prj|team|dpl|store)_[A-Za-z0-9]{8,}\b/],
    ['hardcoded WhatsApp recipient link', /https:\/\/wa\.me\/\+?\d{7,}/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['literal credential', /(?:ADMIN_TOKEN|CONFIG_ENCRYPTION_KEY|CRON_SECRET|kapsoApiKey|kapsoWebhookSecret|vestaboardToken)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/],
  ];
  for (const [label, pattern] of checks) if (pattern.test(body)) findings.push(`${path}: ${label}`);
  for (const url of body.match(/https:\/\/[a-z0-9_-]+\.vercel\.app/gi) || []) {
    if (!/^https:\/\/your[_-]project\.vercel\.app$/i.test(url)) findings.push(`${path}: deployment URL must be an operator placeholder`);
  }
  if (path === '.env.example' && body.split('\n').some(line => /^[A-Z][A-Z0-9_]*\s*=\s*[^\s#]/.test(line))) findings.push(`${path}: examples must contain no values`);
}
if (!entries.length) findings.push('No tracked files to check. Stage the intended public source first.');
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log(`Publication guard passed for ${entries.length} tracked files. Also run a secret scanner and review Git history before publishing.`);
