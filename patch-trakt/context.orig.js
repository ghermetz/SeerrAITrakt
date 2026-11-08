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
