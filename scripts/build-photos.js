// Prépare photos-data.js : l'adresse de la photo Wikipédia de chaque carte, pour que le jeu n'ait plus à interroger
// Wikipédia (une demande par carte, limitée en débit). À relancer après avoir ajouté ou corrigé des athlètes :
//   npm run build:photos
// Même choix que le jeu : page française, sinon anglaise ; on ignore les pages d'homonymie et les pages sans image.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const UA = 'SportsTCG-photo-builder/1.0 (https://github.com/nezzirf/sports)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadSlugs() {
    const src = fs.readFileSync(path.join(ROOT, 'athletes-data.js'), 'utf8').replace(/\bconst\b/g, 'var');
    const ctx = {}; vm.createContext(ctx); vm.runInContext(src + ';this.raw = rawData; this.vin = vintageAthletes;', ctx);
    const slugs = ctx.raw.map(d => d[4] || d[0].replace(/ /g, '_'));
    return [...new Set([...slugs, ...ctx.vin.map(v => v.wikiSlug)])];
}

async function query(lang, titles) {
    const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
        action: 'query', format: 'json', redirects: '1', prop: 'pageimages|pageprops', ppprop: 'disambiguation',
        piprop: 'thumbnail', pithumbsize: '330', pilimit: '50', titles: titles.join('|')
    });
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA } });
            if (res.ok) return await res.json();
            console.warn(`  ${lang} : réponse ${res.status}, nouvel essai…`);
        } catch (e) { console.warn(`  ${lang} : ${e.message}, nouvel essai…`); }
        await sleep(3000 * (attempt + 1));
    }
    throw new Error(`Wikipédia (${lang}) ne répond pas`);
}

(async () => {
    const slugs = loadSlugs(), photos = {};
    let todo = slugs;
    for (const lang of ['fr', 'en']) {
        for (let i = 0; i < todo.length; i += 50) {
            const chunk = todo.slice(i, i + 50), q = (await query(lang, chunk.map(s => s.replace(/_/g, ' ')))).query || {};
            const norm = Object.fromEntries((q.normalized || []).map(n => [n.from, n.to]));
            const red = Object.fromEntries((q.redirects || []).map(n => [n.from, n.to]));
            const pages = Object.fromEntries(Object.values(q.pages || {}).map(p => [p.title, p]));
            for (const s of chunk) {
                let t = s.replace(/_/g, ' '); t = norm[t] || t; t = red[t] || t;
                const p = pages[t];
                if (p && p.thumbnail && !(p.pageprops && 'disambiguation' in p.pageprops)) photos[s] = p.thumbnail.source.replace(/\?.*$/, '');
            }
            await sleep(800);
        }
        todo = todo.filter(s => !photos[s]);
    }
    const sorted = Object.fromEntries(Object.keys(photos).sort().map(k => [k, photos[k]]));
    const out = '/* Fichier généré par scripts/build-photos.js (npm run build:photos) : ne pas modifier à la main.\n'
        + '   Adresse de la photo Wikipédia de chaque carte. Une carte absente d\'ici n\'a pas de photo connue. */\n'
        + 'const PHOTO_URLS = ' + JSON.stringify(sorted, null, 0).replace(/","/g, '",\n"') + ';\n';
    fs.writeFileSync(path.join(ROOT, 'photos-data.js'), out);
    console.log(`photos-data.js : ${Object.keys(sorted).length} photos sur ${slugs.length} cartes.`);
    if (todo.length) console.log('Sans photo :', todo.join(', '));
})().catch(e => { console.error(e.message); process.exit(1); });
