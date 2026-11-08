"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clip = exports.label = exports.withLibraryStatus = exports.resolveTitles = exports.ago = exports.recentWatching = exports.forgetRecentActivity = exports.recentActivity = void 0;
const themoviedb_1 = __importDefault(require("../../api/themoviedb"));
const media_1 = require("../../constants/media");
const datasource_1 = require("../../datasource");
const Media_1 = __importDefault(require("../../entity/Media"));
const MediaRequest_1 = require("../../entity/MediaRequest");
const imageproxy_1 = require("../../lib/imageproxy");
const settings_1 = require("../../lib/settings");
const watchHistory_1 = require("../../lib/watchHistory");
const logger_1 = __importDefault(require("../../logger"));
const Search_1 = require("../../models/Search");
const mapWithConcurrency_1 = require("../../utils/mapWithConcurrency");
const typeorm_1 = require("typeorm");
/*
 * What each feature tells the model about a user, and mapping the titles a
 * model names back to real ones.
 */
/** Short, so "what I just watched" stays current. */
const RECENT_MS = 5 * 60 * 1000;
/** By user and media server account, as suggestions are. */
const recent = new Map();
/** Longest title taken from watch history. */
const MAX_PLAYED_TITLE = 200;
/** Plays below this percent are someone sampling a title. */
const STARTED_PERCENT = 20;
/**
 * Recent watching, newest first, as "Title (year)" or "Title (series)", from
 * watch history (Tautulli for Plex, the server itself for Jellyfin and Emby),
 * including shows part-way through. Falls back to requests, marked so they
 * are never passed off as watched. Only names leave the server.
 */
/** [patch trakt] Tout ce que la personne a déjà vu, en clés "movie:<tmdb>" / "tv:<tmdb>". */
const SEEN_MS = 30 * 60 * 1000;
const seenCache = new Map();
const watchedKeys = async (user) => {
    const hit = seenCache.get(user.id);
    if (hit && Date.now() - hit.at < SEEN_MS) {
        return hit.value;
    }
    const keys = new Set();
    let traktCount = 0, jellyfinCount = 0;
    // 1. Trakt : tout l'historique "vu" (profil public).
    try {
        const clientId = (0, settings_1.getSettings)().trakt?.clientId;
        let username = user.settings?.traktUsername;
        if (username === undefined) {
            const { User } = require("../../entity/User");
            const full = await (0, datasource_1.getRepository)(User).findOne({ where: { id: user.id }, relations: { settings: true } });
            username = full?.settings?.traktUsername;
        }
        if (clientId && username) {
            const axios = require("axios");
            const headers = { 'trakt-api-version': '2', 'trakt-api-key': clientId, 'User-Agent': 'SeerrAI-trakt-patch' };
            for (const [path, kind, field] of [['movies', 'movie', 'movie'], ['shows', 'tv', 'show']]) {
                const res = await axios.get(`https://api.trakt.tv/users/${encodeURIComponent(username)}/watched/${path}`, { timeout: 20000, headers });
                for (const row of Array.isArray(res.data) ? res.data : []) {
                    const id = row[field]?.ids?.tmdb;
                    if (id) {
                        keys.add(`${kind}:${id}`);
                        traktCount++;
                    }
                }
            }
        }
    }
    catch (e) {
        logger_1.default.warn('Trakt watched list unavailable', { label: 'AI', userId: user.id, errorMessage: e instanceof Error ? e.message : String(e) });
    }
    // 2. Jellyfin : ce que le serveur a vu passer (film fini/entamé, série entamée), via la base Seerr.
    try {
        const source = (0, watchHistory_1.watchSource)();
        if (source?.viewerOf(user)) {
            const history = await source.history(user, 2000);
            const ids = [...new Set(history
                    .filter((play) => (0, watchHistory_1.isCompletedPlay)(play) || play.percent >= STARTED_PERCENT)
                    .map((play) => play.titleId)
                    .filter(Boolean))];
            if (ids.length) {
                const { In } = require("typeorm");
                const media = await (0, datasource_1.getRepository)(Media_1.default).find({ where: { jellyfinMediaId: In(ids) } });
                for (const m of media) {
                    keys.add(`${m.mediaType === media_1.MediaType.MOVIE ? 'movie' : 'tv'}:${m.tmdbId}`);
                    jellyfinCount++;
                }
            }
        }
    }
    catch (e) {
        logger_1.default.warn('Jellyfin watched list unavailable', { label: 'AI', userId: user.id, errorMessage: e instanceof Error ? e.message : String(e) });
    }
    logger_1.default.debug('Already-watched set built', { label: 'AI', userId: user.id, trakt: traktCount, jellyfin: jellyfinCount, total: keys.size });
    seenCache.set(user.id, { at: Date.now(), value: keys });
    return keys;
};
exports.watchedKeys = watchedKeys;
/** [patch trakt] Retire des résultats (mapMovieResult/mapTvResult ou TMDB brut) ce qui a déjà été vu. */
const dropWatched = (seen, results) => results.filter((r) => {
    const kind = (r.mediaType ?? r.media_type) === 'movie' ? 'movie' : 'tv';
    return !seen.has(`${kind}:${r.id}`);
});
exports.dropWatched = dropWatched;
/** [patch trakt] Historique Trakt public de l'utilisateur, fusionné par date. */
const TRAKT_MAX = 20;
const addTraktHistory = async (user, watched) => {
    try {
        const clientId = (0, settings_1.getSettings)().trakt?.clientId;
        if (!clientId) {
            return;
        }
        let username = user.settings?.traktUsername;
        if (username === undefined) {
            const { User } = require("../../entity/User");
            const full = await (0, datasource_1.getRepository)(User).findOne({ where: { id: user.id }, relations: { settings: true } });
            username = full?.settings?.traktUsername;
        }
        if (!username) {
            return;
        }
        const axios = require("axios");
        const res = await axios.get(`https://api.trakt.tv/users/${encodeURIComponent(username)}/history`, {
            params: { limit: 100 },
            timeout: 15000,
            headers: { 'trakt-api-version': '2', 'trakt-api-key': clientId, 'User-Agent': 'SeerrAI-trakt-patch' },
        });
        // Titres Trakt traduits via TMDB (langue de SeerrAI) pour coller aux noms Jellyfin.
        const locale = (0, settings_1.getSettings)().main?.locale || 'fr';
        const tmdb = new themoviedb_1.default();
        const entries = [];
        const keys = new Set();
        for (const h of Array.isArray(res.data) ? res.data : []) {
            const m = h.movie, s = h.show, item = m || s;
            const key = item && `${m ? 'm' : 's'}${item.ids?.tmdb ?? item.ids?.trakt}`;
            if (!item || keys.has(key)) {
                continue;
            }
            keys.add(key);
            entries.push({ h, m, s });
            if (entries.length >= TRAKT_MAX * 2) {
                break;
            }
        }
        const named = await (0, mapWithConcurrency_1.mapWithConcurrency)(entries, 4, async ({ h, m, s }) => {
            let title = (m || s).title;
            const id = (m || s).ids?.tmdb;
            if (id) {
                try {
                    title = m
                        ? (await tmdb.getMovie({ movieId: id, language: locale })).title || title
                        : (await tmdb.getTvShow({ tvId: id, language: locale })).name || title;
                }
                catch {
                    // garde le titre Trakt
                }
            }
            return { name: m ? `${title}${m.year ? ` (${m.year})` : ''}` : `${title} (series)`, at: h.watched_at };
        });
        const norm = (n) => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
        const known = new Set([...watched.keys()].map(norm));
        const merged = new Map(watched);
        let added = 0;
        for (const { name, at } of named) {
            if (known.has(norm(name))) {
                continue;
            }
            known.add(norm(name));
            merged.set(name, at ? Math.floor(new Date(at).getTime() / 1000) : undefined);
            if (++added >= TRAKT_MAX) {
                break;
            }
        }
        const time = (v) => (typeof v === 'number' ? v : 0);
        const sorted = [...merged].sort((a, b) => time(b[1]) - time(a[1]));
        watched.clear();
        for (const [k, v] of sorted) {
            watched.set(k, v);
        }
        logger_1.default.debug('Trakt history added to AI context', { label: 'AI', userId: user.id, added });
    }
    catch (e) {
        logger_1.default.warn('Trakt history unavailable for AI context', {
            label: 'AI',
            userId: user.id,
            errorMessage: e instanceof Error ? e.message : String(e),
        });
    }
};
const recentActivity = async (user) => {
    const source = (0, watchHistory_1.watchSource)();
    const viewer = source?.viewerOf(user);
    const key = `${user.id}:${viewer ?? ''}`;
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < RECENT_MS) {
        return hit.value;
    }
    const watched = new Map();
    if (source && viewer) {
        try {
            const history = await source.history(user, 300);
            for (const play of history) {
                if (!(0, watchHistory_1.isCompletedPlay)(play) && play.percent < STARTED_PERCENT) {
                    continue;
                }
                // Media server text, kept to one plain line.
                const title = (0, exports.clip)(play.title, MAX_PLAYED_TITLE);
                if (!title) {
                    continue;
                }
                const name = play.kind === 'movie'
                    ? `${title}${play.year ? ` (${play.year})` : ''}`
                    : `${title} (series)`;
                // History is newest first, so a title's first play is its latest.
                if (!watched.has(name)) {
                    watched.set(name, play.at);
                }
                if (watched.size >= 20) {
                    break;
                }
            }
        }
        catch (e) {
            logger_1.default.debug('No watch history for AI context', {
                label: 'AI',
                userId: user.id,
                errorMessage: e instanceof Error ? e.message : String(e),
            });
        }
    }
    // [patch trakt] Ajoute l'historique Trakt (profil public) à celui du serveur.
    await addTraktHistory(user, watched);
    let value;
    if (watched.size) {
        value = {
            source: 'watched',
            items: [...watched].map(([name, at]) => ({ name, at })),
        };
    }
    else {
        const requests = await (0, datasource_1.getRepository)(MediaRequest_1.MediaRequest).find({
            where: { requestedBy: { id: user.id }, type: (0, typeorm_1.In)(media_1.VIDEO_MEDIA_TYPES) },
            relations: { media: true },
            order: { createdAt: 'DESC' },
            take: 10,
        });
        const tmdb = new themoviedb_1.default();
        const found = await (0, mapWithConcurrency_1.mapWithConcurrency)(requests, 4, async (request) => {
            try {
                return request.media.mediaType === media_1.MediaType.MOVIE
                    ? (await tmdb.getMovie({ movieId: request.media.tmdbId })).title
                    : `${(await tmdb.getTvShow({ tvId: request.media.tmdbId })).name} (series)`;
            }
            catch {
                return undefined;
            }
        });
        const names = [...new Set(found.filter((name) => !!name))];
        value = {
            source: names.length ? 'requested' : 'none',
            items: names.map((name) => ({ name })),
        };
    }
    recent.set(key, { at: Date.now(), value });
    return value;
};
exports.recentActivity = recentActivity;
/** Clears the cache so the next answer refetches. */
const forgetRecentActivity = () => recent.clear();
exports.forgetRecentActivity = forgetRecentActivity;
/** Just the names, for features that only need someone's taste. */
const recentWatching = async (user, limit = 10) => (await (0, exports.recentActivity)(user)).items.slice(0, limit).map((item) => item.name);
exports.recentWatching = recentWatching;
/** "today", "yesterday", "3 days ago", "5 weeks ago", roughly. */
const ago = (at, now = Date.now()) => {
    const days = Math.floor((now / 1000 - at) / 86400);
    if (days < 1) {
        return 'today';
    }
    if (days < 2) {
        return 'yesterday';
    }
    if (days < 14) {
        return `${days} days ago`;
    }
    if (days < 60) {
        return `${Math.floor(days / 7)} weeks ago`;
    }
    return `${Math.floor(days / 30)} months ago`;
};
exports.ago = ago;
/** Posters prefetched: about what an answer shows before scrolling. */
const POSTERS_WARMED = 12;
/**
 * The TMDB entry for each title the model named, with this user's status,
 * in order and deduplicated. A title TMDB cannot find is dropped, not
 * guessed.
 */
const resolveTitles = async (user, named) => {
    const tmdb = new themoviedb_1.default();
    const found = await (0, mapWithConcurrency_1.mapWithConcurrency)(named, 4, async (title) => {
        const search = async (year) => title.k === 'movie'
            ? (await tmdb.searchMovies({ query: title.t, year })).results[0]
            : (await tmdb.searchTvShows({ query: title.t, year })).results[0];
        try {
            const year = title.y ?? undefined;
            const result = (await search(year)) ?? (year ? await search() : null);
            return result ? { kind: title.k, result } : null;
        }
        catch {
            return null;
        }
    });
    return (0, exports.withLibraryStatus)(user, found.filter((f) => !!f));
};
exports.resolveTitles = resolveTitles;
/**
 * TMDB titles as the app shows them, with library status and requests, in
 * order and deduplicated.
 */
const withLibraryStatus = async (user, found) => {
    const seen = new Set();
    const unique = found.filter((f) => !seen.has(`${f.kind}:${f.result.id}`) &&
        !!seen.add(`${f.kind}:${f.result.id}`));
    // Prefetch the first posters while the answer is assembled, not after the
    // browser draws the cards. Only when Seerr serves cached images.
    if ((0, settings_1.getSettings)().main.cacheImages) {
        (0, imageproxy_1.warmTmdbImages)(unique
            .slice(0, POSTERS_WARMED)
            .map((f) => f.result.poster_path)
            .filter((path) => !!path)
            .map((path) => `/t/p/w300_and_h450_face${path}`));
    }
    const media = await Media_1.default.getRelatedMedia(user, unique.map((f) => ({
        tmdbId: f.result.id,
        mediaType: f.kind === 'movie' ? media_1.MediaType.MOVIE : media_1.MediaType.TV,
    })), { includeActiveRequest: true });
    const related = (kind, id) => media.find((m) => m.tmdbId === id &&
        m.mediaType === (kind === 'movie' ? media_1.MediaType.MOVIE : media_1.MediaType.TV));
    return unique.map((f) => f.kind === 'movie'
        ? (0, Search_1.mapMovieResult)(f.result, related('movie', f.result.id))
        : (0, Search_1.mapTvResult)(f.result, related('tv', f.result.id)));
};
exports.withLibraryStatus = withLibraryStatus;
/** "Title (year)" for a TMDB result, for prompts. */
const label = (result) => {
    const name = result.title ?? result.name ?? '?';
    const year = (result.release_date ?? result.first_air_date ?? '').slice(0, 4);
    return year ? `${name} (${year})` : name;
};
exports.label = label;
/** Truncates to `max`, at a word boundary where possible. */
const clip = (text, max) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) {
        return clean;
    }
    const cut = clean.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
};
exports.clip = clip;
