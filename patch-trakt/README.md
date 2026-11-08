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
| CI/CD | **Procédure Komodo planifiée** `seerr-sync-upstream` : synchro git amont → Build depuis ce dépôt → push registre → redéploiement si changement |

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

C'est le mode nominal : **le dépôt git est la source de vérité**. Procédure Komodo
`seerr-sync-upstream` (planifiée quotidiennement à 05:00, `failure_alert` activé) :

1. **Action `seerr-sync-fork`** (script TS Komodo, terminal serveur) :
   `git fetch upstream` sur `/home/ghermetz/SeerrAITrakt` (en `sudo -u ghermetz`),
   `merge-base --is-ancestor upstream/main main` → si l'amont a avancé :
   `git merge upstream/main --no-edit` + `git push origin main`
   (credentials : store git de `ghermetz`, `~/.git-credentials`, 600).
2. **Build Komodo `seerr-ai-trakt`** (builder `Local`) : clone ce dépôt GitHub,
   construit `patch-trakt/Containerfile` — l'**anti-dérive** (`cmp` des `.orig.js`
   contre le dist amont) fait **échouer le build** si upstream a modifié les fichiers IA —
   puis charge l'image en local (`--load`, tags `latest` + version + commit).
3. **Action `seerr-push-registry`** : `podman tag` + `podman push` vers
   `192.168.1.35:5555/seerr-ai-trakt:latest`. Le push passe par **podman** (CA du
   registre approuvée dans `/etc/containers/certs.d/192.168.1.35:5555/`) — le builder
   buildx ne peut pas pousser lui-même (conteneur buildkit sans cette CA, push TLS en
   échec `x509`).
4. **`DeployStackIfChanged`** sur la stack `seerr` : redéploie si le digest du registre
   diffère de ce qui tourne ; sinon le poll horaire Komodo (`auto_update`) s'en charge.

### Notes d'infrastructure (pour mémoire)
- Periphery (`periphery.service`) a besoin de `Environment=HOME=/root` : sans `$HOME`,
  le CLI docker ne lit pas `~/.docker/buildx` et construit avec un builder transient
  (c'est de toute façon le comportement observé : `docker build` = buildx → driver
  `docker-container` → conteneur `buildx_buildkit_default` obligatoire, le socket
  podman n'expose pas l'API buildkit).
- Le séquencement de la procédure est fiable : chaque stage attend la fin de son
  exécution (build ~3 s plein cache, push ~1 s blobs identiques).

**Réadapter le patch** quand l'anti-dérive échoue (build Komodo en échec + alerte) :
1. Extraire les nouveaux fichiers de l'image amont :
   `podman run --rm --entrypoint cat ghcr.io/corruptmods/seerr-ai:latest /app/dist/lib/ai/context.js > context.orig.js` (idem `features`)
2. Reporter les blocs `[patch trakt]` (diff `context.orig.js` ↔ `context.js` du commit
   précédent) sur les nouveaux fichiers, `node --check` pour valider
3. Commit + push → relancer la procédure `seerr-sync-upstream`

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
