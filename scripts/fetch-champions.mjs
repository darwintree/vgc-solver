import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const origin = 'https://championsbattledata.com';
async function get(path) {
  return JSON.parse(execFileSync('curl', ['-fsSL', '--max-time', '60', origin + path],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}));
}
const index = await get('/api');
const ranking = index.pokemon
  .filter(p => Number.isInteger(p.summary.battleSummary.Current?.Singles?.position))
  .sort((a, b) => a.summary.battleSummary.Current.Singles.position - b.summary.battleSummary.Current.Singles.position)
  .slice(0, 10);
const pokemon = [];
for (const entry of ranking) {
  const path = `/api/battle/Singles/${entry.showdownId}`;
  pokemon.push({id: entry.showdownId, species: entry.showdownName,
    rank: entry.summary.battleSummary.Current.Singles.position,
    url: origin + path, data: await get(path)});
}
const after = await get('/api');
if (after.dataVersion !== index.dataVersion) throw new Error('Source changed during download; retry');
await writeFile('fixtures/champions/singles-top10.json', JSON.stringify({
  retrievedAt: new Date().toISOString(), generatedAt: index.generatedAt,
  dataVersion: index.dataVersion, indexUrl: origin + '/api', pokemon,
}, null, 2) + '\n');
console.log(pokemon.map(p => `${p.rank}. ${p.species}`).join('\n'));
