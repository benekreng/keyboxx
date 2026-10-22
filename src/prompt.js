// Terminal prompts. Everything goes to stderr so stdout stays clean.

import readline from 'node:readline';

export async function ask(question, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const label = def ? `${question} [${def}]: ` : `${question}: `;
  const answer = await new Promise((resolve) => rl.question(label, resolve));
  rl.close();
  return answer.trim() || def;
}

export async function confirm(question, def = true) {
  const a = (await ask(`${question} ${def ? '(Y/n)' : '(y/N)'}`)).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

// Read a secret without echoing it. Instead of the characters, a live preview
// from `preview(value)` is shown (e.g. "sk-***a3f2 (51 chars)") so you can check the paste.
export function askSecret(question, preview) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = '';
    const render = () => process.stderr.write(`\r\x1b[2K${question}${buf ? preview(buf) : ''}`);

    render();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    const finish = (err) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      render();
      process.stderr.write('\n');
      err ? reject(err) : resolve(buf);
    };

    const onData = (chunk) => {
      chunk = chunk.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, ''); // arrow keys, bracketed-paste markers
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') { buf = [...buf].slice(0, -1).join(''); continue; }
        if (ch < ' ') continue;
        buf += ch;
      }
      render();
    };
    stdin.on('data', onData);
  });
}
