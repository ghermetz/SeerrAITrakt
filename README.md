# SeerrAITrakt

> **Fork de [corruptmods/SeerrAI](https://github.com/corruptmods/SeerrAI)** (lui-même fork de Jellyseerr)
> avec un **patch Trakt maison** pour le homelab **lelinuxien.fr** — recommandations IA alimentées
> par l'historique de visionnage Trakt + Jellyfin, le tout 100 % local.

Ce fork ne modifie **pas le code source** : il embarque un **patch au niveau du build distribué**
(dossier [`patch-trakt/`](patch-trakt/)) appliqué par-dessus l'image officielle du fork amont.
Le commit de référence est `3b3cca9` (**SeerrAI 1.1.0**) — c'est exactement la version qui tourne
en production.

---

## Système de base (production lelinuxien.fr)

| Élément | Détail |
|---|---|
| Base | SeerrAI 1.1.0 — `ghcr.io/corruptmods/seerr-ai:latest` |
| Image finale | `192.168.1.35:5555/seerr-ai-trakt:latest` (registre OCI local TLS) |
| Runtime | Podman **rootful**, socket `/run/podman/podman.sock`, compose `~/podman/seerr` |
| Reverse proxy | Zoraxy → `jellyseer.lelinuxien.fr` (port 5055) |
| IA | **100 % locale** : provider `openai` → `http://llama-gen:8080/v1` (llama.cpp), modèle `qwen3-4b` — config dans `settings.json`, aucune variable d'environnement |
| Orchestration | Stack **Komodo** `seerr` — poll des updates + auto-update activés |

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

### Prérequis
- Client ID Trakt (`settings.trakt.clientId`) et `traktUsername` renseignés par profil
  (utilisateur principal : `guytrom`)
- Le profil Trakt doit être **public**

## Pipeline de mise à jour

```bash
sudo ~/seerr-trakt-patch/rebuild.sh
```

1. `podman pull` de la dernière image amont `ghcr.io/corruptmods/seerr-ai:latest`
2. **Contrôle anti-dérive** : les `context.js`/`features.js` extraits de la nouvelle image
   sont comparés aux `.orig.js` — si l'amont les a modifiés, le script **s'arrête**
   (le patch doit être réadapté : `diff /tmp/<f>.upstream.js <f>.orig.js`)
3. `podman build` de l'image patchée → `localhost/seerr-ai-trakt:latest`
4. **Push vers le registre OCI local** `192.168.1.35:5555` (TLS, CA approuvée dans le
   magasin système + `/etc/containers/certs.d/192.168.1.35:5555/ca.crt`)
5. Recréation du conteneur

**Pourquoi un registre local ?** Komodo (l'orchestrateur) ne peut pas sonder les images
`localhost/*`. En publiant l'image sur un registre nommé, Komodo détecte le nouveau digest
(poll horaire) et **redéploie la stack automatiquement** — la mise à jour est donc :
`rebuild.sh` → détection Komodo → déploiement auto, sans intervention.

## Limites connues

- Les patches portent sur le **JS compilé** : toute évolution majeure de l'amont sur ces
  fichiers demande une réadaptation manuelle (le script de rebuild la détecte)
- Komodo ne peut pas déclencher `rebuild.sh` lui-même (image construite localement) :
  le pull amont reste manuel ou via cron
