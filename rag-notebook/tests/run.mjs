// Runs every *.test.mjs in this folder, each in its own process so the fake
// DOM and fake fetch globals in one suite cannot leak into another.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
const only = process.argv[2];

let totalPass = 0, totalFail = 0, failedSuites = [];

for (const suite of suites) {
  if (only && !suite.includes(only)) continue;
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [here + suite], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('close', (code) => resolve({ buf, code }));
  });

  const lines = out.buf.split('\n');
  const pass = lines.filter((l) => l.startsWith('PASS')).length;
  const fail = lines.filter((l) => l.startsWith('FAIL')).length;
  totalPass += pass;
  totalFail += fail;

  const label = suite.replace('.test.mjs', '');
  if (fail || out.code !== 0) {
    failedSuites.push(label);
    console.log(`\n✗ ${label}  (${pass} passed, ${fail} failed)`);
    for (const l of lines) if (l.startsWith('FAIL') || l.startsWith('--- ')) console.log('   ' + l);
    if (out.code !== 0 && !fail) console.log(out.buf.split('\n').slice(-25).join('\n'));
  } else {
    console.log(`✓ ${label.padEnd(10)} ${pass} passed`);
  }
}

console.log('\n' + '─'.repeat(46));
console.log(`${totalPass} passed, ${totalFail} failed` +
  (failedSuites.length ? `  — see ${failedSuites.join(', ')}` : ''));
console.log('Run a single suite:  npm test -- <name>');
process.exit(totalFail || failedSuites.length ? 1 : 0);
