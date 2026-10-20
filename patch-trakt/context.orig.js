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
/*
 * The little each feature tells the model about a person, and turning the
 * titles a model names back into real ones.
 */
/** Short, so "what I just watched" is what they just watched. */
const RECENT_MS = 5 * 60 * 1000;
const recent = new Map();
/** Plays shorter than this are someone checking what a title is. */
const STARTED_PERCENT = 20;
/**
 * What someone has been watching lately, newest first, as "Title (year)" for
 * films and "Title (series)" for shows: from the server's watch history
 * (Tautulli for Plex, the server itself for Jellyfin and Emby), counting a show they
 * are part-way through. Failing that, what they requested, marked as such so
 * it is never passed off as watched. Names only: nothing else about them
 * leaves the server.
 */
const recentActivity = async (user) => {
    const hit = recent.get(user.id);
    if (hit && Date.now() - hit.at < RECENT_MS) {
        return hit.value;
    }
    const watched = new Map();
    const source = (0, watchHistory_1.watchSource)();
    if (source?.viewerOf(user)) {
        try {
            const history = await source.history(user, 300);
            for (const play of history) {
                if (!(0, watchHistory_1.isCompletedPlay)(play) && play.percent < STARTED_PERCENT) {
                    continue;
                }
                const name = play.kind === 'movie'
                    ? `${play.title}${play.year ? ` (${play.year})` : ''}`
                    : `${play.title} (series)`;
                // Newest first, so the first play of a title is its latest.
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
            where: { requestedBy: { id: user.id } },
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
    recent.set(user.id, { at: Date.now(), value });
    return value;
};
exports.recentActivity = recentActivity;
/** Forget what was gathered, so the next answer asks again. */
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
/** Posters fetched ahead: about what an answer shows before scrolling. */
const POSTERS_WARMED = 12;
/**
 * The TMDB entry for each title a model named, with this person's view of
 * its status (available, requested...), in the order named, without repeats.
 * A title TMDB cannot find is dropped rather than guessed.
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
 * TMDB titles as the app shows them, each with what the library knows of
 * it (status, requests), in the order given, without repeats.
 */
const withLibraryStatus = async (user, found) => {
    const seen = new Set();
    const unique = found.filter((f) => !seen.has(`${f.kind}:${f.result.id}`) &&
        !!seen.add(`${f.kind}:${f.result.id}`));
    // The posters shown first start on their way now, while the rest of the
    // answer is put together, rather than once the browser has drawn the
    // cards. Only when posters are served from Seerr's own cache.
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
/** Cut to a length, on a word where possible. */
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
