# MED2 · Semestre 1

Application web de révision du semestre 1 de MED2 : cours rédigés, QCM et QROC par chapitre, cartes mémoire, évaluation de fin de cours, entraînement au format de l’examen et plan de révision jusqu’aux épreuves.

- Adresse : https://djamenstj7-hash.github.io/med2ss1/
- S’installe sur l’écran d’accueil (iPhone : Safari › Partager › Sur l’écran d’accueil ; Android : Chrome › ⋮ › Installer l’application).
- Fonctionne hors ligne après la première ouverture.
- Aucun compte, aucun serveur : les résultats restent dans le navigateur de l’appareil (voir « Données »).

Version actuelle : **V0.30** (refonte de l’interface). Le détail de la version et ses limites sont dans `INSTALLATION_ET_LIMITES.txt`.

## Contenu du dépôt

| Fichier ou dossier | Rôle |
| --- | --- |
| `index.html` | L’application : interface, styles et code (≈ 370 Ko). Les cours n’y sont plus intégrés. |
| `service-worker.js` | Mode hors ligne et mises à jour. |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png` | Installation sur l’écran d’accueil. |
| `data/catalogue.json` | Matières et cours recensés. |
| `data/examens.json` | Calendrier des épreuves. |
| `data/modalites.json` | Modalités d’évaluation par matière. |
| `data/pedagogie.json` | Cours rédigés : chapitres, encadrés, QCM, QROC, cartes, évaluations. |
| `data/entrainements.json` | Banque d’entraînement au format de l’examen (QI et dossiers). |
| `Assets/*.svg` | Schémas des cours. |
| `Assets/fiches/` | Illustrations des fiches (chargées à la demande). |
| `Assets/photos/` | Photos de sémiologie (chargées à la demande). |
| `Assets/fonts/` | Police Atkinson Hyperlegible Next (licence SIL OFL, fichier `LICENCE-OFL.txt`). |

⚠️ Le dossier s’appelle `Assets` avec un **A majuscule** : GitHub Pages distingue les majuscules.

## Données de l’utilisateur

Tout est enregistré dans le navigateur (`localStorage`) de chaque appareil :

| Clé | Contenu |
| --- | --- |
| `med2.semestre1.etat.v1` | Progression : réponses, plan de révision, rappels, évaluations. Format inchangé en V0.30. |
| `med2.semestre1.lecture.v1` | Réglages de lecture (police, taille, interligne, thème du lecteur). |
| `med2.semestre1.reprise.v1` | Dernier cours ouvert et chapitre en cours. |
| `med2.semestre1.apparence.v1` | Apparence de l’application : automatique, claire ou sombre (nouveau en V0.30). |
| `med2.semestre1.catalogue.import.v1` | Catalogue importé à la main (facultatif). |

Sauvegarde : **Réglages › Mes données › Exporter** (fichier `.json`), puis **Importer** sur un autre appareil ou après une réinitialisation. Exporter avant chaque grosse mise à jour reste une bonne habitude.

## Mettre à jour le site

- **Cours, banque d’entraînement, calendrier** : remplacer le fichier concerné dans `data/`. Inutile de toucher à `index.html` : à chaque ouverture en ligne, l’application redemande ces fichiers en requête conditionnelle (s’ils n’ont pas changé, rien n’est retéléchargé).
- **Images** : ajouter le fichier dans `Assets/` (ou `Assets/photos/`, `Assets/fiches/`). Pour **remplacer** une image existante, le plus simple est de lui donner un **nouveau nom** ; si le nom reste le même, changer `VERSION` en tête de `service-worker.js`, sinon les appareils garderont l’ancienne copie hors ligne.
- **Interface** (`index.html`) : remplacer le fichier ; la nouvelle version est servie dès la réouverture suivante en ligne.
- Après une mise à jour : **Réglages › Installation et hors ligne** indique si tous les fichiers essentiels ont été mis en cache, et **Vérifier toutes les images des cours** signale les images absentes du dépôt.

GitHub Pages met en général une à deux minutes à publier un envoi (onglet **Actions** du dépôt).

## Fonctionnement hors ligne

- Page et données : réseau d’abord (avec un délai maximal, puis copie locale), en requêtes conditionnelles.
- Schémas, illustrations, photos et police : copie locale d’abord.
- Précache tolérant : un fichier manquant n’empêche plus l’installation du mode hors ligne ; il est signalé dans Réglages.
- Les photos de sémiologie (≈ 16 Mo) ne sont pas téléchargées d’avance : chacune reste disponible hors ligne une fois affichée.

## Sources

Le contenu pédagogique est rédigé uniquement à partir des ronéos, cours et annales des deux dossiers Google Drive de la promotion. Les PDF eux-mêmes ne sont pas publiés dans ce dépôt.
