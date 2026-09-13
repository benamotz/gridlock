import { GAMEPLAY } from '@gridlock/shared';

const RESERVED = ['admin', 'moderator', 'server', 'system', 'gridlock'];

const ADJECTIVES = [
  'Rusty', 'Neon', 'Silent', 'Crooked', 'Hollow', 'Brass', 'Static', 'Vagrant',
  'Iron', 'Pale', 'Restless', 'Grim', 'Feral', 'Split', 'Wired',
];
const NOUNS = [
  'Runner', 'Magpie', 'Wrench', 'Signal', 'Kestrel', 'Drifter', 'Ledger',
  'Ratchet', 'Hazard', 'Cinder', 'Lantern', 'Gasket', 'Verdict', 'Sparrow',
];

/** Control characters, zero-width joiners and bidi overrides used to spoof names. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g;

/**
 * Normalises a requested display name.
 *
 * Names are the only free text a client controls before joining, so they are
 * length-capped, stripped of invisible characters, and checked against
 * impersonation-prone reserved words.
 */
export function sanitizeName(raw: string): { name: string; changed: boolean } {
  let name = raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GAMEPLAY.net.maxNameLength);

  if (name.length < 2 || RESERVED.includes(name.toLowerCase())) {
    name = randomName();
  }
  return { name, changed: name !== raw };
}

export function randomName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}${n}`;
}

const CHAT_BLOCKED = /\b(fuck|shit|cunt|bitch|faggot)\b/gi;

/** Minimal profanity screen for match chat; a real filter replaces this later. */
export function filterChat(text: string): string {
  return text.replace(CHAT_BLOCKED, (m) => '*'.repeat(m.length)).slice(0, 160);
}
