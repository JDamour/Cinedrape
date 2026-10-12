// Markdown for the readability audit (theme x mode matrix, one row per visit, worst offenders). Pure, synchronous.

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const modeLabel = (r) => (r.modeActual && r.modeActual !== r.mode ? `${r.mode} (got ${r.modeActual})` : r.mode || '-');
const cellText = (v) => String(v).replace(/\|/g, '/');
const offenderText = (o) => (o ? cellText(`${o.path} "${o.text}" ${o.fg} on ${o.bg} = ${o.ratio}:1${o.count > 1 ? ` (x${o.count})` : ''}`) : '-');

/** @returns {string[]} markdown lines ('' = blank), empty when no result carries an audit */
export function readabilitySections(results) {
  const rows = results.filter((r) => r.audit);
  if (!rows.length) return [];
  const L = ['', '## Readability audit', '',
    'Gate: more than 3% of the sampled elements below 3:1, or any title-like element below 4.5:1, fails the run. Sampling and exclusion rules: `test/e2e/lib/audit.mjs`.', '',
    '### Matrix (theme x mode, all pages)', '',
    '| Theme | Mode | Pages | Sampled | Below 3:1 | Below AA | Titles failing 4.5:1 | Worst offender |', '|---|---|---|---|---|---|---|---|'];
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.theme}\u0000${r.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) {
    const n = list.reduce((t, r) => t + r.audit.sampled, 0);
    const f3 = list.reduce((t, r) => t + r.audit.fail3, 0);
    const fa = list.reduce((t, r) => t + r.audit.failAA, 0);
    const tf = list.reduce((t, r) => t + r.audit.titles.fail45, 0);
    const tn = list.reduce((t, r) => t + r.audit.titles.count, 0);
    let worst = null;
    for (const r of list) {
      const o = r.audit.offenders[0];
      if (o && (!worst || o.ratio < worst.o.ratio)) worst = { o, page: r.page };
    }
    L.push(`| ${list[0].theme}${list[0].locked ? ' (locked)' : ''} | ${list[0].mode} | ${list.map((r) => r.page).join(', ')} | ${n} | ${f3} (${pct(f3, n)}%) | ${fa} (${pct(fa, n)}%) | ${tf}/${tn} | ${worst ? `${worst.page}: ${offenderText(worst.o)}` : '-'} |`);
  }
  L.push('', '### Per visit', '',
    '| Theme | Page | Mode | Sampled (text/icons) | Below 3:1 | Below AA | Masthead / guide / content below 3:1 | Titles failing/total | Surface = bg token (html, body, app, page-manager) | Skipped (hidden/media/bg-image) |',
    '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const a = r.audit;
    const surfaces = ['html', 'body', 'ytd-app', 'ytd-page-manager']
      .map((k) => (a.surfaces[k] ? (a.surfaces[k].equalsToken ? 'yes' : `NO ${a.surfaces[k].effective}`) : 'n/a')).join(', ');
    const regions = ['masthead', 'guide', 'content'].map((k) => `${a.byRegion[k].fail3}/${a.byRegion[k].n}`).join(' / ');
    L.push(`| ${r.theme} | ${r.page} | ${modeLabel(r)} | ${a.sampled} (${a.text.n}/${a.icons.n}) | ${a.fail3} (${a.pct3}%) | ${a.failAA} (${a.pctAA}%) | ${regions} | ${a.titles.fail45}/${a.titles.count} | ${surfaces} | ${a.skipped.hidden}/${a.skipped.media}/${a.skipped.bgImage} |`);
  }
  const bad = rows.filter((r) => r.audit.offenders.length);
  if (bad.length) {
    L.push('', '### Worst offenders (below their WCAG threshold; xN = identical repeats)', '');
    for (const r of bad) {
      L.push(`**${r.theme} / ${r.page} / ${r.mode}**`, '');
      for (const o of r.audit.offenders) {
        L.push(`- ${o.ratio}:1 (needs ${o.required}) [${o.region} ${o.kind}${o.title ? ', title' : ''}, ${o.size}] \`${cellText(o.path)}\` "${cellText(o.text)}" ${o.fg} on ${o.bg}${o.count > 1 ? ` x${o.count}` : ''}`);
      }
      L.push('');
    }
  }
  return L;
}
