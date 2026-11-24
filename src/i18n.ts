import { moment } from 'obsidian';

/** Interface language: French or English. "auto" follows Obsidian's own language. */
export type LangChoice = 'auto' | 'fr' | 'en';

let fr = false;

export function setLanguage(choice: LangChoice) {
  // Obsidian sets moment's locale to its interface language.
  fr = choice === 'fr' || (choice === 'auto' && (moment.locale() || 'en').toLowerCase().startsWith('fr'));
}

export const isFr = () => fr;

/** Picks the French or the English text. */
export const tr = (french: string, english: string) => (fr ? french : english);

/** "3 notes" / "1 note", with the words of the current language. */
export const plural = (n: number, one: string, many: string) => `${n} ${(fr ? n > 1 : n !== 1) ? many : one}`;

export const locale = () => (fr ? 'fr-FR' : 'en-US');
