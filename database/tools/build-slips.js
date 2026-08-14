/**
 * Generate one printable credential slip per officer.
 *
 *   node database/tools/build-slips.js
 *
 * Reads:  participant-credentials.txt   (gitignored, written by seed.js)
 * Writes: participant-slips.html        (gitignored)
 *
 * ── Why individual slips ────────────────────────────────────────────────────
 * The roster table is the right artefact for the facilitator, who needs to see
 * everyone. It is the wrong artefact to hand round a room: anyone who glances
 * at it sees all 32 PINs, which defeats the point of having one. A PIN only
 * protects the baseline measurement if exactly one person knows it.
 *
 * Output is A4, four slips a page, with cut guides. Open it in a browser and
 * print.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'participant-credentials.txt');
const OUT = path.join(ROOT, 'participant-slips.html');

const ASSESSMENT_URL = process.env.ASSESSMENT_URL
    || 'https://ati-zmatf-assessment.onrender.com';

function fail(message, hint) {
    console.error(`\n  ${message}`);
    if (hint) console.error(`  ${hint}`);
    console.error('');
    process.exit(1);
}

/** Minimal escaping — officer names carry apostrophes and hyphens. */
function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function parse() {
    if (!fs.existsSync(SOURCE)) {
        fail('participant-credentials.txt not found.', 'Run: npm run seed');
    }

    const lines = fs.readFileSync(SOURCE, 'utf8').split(/\r?\n/);
    const issued = (lines.find((l) => l.startsWith('Issued:')) || '').replace('Issued:', '').trim();
    const database = (lines.find((l) => l.startsWith('Database:')) || '').replace('Database:', '').trim();

    // Column widths are fixed by seed.js writeCredentials().
    const officers = [];
    for (const line of lines) {
        const m = line.match(/^(\d{2})\s{3}(.{21})(\d{6})\s{4}(.{32})(.*)$/);
        if (!m) continue;
        officers.push({
            number: Number(m[1]),
            surname: m[2].trim(),
            pin: m[3],
            name: m[4].trim(),
            agency: m[5].trim(),
        });
    }

    if (officers.length === 0) {
        fail('No officer rows parsed from participant-credentials.txt.',
            'The file format may have changed — check seed.js writeCredentials().');
    }
    return { issued, database, officers };
}

function slip(o) {
    return `
  <section class="slip">
    <div class="crest">ATI</div>
    <div class="org">Africa Transformational Initiative</div>
    <h1>Pre-Training Diagnostic Assessment</h1>
    <p class="who"><strong>${esc(o.name)}</strong><br><span>${esc(o.agency)}</span></p>

    <table class="creds">
      <tr><th>Participant number</th><td class="mono big">${o.number}</td></tr>
      <tr><th>Surname</th><td class="mono">${esc(o.surname.toUpperCase())}</td></tr>
      <tr><th>Access PIN</th><td class="mono big pin">${o.pin}</td></tr>
    </table>

    <p class="url">${esc(ASSESSMENT_URL)}</p>
    <p class="note">
      You need all three details above to sign in. The assessment lasts
      <strong>10 minutes</strong> and may be taken <strong>once</strong>.
      This slip is personal to you — please do not share it.
    </p>
  </section>`;
}

function render({ issued, database, officers }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ATI ZMATF — participant slips</title>
<style>
  @page { size: A4; margin: 10mm; }
  :root {
    --ink:#12221A; --stone:#E9EDE7; --surface:#F7F9F5; --border:#C9D2C5;
    --muted:#4A584F; --accent:#AA4825; --accent-fill:#C85A32;
    --serif:'Source Serif 4',Charter,'Palatino Linotype',Georgia,serif;
    --sans:'Fira Sans','Segoe UI','Lucida Grande',sans-serif;
    --mono:'IBM Plex Mono','Cascadia Mono',Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:#8d8d8d;font-family:var(--sans);color:var(--ink);
       -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;min-height:297mm;margin:0 auto 6mm;padding:10mm;background:#fff;
         display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:63mm;gap:0}
  @media print{ body{background:none} .sheet{margin:0;page-break-after:always} .banner{display:none} }

  .banner{max-width:210mm;margin:0 auto;padding:8mm 10mm;color:#fff;font-size:10pt;line-height:1.5}
  .banner strong{color:#F0C68B}

  .slip{border:.4mm dashed var(--border);padding:6mm 7mm;display:flex;flex-direction:column;
        background:var(--surface)}
  .crest{width:9mm;height:9mm;border:.3mm solid var(--ink);display:flex;align-items:center;
         justify-content:center;font-family:var(--serif);font-size:8pt;letter-spacing:.04em}
  .org{font-size:6.5pt;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);
       font-weight:600;margin-top:2mm}
  h1{font-family:var(--serif);font-weight:600;font-size:11.5pt;line-height:1.2;margin:1mm 0 2mm}
  .who{font-size:8pt;line-height:1.35;margin:0 0 3mm;color:var(--muted)}
  .who strong{color:var(--ink);font-size:9pt}

  .creds{width:100%;border-collapse:collapse;margin-bottom:auto}
  .creds th{text-align:left;font-size:6.5pt;letter-spacing:.1em;text-transform:uppercase;
            color:var(--muted);font-weight:600;padding:1.6mm 3mm 1.6mm 0;width:34mm;
            border-bottom:.2mm solid var(--border)}
  .creds td{padding:1.6mm 0;border-bottom:.2mm solid var(--border)}
  .mono{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:.06em;font-size:10pt}
  .big{font-size:14pt;font-weight:600}
  .pin{color:var(--accent);letter-spacing:.18em}

  .url{font-family:var(--mono);font-size:7.5pt;color:var(--ink);margin:3mm 0 1.5mm;
       padding-top:2mm;border-top:.3mm solid var(--ink)}
  .note{font-size:6.5pt;line-height:1.45;color:var(--muted);margin:0}
</style>
</head>
<body>

<div class="banner" style="background:#12221A">
  <strong>CONFIDENTIAL — ${officers.length} slips.</strong>
  Cut along the dashed lines and hand each officer only their own.
  Issued ${esc(issued)} against <code>${esc(database)}</code>.
  These PINs work only against that database. Screen-only banner; it does not print.
</div>

${(() => {
        const pages = [];
        for (let i = 0; i < officers.length; i += 4) {
            pages.push(`<div class="sheet">${officers.slice(i, i + 4).map(slip).join('')}</div>`);
        }
        return pages.join('\n');
    })()}

</body>
</html>
`;
}

function main() {
    const data = parse();
    fs.writeFileSync(OUT, render(data), 'utf8');

    console.log(`\n  officers       ${data.officers.length}`);
    console.log(`  pages          ${Math.ceil(data.officers.length / 4)} (4 slips per A4 sheet)`);
    console.log(`  issued         ${data.issued}`);
    console.log(`  database       ${data.database}`);
    console.log(`  written        ${path.basename(OUT)}`);
    console.log('\n  Open it in a browser and print. CONFIDENTIAL — gitignored.\n');
}

main();
