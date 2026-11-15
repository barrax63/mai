/**
 * The shipped content config, with its seasons replaced by one that covers
 * today.
 *
 * Derived from the clock rather than written down, for the same reason as
 * setup-naps.js: `season()` reads the real date, and a fixed "12-01" would make
 * this file's tests pass in December and fail the rest of the year. Yesterday to
 * tomorrow, so a run that happens to cross midnight is still inside it. Written
 * to a throwaway file because the content config is read once, at import, from
 * whatever `MAI_CONFIG_PATH` names.
 *
 * Must be imported **before** `./setup.js`, which only sets `MAI_CONFIG_PATH`
 * when nothing has yet.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

/** "MM-DD", `offset` days from today, on the local calendar `season()` reads. */
const calendarDay = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}`;
};

export const TODAY_SEASON = Object.freeze({
  name: 'heute',
  from: calendarDay(-1),
  to: calendarDay(1),
  directive: 'TESTSAISON: heute ist ein besonderer Tag.',
  statuses: Object.freeze(['🧪 hat heute Saison', '🧫 feiert die Testsaison']),
  mood: Object.freeze(['*schnuppert am Reagenzglas* Testsaison! Bestens.']),
});

const shipped = parse(readFileSync(new URL('../config/mai.yaml', import.meta.url), 'utf8'));
shipped.seasons = [
  { ...TODAY_SEASON, statuses: [...TODAY_SEASON.statuses], mood: [...TODAY_SEASON.mood] },
];

const path = join(mkdtempSync(join(tmpdir(), 'mai-seasons-')), 'mai.yaml');
writeFileSync(path, stringify(shipped));
process.env.MAI_CONFIG_PATH = path;
