# MED2 · Semestre 1

Application web de révision du semestre 1 de MED2 : cours rédigés, QCM et QROC par chapitre, cartes mémoire, évaluation de fin de cours, entraînement au format de l’examen et plan de révision jusqu’aux épreuves.

- Adresse : https://djamenstj7-hash.github.io/med2ss1/
- S’installe sur l’écran d’accueil (iPhone : Safari › Partager › Sur l’écran d’accueil ; Android : Chrome › ⋮ › Installer l’application).
- Fonctionne hors ligne après le téléchargement complet des cours et des images (vérifiable dans Réglages).
- Aucun compte, aucun serveur : les résultats restent dans le navigateur de l’appareil (voir « Données »).

Version actuelle : **V0.44** (8 cours de la semaine du 12/10 issus des prises de notes ; V0.43 : identité visuelle d’origine et nouvelle icône). Le détail de la version et ses limites sont dans `INSTALLATION_ET_LIMITES.txt`.

## Contenu du dépôt

| Fichier ou dossier | Rôle |
| --- | --- |
| `index.html` | L’application : interface, styles et code (≈ 370 Ko). Les cours n’y sont plus intégrés. |
| `service-worker.js` | Mode hors ligne, téléchargement des images et mises à jour. |
| `pdf-library.js` | Import, association et consultation des PDF locaux par cours (IndexedDB). |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Installation sur l’écran d’accueil (icône : un stéthoscope sur une blouse). |
| `data/catalogue.json` | Matières et cours recensés. |
| `data/examens.json` | Calendrier des épreuves. |
| `data/modalites.json` | Modalités d’évaluation par matière. |
| `data/pedagogie.json` | Cours rédigés : chapitres, encadrés, QCM, QROC, cartes, évaluations. |
| `data/entrainements.json` | Banque d’entraînement au format de l’examen (QI et dossiers). |
| `Assets/*.svg` | Schémas des cours. |
| `Assets/fiches/` | Illustrations des fiches (téléchargées pour le hors ligne). |
| `Assets/photos/` | Photos de sémiologie (téléchargées pour le hors ligne). |
| `Assets/fonts/` | Ancienne police, plus utilisée depuis la V0.43 (l’application reprend la police du système) ; dossier supprimable. |

⚠️ Le dossier s’appelle `Assets` avec un **A majuscule** : GitHub Pages distingue les majuscules.

## Données de l’utilisateur

La progression et les réglages sont enregistrés dans le navigateur (`localStorage`) de chaque appareil :

| Clé | Contenu |
| --- | --- |
| `med2.semestre1.etat.v1` | Progression : réponses, plan de révision, rappels, évaluations. Clé et format conservés. |
| `med2.semestre1.lecture.v1` | Réglages de lecture (police, taille, interligne, thème du lecteur). |
| `med2.semestre1.reprise.v1` | Dernier cours ouvert et chapitre en cours. |
| `med2.semestre1.apparence.v1` | Apparence de l’application : automatique, claire ou sombre (nouveau en V0.30). |
| `med2.semestre1.catalogue.import.v1` | Catalogue importé à la main (facultatif). |

Sauvegarde : **Réglages › Mes données › Exporter** (fichier `.json`), puis **Importer** sur un autre appareil ou après une réinitialisation. Exporter avant chaque grosse mise à jour reste une bonne habitude.

## PDF et séries de questions

- Dans un cours, **Mes PDF** (ou l’onglet **Source**) permet d’importer plusieurs PDF et de les joindre à ce cours. Ils sont enregistrés dans IndexedDB sur cet appareil, consultables et téléchargeables hors ligne. Aucun envoi à GitHub ou à un serveur.
- La sauvegarde JSON des résultats ne contient **pas les PDF** : conserver les originaux ou les télécharger pour changer d’appareil. Les PDF importés ne modifient pas les textes ou les questions du cours.
- Les évaluations de cours et l’entraînement d’examen proposent un choix du nombre de questions avant le démarrage. Les séries courtes indiquent leur couverture réelle des chapitres.
- **Cours suivant** ouvre le cours suivant de la même matière ; le sommaire permet toujours de choisir un chapitre.

## Mettre à jour le site

- **Cours, banque d’entraînement, calendrier** : remplacer le fichier concerné dans `data/`. Inutile de toucher à `index.html` : à chaque ouverture en ligne, l’application redemande ces fichiers en requête conditionnelle (s’ils n’ont pas changé, rien n’est retéléchargé).
- **Images** : ajouter le fichier dans `Assets/` (ou `Assets/photos/`, `Assets/fiches/`). Pour **remplacer** une image existante, le plus simple est de lui donner un **nouveau nom** ; si le nom reste le même, changer `VERSION` en tête de `service-worker.js`, sinon les appareils garderont l’ancienne copie hors ligne.
- **Interface** (`index.html`, `pdf-library.js`) : remplacer les fichiers ; la nouvelle version est servie dès la réouverture suivante en ligne.
- Après une mise à jour : **Réglages › Installation et hors ligne** indique si tous les fichiers essentiels ont été mis en cache, et permet de télécharger ou réessayer les fichiers manquants avant de couper la connexion.

GitHub Pages met en général une à deux minutes à publier un envoi (onglet **Actions** du dépôt).

## Fonctionnement hors ligne

- Page et données : réseau d’abord (avec un délai maximal, puis copie locale), en requêtes conditionnelles.
- Schémas, illustrations et photos : copie locale d’abord.
- Précache tolérant : un fichier manquant n’empêche plus l’installation du mode hors ligne ; il est signalé dans Réglages.
- Les images sont découvertes dans les données des cours et dans l’interface : photos, schémas et nouvelles fiches sont téléchargés à l’avance, même sans ouvrir chaque cours.
- Attendre la confirmation de téléchargement complet dans **Réglages › Installation et hors ligne** avant de couper la connexion. Le navigateur peut retirer le stockage du site en cas de manque de place ; demander sa protection dans Réglages.
- Les anciennes copies restent utilisables si une mise à jour ne peut pas être entièrement téléchargée.

## Sources

Le contenu pédagogique est rédigé uniquement à partir des ronéos, cours et annales des deux dossiers Google Drive de la promotion. Les PDF eux-mêmes ne sont pas publiés dans ce dépôt.

## Vérifications techniques

L’application n’a pas de compilation ni de dépendance en production. Les dépendances npm servent uniquement aux tests (Node.js 20 ou supérieur).

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Les tests navigateur lancent leur serveur local. `CHROMIUM_PATH` peut sélectionner un navigateur Chromium déjà installé. Les tests couvrent le cache hors ligne, les tailles de séries, les PDF par cours et les parcours principaux de l’interface.
