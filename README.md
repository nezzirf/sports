# Sports TCG Elite

Jeu de cartes à collectionner sur le sport : ouvre des boosters, compose une équipe de 5 athlètes et affronte tes amis en PvP.

Jouer : https://nezzirf.github.io/sports/

## Structure

| Fichier | Rôle |
| --- | --- |
| `index.html` | Le jeu (interface, logique, styles) |
| `athletes-data.js` | Athlètes, équipements, valeurs de recyclage |
| `tailwind.css` | CSS généré, ne pas modifier à la main |
| `sw.js`, `manifest.webmanifest` | Application installable et mode hors ligne |
| `server.js` | Serveur PvP (Express + Socket.IO) |
| `test/` | Tests du serveur PvP |

La collection est enregistrée dans le navigateur du joueur (`localStorage`).

## Développement

```bash
npm install
npm start
npm test
npm run build:css
```

Relance `npm run build:css` dès que tu utilises une nouvelle classe Tailwind dans `index.html`.

Dans `athletes-data.js`, ajoute les nouveaux athlètes à la fin de `rawData` : ne réordonne jamais les 749 premiers, les anciennes sauvegardes en dépendent.

## Déploiement

- Le site est publié par GitHub Pages depuis `main`.
- Le serveur PvP tourne sur Northflank. Son URL est dans `index.html` (appel `io(...)`).
- `GET /health` indique si le serveur répond.
