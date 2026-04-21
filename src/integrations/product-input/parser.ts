import type { ParsedPi } from './db.js';

export function parsePIs(markdown: string, rfcName: string): ParsedPi[] {
  const pis: ParsedPi[] = [];
  const blocks = markdown.split(/^### PI-/m).slice(1);

  for (const block of blocks) {
    const idTitle = block.match(/^(\d+) — (.+)/);
    if (!idTitle) continue;

    const id = `PI-${idTitle[1].padStart(2, '0')}`;
    const title = idTitle[2].split('\n')[0].trim();

    const context = extract(block, 'Context');
    const question = extract(block, 'Question');
    const engRec = extract(block, 'Eng Recommendation');
    const blockingMatch = block.match(/\*\*Blocking:\*\*\s*(yes|no)/i);
    const blocking = (
      blockingMatch?.[1]?.toLowerCase() === 'yes' ? 'yes' : 'no'
    ) as 'yes' | 'no';

    if (!context || !question || !engRec) continue;

    pis.push({ id, title, context, question, engRec, blocking, rfcName });
  }

  return pis;
}

function extract(block: string, field: string): string | null {
  const re = new RegExp(
    `\\*\\*${field}:\\*\\*\\s*([\\s\\S]+?)(?=\\n\\*\\*|$)`,
    'i',
  );
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

export function shortRfcName(rfcName: string): string {
  const parts = rfcName.split('-');
  return parts.slice(3).join('-') || rfcName;
}

export function toSlackMrkdwn(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '_$1_')
    .replace(/^- /gm, '• ');
}

export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}
