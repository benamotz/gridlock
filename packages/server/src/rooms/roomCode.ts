import { randomInt } from 'node:crypto';

/**
 * Room-code alphabet with I, O, 0, 1 removed so codes read aloud without
 * ambiguity. Codes are generated from a CSPRNG rather than Math.random, so
 * they cannot be predicted and private rooms cannot be enumerated.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 5;

export function generateRoomCode(taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    if (!taken(code)) return code;
  }
  throw new Error('Unable to allocate a unique room code');
}

export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, LENGTH);
}
