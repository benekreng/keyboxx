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

// Read a line without echoing it. Handles paste, backspace and Ctrl-C.
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let buf = '';

    const finish = (err) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      err ? reject(err) : resolve(buf);
    };

    const onData = (chunk) => {
      chunk = chunk.replace(/\x1b\[20[01]~/g, ''); // bracketed-paste markers
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') { buf = [...buf].slice(0, -1).join(''); continue; }
        if (ch < ' ') continue;
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
