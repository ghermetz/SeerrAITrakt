# Patch Trakt — fichiers et pipeline

Ce dossier contient tout le nécessaire pour reconstruire l'image patchée.

| Fichier | Rôle |
|---|---|
| `Containerfile` | `FROM ghcr.io/corruptmods/seerr-ai:latest` + `COPY` des 2 fichiers patchés dans `/app/dist/lib/ai/` |
| `context.js` | patch IA : historique Trakt dans le contexte de goûts |
| `features.js` | patch filtre « déjà vu » |
| `context.orig.js` / `features.orig.js` | copies de référence des fichiers **amont** (détection de dérive) |
| `rebuild.sh.example` | pipeline complet (à copier sur le serveur en `~/seerr-trakt-patch/rebuild.sh`) |

⚠️ Les patches s'appliquent sur le **JS compilé (dist)**, pas sur les sources TS : ils sont
donc liés au commit amont (ici `3b3cca9` = SeerrAI 1.1.0). Le script de rebuild compare
les fichiers extraits de la nouvelle image amont aux `.orig.js` et **s'arrête si l'amont a
changé** — il faut alors réadapter le patch (voir README racine).
