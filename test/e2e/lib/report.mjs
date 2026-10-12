// report.json (machine) and report.md (human) writers. Synchronous on purpose: they also run from signal/timeout handlers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readabilitySections } from './readability-report.mjs';

const cell = (v) => (v === null || v === undefined || v === '' ? '-' : String(v).replace(/\|/g, '/'));
const modeCell = (r) => (r.modeActual && r.modeActual !== r.mode ? `${r.mode} (got ${r.modeActual})` : r.mode || '-');
const num = (v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-');

export function summarise(results) {
  const failures = [];
  const warnings = [];
  for (const r of results) {
    if (r.error) failures.push({ theme: r.theme, page: r.page, mode: r.mode, check: 'visit', detail: r.error.message });
    for (const c of r.checks || []) {
      if (c.ok) continue;
      (c.level === 'warn' ? warnings : failures).push({ theme: r.theme, page: r.page, mode: r.mode, check: c.name, detail: c.detail });
    }
  }
  const failedVisits = new Set(failures.map((f) => `${f.theme}/${f.page}/${f.mode}`)).size;
  return { visits: results.length, visitsWithFailures: failedVisits, failures, warnings };
}

export function buildReport(meta, results, abort) {
  return { meta, abort: abort || null, summary: summarise(results), results };
}

export function toMarkdown(report) {
  const { meta, summary, results, abort } = report;
  const L = [];
  L.push('# Cinedrape e2e report', '');
  L.push(`- Extension: ${cell(meta.extension.name)} ${cell(meta.extension.version)} (${cell(meta.extension.path)})`);
  L.push(`- Chrome: ${cell(meta.chromeVersion)}, ${meta.headed ? 'headed (off-screen)' : 'headless new'}, viewport ${meta.viewport.width}x${meta.viewport.height}, licence: ${meta.pro ? 'dev Pro' : 'free'}`);
  L.push(`- Run: ${meta.startedAt}, ${num(meta.durationMs / 1000, 1)} s, ${summary.visits} page visits, ${summary.failures.length} failed checks, ${summary.warnings.length} warnings`);
  if (abort) L.push(`- **ABORTED (exit ${abort.exitCode}): ${abort.message}**`);
  L.push(...readabilitySections(results));
  L.push('', '## Per page', '');
  L.push('| Theme | Page | Mode | Result | cd-theme | Style B | Style ms (FP/FCP) | Status theme/page/pro | Switch ms | Heap MB (delta) | Ads vis/found | Console ext/page | Shots |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const failed = r.error || (r.checks || []).some((c) => !c.ok && c.level !== 'warn');
    const warned = (r.checks || []).some((c) => !c.ok && c.level === 'warn');
    const st = r.status && r.status.reply ? r.status.reply : null;
    const h = r.heap;
    L.push([
      r.theme + (r.locked ? ' (locked)' : ''), r.page, modeCell(r), failed ? 'FAIL' : warned ? 'warn' : 'ok',
      cell(r.attrs && r.attrs['cd-theme']), r.style ? r.style.bytes : '-',
      `${num(r.timings && r.timings.styleFilledAt, 0)} (${num(r.paint && r.paint.fp, 0)}/${num(r.paint && r.paint.fcp, 0)})`,
      st ? `${cell(st.themeId)}/${cell(st.pageType)}/${cell(st.pro)}` : cell(r.status && r.status.error),
      r.switch ? (r.switch.ok ? num(r.switch.ms) : 'FAILED') : '-',
      h ? `${num(h.beforeMB, 1)} -> ${num(h.afterMB, 1)} (${h.deltaMB >= 0 ? '+' : ''}${num(h.deltaMB, 1)})` : '-',
      r.ads ? `${r.ads.visible}/${r.ads.found}${r.ads.violationCount ? ` HIDDEN ${r.ads.violationCount}` : ''}` : '-',
      r.console ? `${r.console.extension.length}/${r.console.page.length}` : '-',
      (r.screenshots || []).join(', '),
    ].map(cell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  L.push('', '## Colours (computed)', '');
  L.push('| Theme | Page | Mode | html bg / text | ytd-app bg / text | Main title (text on effective bg, contrast) |');
  L.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const c = r.colors;
    if (!c) continue;
    const t = c.title;
    L.push(`| ${r.theme} | ${r.page} | ${r.mode || '-'} | ${cell(c.html && c.html.bg)} / ${cell(c.html && c.html.text)} | ${c.app ? `${c.app.bg} / ${c.app.text}` : '-'} | ${t ? `${t.text} on ${t.effectiveBg}, ${cell(t.contrast)}:1 ("${cell(t.sample)}")` : '-'} |`);
  }
  if (summary.failures.length || summary.warnings.length) {
    L.push('', '## Findings', '');
    for (const f of summary.failures) L.push(`- FAIL ${f.theme}/${f.page}/${f.mode} ${f.check}: ${cell(f.detail)}`);
    for (const f of summary.warnings) L.push(`- warn ${f.theme}/${f.page}/${f.mode} ${f.check}: ${cell(f.detail)}`);
  }
  const extra = [];
  for (const r of results) {
    for (const e of (r.console && r.console.extension) || []) extra.push(`- ${r.theme}/${r.page}/${r.mode} [${e.kind} x${e.count}] ${cell(e.text)}`);
  }
  if (meta.serviceWorkerErrors && meta.serviceWorkerErrors.length) for (const e of meta.serviceWorkerErrors) extra.push(`- service worker: ${cell(e)}`);
  if (extra.length) L.push('', '## Extension console output', '', ...extra);
  return L.join('\n') + '\n';
}

export function writeReports(outDir, report) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(outDir, 'report.md'), toMarkdown(report));
}
