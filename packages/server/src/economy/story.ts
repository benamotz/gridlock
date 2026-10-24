import { GAMEPLAY, type JobKind } from '@gridlock/shared';

/**
 * The story layer: three contacts who hand out the city's jobs, each with a
 * voice, a home town and a short arc per visit. It is deliberately thin - one
 * line when they call, one when the job ends - so it colours the jobs without
 * ever holding the player up, and the client can hide it entirely.
 *
 * Every name and line here is original to this game.
 */
export interface Contact {
  id: string;
  name: string;
  /** Index into the map's towns: booths there put you through to them. */
  town: number;
  /** The jobs they hand out, with relative weights. */
  kinds: [JobKind, number][];
  /** First call of a visit. */
  intro: string;
  brief: Partial<Record<JobKind, string[]>>;
  success: string[];
  fail: string[];
  /** The finale, offered once the player has done enough for them this visit. */
  finaleKind: JobKind;
  finaleBrief: string;
  finaleDone: string;
}

export const CONTACTS: Contact[] = [
  {
    id: 'vera',
    name: 'Vera Lowe',
    town: 0,
    kinds: [['hit', 3], ['bounty', 2], ['courier', 2], ['hideout', 1]],
    finaleKind: 'hideout',
    intro: "Name's Vera. I find people work. Don't make me regret finding you.",
    brief: {
      hit: ['Someone has been talking. Make them stop.', 'Quiet job. Loud ending. Your call how loud.'],
      bounty: ["There's a price on {target}. I'd like it collected.", 'The city wants {target} gone. So do I.'],
      courier: ["Package for {where}. Don't open it. Don't be late."],
      hideout: ["A crew's holed up where they shouldn't be. Evict them. Permanently."],
    },
    success: ["Clean. I'll remember that.", 'Good. Keep your phone on.'],
    fail: ["That's a mess I now have to tidy.", "I don't pay for almosts."],
    finaleBrief: "The crew that's been cutting into my business? I know where they sleep. End it, and we're square.",
    finaleDone: "We're square. And you've got my number.",
  },
  {
    id: 'otto',
    name: 'Otto Kessel',
    town: 1,
    kinds: [['boost', 3], ['armored', 2]],
    finaleKind: 'boost',
    intro: "Otto. I buy cars. I don't ask where from. You bring, I pay.",
    brief: {
      boost: ['I need a {car}. A nice one. My shop in {where}.', 'Buyer wants a {car}. Every scratch comes off your cut.'],
      armored: ["Cash van's leaving the depot. Heavy, slow, full - and the guards behind it shoot.",
        "Security van on the move, with a carload of muscle. Crack it open before it gets home."],
    },
    success: ["Now that's a delivery.", 'Ha! Beautiful.'],
    fail: ['The buyer walked. Thanks for nothing.', 'Wrong car, wrong day.'],
    finaleBrief: "Big order. Biggest I've had. Don't you dare dent it.",
    finaleDone: "You've got a gift. Come by the yard any time.",
  },
  {
    id: 'nell',
    name: 'Nell Price',
    town: 2,
    kinds: [['decoy', 3], ['courier', 2], ['bounty', 1]],
    finaleKind: 'decoy',
    intro: 'I used to wear the badge. Now I sell what it knows. Call me Nell.',
    brief: {
      decoy: ['A friend needs the police looking the other way. Be the other way.',
        "Make some noise, then disappear. I'll handle the rest."],
      courier: ['Envelope for {where}. Nobody stops you, nobody gets hurt.'],
      bounty: ['Old colleagues want {target} brought down. Off the books, well paid.'],
    },
    success: ["Smooth. You'd have made a terrible cop.", "Nicely done. I'll be in touch."],
    fail: ['Sloppy. Lie low for a bit.', 'That went sideways. It happens. Once.'],
    finaleBrief: "Last job, and it's personal. They're watching every road. Prove them wrong.",
    finaleDone: "Thank you. I mean it. Now forget my number - you won't, but try.",
  },
];

const pick = <T>(items: T[], rng: () => number): T => items[Math.floor(rng() * items.length)];

export function fill(line: string, vars: Record<string, string>): string {
  return line.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * How far along each player is with each contact, this visit only. Every
 * finished job counts; the next call after `trustForFinale` jobs is the finale.
 */
export class Story {
  private readonly trust = new Map<string, Map<string, number>>();

  /** Booths put you through to the local contact; a cellphone to anyone. */
  contactFor(town: number, rng: () => number): Contact {
    return CONTACTS.find((c) => c.town === town) ?? pick(CONTACTS, rng);
  }

  pickKind(c: Contact, rng: () => number, allowed: (k: JobKind) => boolean): JobKind | null {
    const options = c.kinds.filter(([k]) => allowed(k));
    const total = options.reduce((s, [, w]) => s + w, 0);
    let roll = rng() * total;
    for (const [k, w] of options) {
      roll -= w;
      if (roll <= 0) return k;
    }
    return options.length > 0 ? options[options.length - 1][0] : null;
  }

  level(playerId: string, c: Contact): number {
    return this.trust.get(playerId)?.get(c.id) ?? 0;
  }

  isFinale(playerId: string, c: Contact): boolean {
    return this.level(playerId, c) === GAMEPLAY.jobs.trustForFinale;
  }

  /** The line a contact opens a job with. */
  brief(playerId: string, c: Contact, kind: JobKind, vars: Record<string, string>, rng: () => number): string {
    if (this.isFinale(playerId, c)) return c.finaleBrief;
    if (this.level(playerId, c) === 0) return c.intro;
    const lines = c.brief[kind] ?? [c.intro];
    return fill(pick(lines, rng), vars);
  }

  /** Records a finished job and returns the contact's closing line. */
  close(playerId: string, c: Contact, ok: boolean, finale: boolean, rng: () => number): string {
    if (!ok) return pick(c.fail, rng);
    const levels = this.trust.get(playerId) ?? new Map<string, number>();
    this.trust.set(playerId, levels);
    levels.set(c.id, (levels.get(c.id) ?? 0) + 1);
    return finale ? c.finaleDone : pick(c.success, rng);
  }

  /** Forgets players who have left: nothing carries over between visits. */
  forget(keep: (playerId: string) => boolean): void {
    for (const id of [...this.trust.keys()]) if (!keep(id)) this.trust.delete(id);
  }
}
