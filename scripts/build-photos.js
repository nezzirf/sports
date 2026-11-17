// Prépare les photos des cartes, hébergées avec le jeu :
//   - photos/*.webp : la photo de chaque carte, réduite (300 px de large, WebP) ;
//   - photos-data.js : où trouver la photo de chaque carte (fichier local + adresse Wikimedia d'origine) ;
//   - credits.html : auteur et licence de chaque photo (les licences libres demandent de citer l'auteur).
// À relancer après avoir ajouté ou corrigé des athlètes :  npm run build:photos
// Seules les photos nouvelles ou changées sont téléchargées. Même choix de page que le jeu : française, sinon anglaise,
// sans page d'homonymie ni page sans image.
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const sharp = require('sharp');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'photos');
const UA = 'SportsTCG-photo-builder/1.0 (https://github.com/nezzirf/sports)';
const WIDTH = 300, QUALITY = 72, PARALLEL = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadCards() {
    const src = fs.readFileSync(path.join(ROOT, 'athletes-data.js'), 'utf8').replace(/\bconst\b/g, 'var');
    const ctx = {}; vm.createContext(ctx); vm.runInContext(src + ';this.raw = rawData; this.vin = vintageAthletes;', ctx);
    const cards = new Map();
    ctx.raw.forEach(d => { const s = d[4] || d[0].replace(/ /g, '_'); if (!cards.has(s)) cards.set(s, d[0]); });
    ctx.vin.forEach(v => { if (!cards.has(v.wikiSlug)) cards.set(v.wikiSlug, v.name); });
    return cards; // page Wikipédia -> nom de l'athlète
}

async function get(url, binary) {
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA } });
            if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
            if (res.status === 404) return null;
        } catch (e) { /* réseau : nouvel essai */ }
        await sleep(2000 * (attempt + 1));
    }
    throw new Error('Pas de réponse : ' + url);
}

const api = (lang, params) => get(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: 'json', ...params }));

// 1. Photo principale de chaque page (fr puis en)
async function findPhotos(slugs) {
    const found = {};
    let todo = slugs;
    for (const lang of ['fr', 'en']) {
        for (let i = 0; i < todo.length; i += 50) {
            const chunk = todo.slice(i, i + 50);
            const q = (await api(lang, { action: 'query', redirects: '1', prop: 'pageimages|pageprops', ppprop: 'disambiguation', piprop: 'thumbnail|name', pithumbsize: '330', pilimit: '50', titles: chunk.map(s => s.replace(/_/g, ' ')).join('|') })).query || {};
            const norm = Object.fromEntries((q.normalized || []).map(n => [n.from, n.to]));
            const red = Object.fromEntries((q.redirects || []).map(n => [n.from, n.to]));
            const pages = Object.fromEntries(Object.values(q.pages || {}).map(p => [p.title, p]));
            for (const s of chunk) {
                let t = s.replace(/_/g, ' '); t = norm[t] || t; t = red[t] || t;
                const p = pages[t];
                if (p && p.thumbnail && p.pageimage && !(p.pageprops && 'disambiguation' in p.pageprops))
                    found[s] = { lang, file: p.pageimage, thumb: p.thumbnail.source.replace(/\?.*$/, '') };
            }
            await sleep(600);
        }
        todo = todo.filter(s => !found[s]);
    }
    return { found, missing: todo };
}

// 2. Auteur et licence de chaque fichier
const clean = h => String(h || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
async function findCredits(found) {
    const byLang = {};
    Object.values(found).forEach(f => { (byLang[f.lang] = byLang[f.lang] || new Set()).add(f.file); });
    const credits = {};
    for (const [lang, set] of Object.entries(byLang)) {
        const files = [...set];
        for (let i = 0; i < files.length; i += 50) {
            const chunk = files.slice(i, i + 50);
            const q = (await api(lang, { action: 'query', prop: 'imageinfo', iiprop: 'extmetadata|url', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|Credit', titles: chunk.map(f => 'File:' + f.replace(/_/g, ' ')).join('|') })).query || {};
            const norm = Object.fromEntries((q.normalized || []).map(n => [n.from, n.to]));
            const pages = Object.fromEntries(Object.values(q.pages || {}).map(p => [p.title, p]));
            for (const f of chunk) {
                let t = 'File:' + f.replace(/_/g, ' '); t = norm[t] || t;
                const ii = pages[t] && pages[t].imageinfo && pages[t].imageinfo[0];
                const m = (ii && ii.extmetadata) || {};
                credits[lang + ':' + f] = {
                    author: clean(m.Artist && m.Artist.value) || clean(m.Credit && m.Credit.value) || 'Auteur non indiqué',
                    license: clean(m.LicenseShortName && m.LicenseShortName.value) || 'Licence non indiquée',
                    licenseUrl: (m.LicenseUrl && m.LicenseUrl.value) || '',
                    page: (ii && ii.descriptionurl) || `https://${lang}.wikipedia.org/wiki/File:${encodeURIComponent(f)}`
                };
            }
            await sleep(600);
        }
    }
    return credits;
}

// 3. Téléchargement et réduction (seulement les photos nouvelles ou changées)
const fileName = (slug, thumb) => slug.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 50)
    + '-' + crypto.createHash('sha1').update(thumb).digest('hex').slice(0, 8) + '.webp';
async function downloadAll(found) {
    fs.mkdirSync(OUT, { recursive: true });
    const jobs = Object.entries(found).map(([slug, f]) => ({ slug, f, name: fileName(slug, f.thumb) }));
    let done = 0, fetched = 0, failed = [];
    const work = async () => {
        while (jobs.length) {
            const j = jobs.shift(), dest = path.join(OUT, j.name);
            if (!fs.existsSync(dest)) {
                try {
                    const buf = await get(j.f.thumb, true);
                    if (!buf) throw new Error('introuvable');
                    await sharp(buf).rotate().resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: QUALITY }).toFile(dest);
                    fetched++; await sleep(150);
                } catch (e) { failed.push(j.slug); delete found[j.slug]; continue; }
            }
            found[j.slug].local = 'photos/' + j.name;
            if (++done % 100 === 0) console.log(`  ${done} photos prêtes…`);
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, work));
    // les photos qui ne servent plus sont supprimées
    const keep = new Set(Object.values(found).map(f => path.basename(f.local)));
    let removed = 0; for (const f of fs.readdirSync(OUT)) if (!keep.has(f)) { fs.unlinkSync(path.join(OUT, f)); removed++; }
    return { fetched, failed, removed };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function writeCredits(cards, found, credits) {
    const rows = [...cards].filter(([slug]) => found[slug]).sort((a, b) => a[1].localeCompare(b[1], 'fr')).map(([slug, name]) => {
        const f = found[slug], c = credits[f.lang + ':' + f.file] || {};
        const lic = c.licenseUrl ? `<a href="${esc(c.licenseUrl)}" rel="noopener">${esc(c.license)}</a>` : esc(c.license || '');
        return `<tr><td>${esc(name)}</td><td>${esc(c.author || '')}</td><td>${lic}</td><td><a href="${esc(c.page || '')}" rel="noopener">Fichier</a></td></tr>`;
    }).join('\n');
    fs.writeFileSync(path.join(ROOT, 'credits.html'), `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crédits photos · Sports TCG Elite</title>
<style>body{margin:0;background:#03050a;color:#e2e8f0;font:14px/1.5 system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:22px;margin:0 0 6px}p{color:#94a3b8;margin:0 0 16px}a{color:#22d3ee}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #1e293b;vertical-align:top}th{color:#fbbf24;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
td:nth-child(2){overflow-wrap:anywhere}@media(max-width:600px){td,th{padding:6px 4px;font-size:12px}}</style></head>
<body><main><p><a href="./">← Retour au jeu</a></p><h1>Crédits photos</h1>
<p>Les photos des cartes viennent de Wikipédia et Wikimedia Commons. Elles sont utilisées sous leur licence d'origine, réduites pour le jeu. Cliquer sur « Fichier » pour voir la photo d'origine et sa licence complète.</p>
<table><thead><tr><th>Athlète</th><th>Auteur</th><th>Licence</th><th>Source</th></tr></thead><tbody>
${rows}
</tbody></table></main></body></html>
`);
}

(async () => {
    const cards = loadCards(), slugs = [...cards.keys()];
    console.log(`${slugs.length} cartes : recherche des photos…`);
    const { found, missing } = await findPhotos(slugs);
    console.log(`Auteurs et licences de ${Object.keys(found).length} photos…`);
    const credits = await findCredits(found);
    console.log('Téléchargement des photos nouvelles ou changées…');
    const r = await downloadAll(found);
    const remote = {}, local = {};
    Object.keys(found).sort().forEach(s => { remote[s] = found[s].thumb; local[s] = found[s].local; });
    const js = o => JSON.stringify(o).replace(/","/g, '",\n"');
    fs.writeFileSync(path.join(ROOT, 'photos-data.js'), '/* Fichier généré par scripts/build-photos.js (npm run build:photos) : ne pas modifier à la main.\n'
        + '   PHOTO_LOCAL : photo hébergée avec le jeu (rapide). PHOTO_URLS : photo d\'origine sur Wikimedia (plus grande). */\n'
        + 'const PHOTO_LOCAL = ' + js(local) + ';\nconst PHOTO_URLS = ' + js(remote) + ';\n');
    writeCredits(cards, found, credits);
    const size = fs.readdirSync(OUT).reduce((t, f) => t + fs.statSync(path.join(OUT, f)).size, 0);
    console.log(`Terminé : ${Object.keys(local).length} photos (${(size / 1048576).toFixed(1)} Mo), ${r.fetched} téléchargées, ${r.removed} supprimées.`);
    if (missing.length) console.log('Sans photo sur Wikipédia :', missing.join(', '));
    if (r.failed.length) console.log('Échec du téléchargement (relancer le script) :', r.failed.join(', '));
})().catch(e => { console.error(e.message); process.exit(1); });
