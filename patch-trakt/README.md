# Patch Trakt — SeerrAITrakt

> **Fork de [corruptmods/SeerrAI](https://github.com/corruptmods/SeerrAI)** (lui-même fork de Jellyseerr)
> avec un **patch Trakt maison** pour le homelab **lelinuxien.fr** — recommandations IA alimentées
> par l'historique de visionnage Trakt + Jellyfin, le tout 100 % local.

Ce fork ne modifie **pas le code source** : il embarque un **patch au niveau du build distribué**
(dossier [`patch-trakt/`](.) ) appliqué par-dessus l'image officielle du fork amont.
Référence actuelle : **SeerrAI 2.4.2** (amont `ai-v2.4.2`, commit `2495460`).

---

## Système de base (production lelinuxien.fr)

| Élément | Détail |
|---|---|
| Base | SeerrAI 2.4.2 — `ghcr.io/corruptmods/seerr-ai:latest` |
| Image finale | `192.168.1.35:5555/seerr-ai-trakt:latest` (registre OCI local TLS) |
| Runtime | Podman **rootful**, socket `/run/podman/podman.sock`, compose `~/podman/seerr` |
| Reverse proxy | Zoraxy → `jellyseer.lelinuxien.fr` (port 5055) |
| IA | **100 % locale** : provider `openai` → `http://llama-gen:8080/v1` (llama.cpp), modèle `qwen3-4b` — config dans `settings.json`, aucune variable d'environnement |
| Orchestration | Stack **Komodo** `seerr` — auto-update sur le registre local |
| CI/CD | **Build Komodo** depuis ce dépôt git + procédure planifiée de synchro amont |

## Améliorations apportées (patch Trakt)

Deux fichiers du build distribué sont remplacés (`/app/dist/lib/ai/`) :

### 1. `context.js` — l'historique Trakt entre dans le contexte IA
- Injecte jusqu'à **20 titres** de l'historique Trakt public (`/users/<pseudo>/history`)
  dans `recentActivity`, au lieu des 8 titres d'amont
- Titres traduits via **TMDB** dans la langue de l'instance
- **Dédoublonnage** avec l'historique Jellyfin (pas de doublons Trakt/Jellyfin dans le contexte)

### 2. `features.js` — filtre « déjà vu »
- `watchedKeys` = Trakt `/watched/movies` + `/watched/shows` **complets** + Jellyfin
  (`titleId → Media.jellyfinMediaId`), mis en **cache 30 min**
- Les titres déjà vus sont retirés des **résultats de recherche IA** et des candidats
  **« Pick for the Room »** — sauf demande explicite de l'utilisateur (liste, demande)

## Fichiers

| Fichier | Rôle |
|---|---|
| `Containerfile` | `FROM ghcr.io/corruptmods/seerr-ai:latest` + **contrôle anti-dérive** (`cmp` des `.orig.js` contre l'amont, build en échec si dérive) + `COPY` des 2 fichiers patchés |
| `context.js` | patch IA : historique Trakt dans le contexte de goûts |
| `features.js` | patch filtre « déjà vu » |
| `context.orig.js` / `features.orig.js` | copies de référence des fichiers **amont** (détection de dérive, intégrée au build) |
| `rebuild.sh.example` | pipeline historique côté serveur (secours, si Komodo est indisponible) |

⚠️ Les patches s'appliquent sur le **JS compilé (dist)**, pas sur les sources TS : ils sont
liés à la version amont. Le `Containerfile` **échoue lui-même** si l'amont a changé
`context.js`/`features.js` — il faut alors réadapter le patch (voir « Réadapter le patch »).

### Prérequis
- Client ID Trakt (`settings.trakt.clientId`) et `traktUsername` renseignés par profil
- Le profil Trakt doit être **public**

---

## Pipeline de mise à jour (Komodo, depuis le git)

C'est le mode nominal : **le dépôt git est la source de vérité**.

1. **Procédure Komodo planifiée** (`seerr-sync-upstream`) :
   - Action `seerr-sync-fork` : sur le serveur, `git fetch upstream` du dépôt local
     `/home/ghermetz/SeerrAITrakt`, synchro de `main` avec `upstream/main` si nouvelle
     release, mise à jour des `.orig.js` **uniquement si les fichiers IA n'ont pas dérivé**,
     push vers `origin` (token GitHub en variable Komodo)
   - puis **Build Komodo** `seerr-ai-trakt` : clone ce dépôt, construit l'image
     (l'anti-dérive du Containerfile double la vérification de l'Action) et pousse sur le
     registre local
2. La stack `seerr` (auto-update sur le registre) **redéploie automatiquement**
   au nouveau digest.

**Réadapter le patch** quand l'anti-dérive échoue :
1. Extraire les nouveaux fichiers de l'image amont :
   `podman run --rm --entrypoint cat ghcr.io/corruptmods/seerr-ai:latest /app/dist/lib/ai/context.js > context.orig.js` (idem `features`)
2. Reporter les blocs `[patch trakt]` (diff `context.orig.js` ↔ `context.js` du commit
   précédent) sur les nouveaux fichiers, `node --check` pour valider
3. Commit + push → la procédure Komodo fait le reste

## Pipeline de secours (rebuild.sh côté serveur)

Si Komodo est indisponible, le pipeline historique marche toujours :

```bash
sudo ~/seerr-trakt-patch/rebuild.sh
```

1. `podman pull` de la dernière image amont `ghcr.io/corruptmods/seerr-ai:latest`
2. **Contrôle anti-dérive** : comparaison des fichiers extraits aux `.orig.js`
3. `podman build` → `localhost/seerr-ai-trakt:latest`
4. Push vers le registre OCI local `192.168.1.35:5555` (TLS, CA approuvée)
5. Recréation du conteneur (ou détection Komodo → déploiement auto)

## Limites connues

- Les patches portent sur le **JS compilé** : toute évolution de l'amont sur ces fichiers
  demande une réadaptation manuelle — détectée par le Containerfile **et** par l'Action de
  synchro, qui laissent le système en l'état au lieu de déployer un patch cassé
- La procédure Komodo ne fait pas de merge complexe : si l'amont diverge sérieusement
  (conflits au-delà des `.orig.js`), la synchro s'arrête et le merge se fait à la main
