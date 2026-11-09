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

## Règles du PvP

- **Combat rapide** : le serveur apparie deux joueurs qui ont le même mode et la même mise, avec des notes d'équipe proches. L'écart toléré grandit avec l'attente (4 points, puis +4 toutes les 4 s). Au bout de 90 s sans adversaire, la recherche s'arrête.
- **Salon privé** : un code à partager avec un ami.
- **Ordre des athlètes** : avant chaque combat, chaque joueur place ses 5 athlètes dans l'ordre des duels (40 s). L'ordre de l'adversaire reste secret jusqu'au résultat. Sans validation à temps, l'ordre actuel est envoyé.
- **Points** : chaque duel gagné rapporte l'écart entre les deux notes (sans plafond). L'écart du duel d'équipe compte double. Le plus de points gagne.
- **Fusion de cartes** : N exemplaires de la même carte donnent +1 de note (un seul exemplaire reste). N dépend de la rareté : Mythique 2, Légendaire 3, Ultra Rare 4, Rare 5, Peu commune 6, Commune 7. Niveau 5 maximum (+5). Les cartes Vintage ne fusionnent pas. Le serveur accepte jusqu'à 115 par carte (100 + 2 équipements + 5 niveaux).
- **Historique** : les 25 derniers combats sont gardés dans le navigateur, avec le détail des duels et un replay.

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
