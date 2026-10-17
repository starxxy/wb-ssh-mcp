// Throwaway checker for the two UI pages: inline-script syntax + tag balance.
import { readFileSync } from 'node:fs';

const files = ['ui.html', 'ui-gate.html'];
const tags = ['div', 'section', 'form', 'aside', 'main', 'button', 'span', 'select', 'pre', 'label', 'ul', 'li', 'p', 'h1', 'h2', 'h3', 'textarea'];
let bad = 0;

for (const file of files) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');

  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach((match, index) => {
    try {
      new Function(match[1]);
    } catch (error) {
      bad += 1;
      console.log(`FAIL ${file} inline script #${index}: ${error.message}`);
    }
  });
  console.log(`${file}: ${scripts.length} inline script(s), syntax ${scripts.length ? 'checked' : 'n/a'}`);

  for (const tag of tags) {
    const open = (src.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (src.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (open !== close) {
      bad += 1;
      console.log(`  FAIL <${tag}> open=${open} close=${close}`);
    }
  }

  // ids referenced by getElementById / $() must exist in the markup
  const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([
    ...[...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/data-for="([^"]+)"/g)].map((m) => m[1]),
  ]);
  const missing = [...refs].filter((id) => !ids.has(id));
  if (missing.length) {
    bad += 1;
    console.log(`  FAIL missing ids: ${missing.join(', ')}`);
  } else {
    console.log(`  ${ids.size} ids, ${refs.size} referenced — all resolved`);
  }
}

console.log(bad === 0 ? '\nALL CHECKS PASSED' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
