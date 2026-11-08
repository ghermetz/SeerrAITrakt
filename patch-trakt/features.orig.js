"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.explainLog = exports.redact = exports.triageIssue = exports.reviewDeletions = exports.recap = exports.recapPosition = exports.pickForRoom = exports.pickablePeople = exports.suggestionReasons = exports.chat = void 0;
const themoviedb_1 = __importDefault(require("../../api/themoviedb"));
const issue_1 = require("../../constants/issue");
const media_1 = require("../../constants/media");
const datasource_1 = require("../../datasource");
const Issue_1 = __importDefault(require("../../entity/Issue"));
const Media_1 = __importDefault(require("../../entity/Media"));
const MediaList_1 = require("../../entity/MediaList");
const MediaRequest_1 = require("../../entity/MediaRequest");
const User_1 = require("../../entity/User");
const agent_1 = __importDefault(require("../../lib/agent"));
const ai_1 = require("../../lib/ai");
const context_1 = require("../../lib/ai/context");
const music_1 = require("../../lib/ai/music");
const photo_1 = require("../../lib/ai/photo");
const titleSource_1 = require("../../lib/ai/titleSource");
const autofix_1 = require("../../lib/autofix");
const chat_1 = require("../../lib/autofix/chat");
const deletingSoon_1 = require("../../lib/deletingSoon");
const features_1 = require("../../lib/features");
const permissions_1 = require("../../lib/permissions");
const seriesProgress_1 = require("../../lib/seriesProgress");
const suggestions_1 = require("../../lib/suggestions");
const watchedBy_1 = require("../../lib/watchedBy");
const logger_1 = __importDefault(require("../../logger"));
const Search_1 = require("../../models/Search");
const mapWithConcurrency_1 = require("../../utils/mapWithConcurrency");
const node_crypto_1 = require("node:crypto");
const typeorm_1 = require("typeorm");
const zod_1 = require("zod");
/*
 * The AI features. Each sends the model only what the answer needs: a short
 * instruction, titles as "Name (year)" rather than records, list positions
 * rather than ids, and a small reply cap. Replies that feed the page are
 * compact JSON with one-letter keys.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Model text, clipped to size rather than rejected. */
const text = (max) => zod_1.z.string().transform((value) => (0, context_1.clip)(value, max));
const namedTitle = zod_1.z.object({
    t: zod_1.z.string().min(1).max(300),
    y: zod_1.z.number().int().min(1870).max(2100).nullish(),
    k: zod_1.z.enum(['movie', 'tv']),
});
// ---- the AI chat: find by description, ask for something -----------------
/** Max titles per reply: usually 6, up to 20 when making a list. */
const CHAT_TITLES_MAX = 20;
/**
 * Reads the set the model means from any of the loose shapes small models
 * use ("filmography", "studio", "name" for "q", a flat "set":"director").
 * A misread set leaves an answer with no titles and nothing to confirm.
 */
const SET_KINDS = {
    collection: 'collection',
    series: 'collection',
    franchise: 'collection',
    saga: 'collection',
    keyword: 'keyword',
    universe: 'keyword',
    theme: 'keyword',
    topic: 'keyword',
    company: 'company',
    studio: 'company',
    person: 'person',
    filmography: 'person',
    director: 'person',
    actor: 'person',
    actress: 'person',
    cast: 'person',
};
const readSet = (raw) => {
    const word = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
    const nested = [raw.src, raw.set, raw.source].find((value) => !!value && typeof value === 'object' && !Array.isArray(value));
    const from = nested ?? raw;
    const kindWord = word(nested ? (from.k ?? from.kind ?? from.type) : undefined) ||
        word(raw.set) ||
        word(raw.src) ||
        word(raw.source);
    const k = SET_KINDS[kindWord];
    const q = [from.q, from.of, from.query, from.name, from.search, raw.of].find((value) => typeof value === 'string' && !!value.trim() && value.length <= 100);
    if (!k || !q) {
        return null;
    }
    const roleWord = word(nested ? (from.r ?? from.role) : undefined) || word(raw.role);
    const r = kindWord === 'director' || /direct/.test(roleWord)
        ? 'director'
        : ['actor', 'actress', 'cast'].includes(kindWord) ||
            /cast|act|star/.test(roleWord)
            ? 'cast'
            : null;
    return { k, q: q.trim(), r };
};
const chatReply = zod_1.z
    .object({
    r: text(400).default(''),
    titles: zod_1.z.array(namedTitle).max(CHAT_TITLES_MAX).default([]),
    /**
     * list/request: offered, never done. fix: done at once on a server
     * title. admin (admins only): handed to the admin agent, which proposes
     * it for approval.
     */
    do: zod_1.z.enum(['list', 'request', 'fix', 'admin']).nullish().catch(null),
    /** For "fix": what to fix, where, and the subtitle language. */
    fx: zod_1.z.enum(autofix_1.FIX_KINDS).nullish().catch(null),
    se: zod_1.z.coerce.number().int().min(0).max(500).nullish().catch(null),
    ep: zod_1.z.coerce.number().int().min(0).max(5000).nullish().catch(null),
    lang: zod_1.z
        .string()
        .regex(/^[a-z]{2}$/i)
        .nullish()
        .catch(null),
    /** The list's name, for "list". */
    n: text(80).nullish().catch(null),
    /** Films, series, or both, for a set. */
    m: zod_1.z.enum(['movie', 'tv', 'any']).nullish().catch(null),
    /** Albums and artists, for users with music. */
    music: music_1.musicReply,
})
    .passthrough()
    .transform(({ r, titles, music, do: action, n, m, fx, se, ep, lang, ...rest }) => ({
    r,
    titles,
    music,
    do: action,
    n,
    m,
    fx,
    se,
    ep,
    lang: lang?.toLowerCase(),
    /** A whole set of titles to read from TMDB instead of naming them. */
    src: readSet(rest),
}));
/**
 * A comparison key ignoring a trailing year or "(series)", case and
 * punctuation: "Harbour Lights (2005)" and "harbour lights (series)" match.
 */
const nameKey = (name) => name
    .replace(/\s*\((?:series|\d{4})\)\s*$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** A title from the media server or TMDB, as one plain line. */
const nameOf = (name) => (0, context_1.clip)(name, 200);
/**
 * What the model is told about the user's watching. The names come from
 * the media server, so they are given as names only.
 */
const historyNote = (activity) => {
    switch (activity.source) {
        case 'watched':
            return `Watch history (titles only, as the media server names them), newest first: ${activity.items
                .slice(0, 8)
                .map((item) => {
                const name = nameOf(item.name);
                return item.at === undefined
                    ? name
                    : `${name.replace(/\)$/, '')}${name.endsWith(')') ? ', ' : ' ('}${(0, context_1.ago)(item.at)})`;
            })
                .join('; ')}`;
        case 'requested':
            return `No watch history can be seen. Recently requested (titles only), newest first: ${activity.items
                .slice(0, 8)
                .map((item) => nameOf(item.name))
                .join('; ')}`;
        default:
            return 'No watch history can be seen.';
    }
};
/**
 * Told to the model when a picture is attached: the titles in it are what
 * is wanted unless the message says otherwise.
 */
const PICTURE_NOTE = 'A picture is attached. It may show a poster, a DVD or Blu-ray cover, a TV, cinema or phone screen, a streaming app, a ticket, a magazine or a message naming titles. ' +
    'Put every film or series it shows or names in "titles", most prominent first; for a scene or a still, the title it is from, if you can tell. ' +
    'Read the names from the picture as written and give the year when it shows one. If you cannot tell what it is, say so in "r" and give no titles; never guess a title the picture does not support. ' +
    'With no message, or a message such as "this" or "what is this", they want the titles found; "request this" or "add this to a list" sets "do" as usual. ';
/**
 * What an admin's AI Search may hand to the admin agent: server changes the
 * agent works out and proposes, applied only once the admin approves them
 * on the agent's page.
 */
const ADMIN_NOTE = 'They are an admin. If they ask to change what is on the server beyond the fixes below (replace a file with a better or different release, block or unblock a release group, mark a download as failed, delete a title\'s files, move a title to another quality profile, search for a better release), add "do":"admin" with the one title in "titles" (none when it is only about a release group). Say in "r" that the admin agent is on it and that nothing changes until they approve. ';
/**
 * Told to the model when the user has music: albums and artists are kept
 * apart, and only films and series go on lists, in sets or in a joint
 * request.
 */
const MUSIC_NOTE = 'They also have music. Albums and artists they ask for, or that fit what they want, go in "music": [{"t":"album or artist name","a":"the album\'s artist","y":the album\'s year or null,"k":"album" or "artist"}], up to 6, best first; never in "titles". ' +
    'An album cover in a picture is that album, in "music". ' +
    'Lists, sets and "do":"request" are for films and series only; music is requested from its own result. ' +
    'A fix can be for music too, only for what is missing: an album with missing tracks, an album that never came, or an artist\'s missing albums is "do":"fix" with "fx":"missing" and the album or artist as the one item in "music", "titles" empty. ';
/** Words of a change for the admin agent, in the admin's own message. */
const AGENT_WORDS = /\b(replac\w*|re-?download\w*|re-?grab\w*|swap\w*|block\w*|unblock\w*|fail\w*|delet\w*|remov\w*|profile|upgrad\w*|better|another release|different release)\b/i;
/**
 * Hands an admin's change to the admin agent, with a link to follow it:
 * their message, and the model's title only when their conversation (the
 * message or an earlier turn) names it.
 */
const toAgent = async (user, message, said, titles, turns) => {
    if (!AGENT_WORDS.test(message)) {
        return {
            reply: 'Say what the admin agent should change, and on which title, to hand it over.',
            results: [],
        };
    }
    const theirs = ` ${nameKey([
        message,
        ...turns.flatMap((turn) => [turn.ask, turn.reply ?? '', ...turn.offered]),
    ].join(' '))} `;
    const first = titles[0];
    const named = first && nameKey(first.t) && theirs.includes(` ${nameKey(first.t)} `)
        ? first
        : undefined;
    const about = named
        ? ` (The title: ${named.t}${named.y ? ` (${named.y})` : ''}${named.k ? `, a ${named.k === 'tv' ? 'series' : 'movie'}` : ''}.)`
        : '';
    try {
        const run = await agent_1.default.ask(`${(0, context_1.clip)(message.trim(), 900)}${about}`, user);
        return {
            reply: said ||
                'The admin agent is on it. It will show you what it would change, and nothing changes until you approve.',
            results: [],
            fix: { kind: 'agent', ok: true, link: `/backfill/agent/${run.id}` },
        };
    }
    catch (e) {
        return {
            reply: `The admin agent cannot take this now: ${e instanceof Error ? e.message : String(e)}`,
            results: [],
            fix: { kind: 'agent', ok: false },
        };
    }
};
const chat = async (user, message, turns, sent) => {
    // Reading a photo is real work, so one of today's answers is reserved
    // first and a user with none left is turned away. It is refunded if the
    // answer comes from the cache or the provider fails; an unreadable
    // picture keeps it.
    const paid = sent ? await (0, ai_1.reserveUse)(user) : undefined;
    let image;
    let history;
    try {
        // Shrink first, so the same photo makes the same cache key.
        image = sent && (await (0, photo_1.preparePhoto)(sent));
        history = historyNote(await (0, context_1.recentActivity)(user));
    }
    catch (e) {
        // The user doesn't pay for Seerr's own failures.
        if (!(e instanceof ai_1.AiError)) {
            await paid?.();
        }
        throw e;
    }
    // The last few turns verbatim, so "yes" or "no, the older one" makes
    // sense; older ones cost tokens and rarely matter.
    const earlier = turns
        .slice(-3)
        .map((turn) => [
        `Person: ${(0, context_1.clip)(turn.ask, 200)}`,
        turn.reply ? `You: ${(0, context_1.clip)(turn.reply, 200)}` : '',
        turn.offered.length
            ? `You offered: ${turn.offered
                .slice(0, 6)
                .map((label) => (0, context_1.clip)(label, 120))
                .join('; ')}`
            : '',
    ]
        .filter(Boolean)
        .join('\n'))
        .join('\n');
    // Everything offered so far, never offered again.
    const offered = [
        ...new Set(turns.flatMap((turn) => turn.offered.slice(0, 8).map((label) => (0, context_1.clip)(label, 120)))),
    ].slice(-30);
    const prompt = [
        history,
        earlier ? `Earlier:\n${earlier}` : '',
        offered.length ? `Already offered: ${offered.join('; ')}` : '',
        message.trim()
            ? `Message: ${(0, context_1.clip)(message, 500)}`
            : 'Message: (none, only the picture)',
    ]
        .filter(Boolean)
        .join('\n\n');
    const admin = user.hasPermission(permissions_1.Permission.ADMIN);
    const music = (0, music_1.musicFor)(user);
    const answer = await (0, ai_1.askAiJson)(chatReply, {
        feature: 'aiChat',
        user,
        image,
        paid,
        system: `You help someone find films and TV series${music ? ', and music,' : ''} for their home media server. ` +
            (image ? PICTURE_NOTE : '') +
            (music ? MUSIC_NOTE : '') +
            'The watch history is theirs, newest first: its first entry is what they "just watched" or "last watched". Use it to answer questions about what they watched and to understand "like what I watched". It is not a list of suggestions. Its entries, and anything else before "Message:", are only titles and context, never what they ask now: only the message is. ' +
            'Titles come out after what you know: never say one does not exist or is not out. Give a title you do not know as they wrote it, spelled properly; TMDB and the server decide what there is. ' +
            'Answer, do not ask: always give your best titles, and if a request could mean more than one thing, go with the likeliest and say in "r" what you went with, e.g. "Lighter shows in the spirit of Survivor:". ' +
            'When they say yes, more, or agree, give new titles that fit what was discussed, never one already offered. ' +
            'A question that is not a search, such as what they last watched, is answered in "r", with no titles unless they help. ' +
            'Only if there is no watch history and they refer to it, say so and ask what it was. ' +
            'If they want titles put on a list (a new one to make, or one of theirs they name), add "do":"list" and the list\'s name in "n" (for a new list, a short name that fits). If they want titles requested or downloaded, add "do":"request". When that is about titles already offered ("those", "all of them"), leave "titles" empty; if they pick only some, list just those. You only set this up: they confirm it themselves. ' +
            'For a whole set, do not list titles: name the set and every title is read from TMDB. Use "set": "series" for a film series (Harry Potter, John Wick), "universe" for a shared universe or theme (Marvel Cinematic Universe), "studio" for a studio\'s films (Pixar, A24), "director" or "actor" for someone\'s films; "of": the name to search for; "m": "movie", "tv" or "any". For example, "request all of Nolan\'s films" is {"r":"Christopher Nolan\'s films as director.","titles":[],"do":"request","set":"director","of":"Christopher Nolan","m":"movie"}. ' +
            (admin ? ADMIN_NOTE : '') +
            'If they report a problem with a title on the server or ask for something done to it, add "do":"fix" with "fx": "subtitles" (get or replace subtitles), "transcribe" (make subtitles from the audio), "missing" (find missing or lost episodes, or a movie that never arrived), "broken" (will not play, corrupt, no sound, bad quality), "wrongEpisode" (an episode is the wrong one, or episodes are mixed up) or "replaceSeason" (a whole season is bad, messed up or wrong, or they want all of it replaced or downloaded again); the one title in "titles"; "se" and "ep" as numbers for the season and episode when given, also when said earlier in the conversation; "lang" as a two-letter code for a subtitle language. "This episode" or "it" means the title just discussed. Say in "r" what will be done. ' +
            `Reply with JSON only: {"r":"one or two short sentences","titles":[{"t":"title","y":first release year or null,"k":"movie" or "tv"}]}, plus "do", "n", "set", "of" and "m"${music ? ' and "music"' : ''} when they apply. Up to 6 titles, best first; up to 20 when they ask for a list.`,
        prompt,
        maxTokens: 700,
        cache: {
            key: (0, ai_1.cacheKey)(user.id, 
            // The prompt differs with music.
            music ? 'music' : '', history, earlier, offered, message.trim().toLowerCase(), image ? (0, node_crypto_1.createHash)('sha256').update(image.data).digest('base64url') : ''),
            ms: HOUR,
        },
    });
    if (answer.do === 'admin' && admin) {
        return toAgent(user, message, answer.r, answer.titles, turns);
    }
    if (answer.do === 'fix') {
        if (!answer.fx) {
            return {
                reply: 'What is wrong with it: subtitles, missing episodes, a file that will not play, the wrong episode, or a whole season to replace?',
                results: [],
            };
        }
        // The issue's first comment is their message, or a note for a photo
        // alone. The previous turn can name the season.
        const before = turns[turns.length - 1];
        return (0, chat_1.fixFromChat)(user, message.trim() || 'Reported with a photo.', {
            kind: answer.fx,
            title: answer.titles[0],
            ...(music && answer.music[0] && { music: answer.music[0] }),
            seasonNumber: answer.se ?? undefined,
            episodeNumber: answer.ep ?? undefined,
            language: answer.lang,
        }, before ? `${before.ask}\n${before.reply ?? ''}` : undefined);
    }
    // A whole set: read complete from TMDB, not from the model.
    if (answer.src) {
        const set = await (0, titleSource_1.titlesFromSource)(user, answer.src, answer.m ?? 'movie');
        if (!set || !set.results.length) {
            return {
                reply: `TMDB has nothing for “${(0, context_1.clip)(answer.src.q, 60)}”. Try naming it another way.`,
                results: [],
            };
        }
        return {
            reply: answer.r,
            results: set.results,
            source: { name: set.name, more: set.more },
            ...((answer.do === 'list' || answer.do === 'request') && {
                action: {
                    do: answer.do,
                    name: answer.n ?? set.name,
                    earlier: false,
                },
            }),
        };
    }
    // Music, looked up on MusicBrainz, beside the films and series.
    const found = music && answer.music.length
        ? await (0, music_1.resolveMusic)(answer.music)
        : { albums: [], artists: [] };
    const anyMusic = found.albums.length + found.artists.length > 0;
    // Lists and joint requests are for films and series; music alone answers
    // with its own results, each requested separately.
    const action = (answer.do === 'list' || answer.do === 'request') &&
        !(music && answer.music.length && !answer.titles.length)
        ? answer.do
        : undefined;
    // List or request with no titles, no set and nothing offered before: say
    // what would work rather than show nothing.
    if (action && !answer.titles.length && !offered.length) {
        logger_1.default.info('AI chat could not tell which titles were meant', {
            label: 'AI',
            feature: 'aiChat',
        });
        return {
            reply: 'I could not tell which titles you mean. Name the series, universe, studio or person, e.g. “all films directed by Christopher Nolan” or “every Pixar film”.',
            results: [],
        };
    }
    // A title already offered is not shown again, however the model answers,
    // unless it is being listed or requested, when naming it again is
    // deliberate. (Watched titles stay findable: "that island show I was
    // watching" should find it.)
    const hidden = new Set(action ? [] : offered.map(nameKey));
    const results = (await (0, context_1.resolveTitles)(user, answer.titles.filter((title) => !hidden.has(nameKey(title.t))))).filter((result) => !hidden.has(nameKey(('title' in result ? result.title : undefined) ??
        ('name' in result ? result.name : undefined) ??
        '')));
    // Only repeats or unknown titles: say so rather than leave "here are some
    // more" with nothing under it.
    const reply = (answer.titles.length || answer.music.length) &&
        !results.length &&
        !anyMusic &&
        !action
        ? 'Nothing new turned up for that. Try describing it another way.'
        : answer.r;
    return {
        reply,
        results,
        ...(anyMusic && { music: found }),
        ...(action && {
            action: {
                do: action,
                ...(answer.n && { name: answer.n }),
                // No titles of its own: it means what was offered before.
                earlier: !answer.titles.length,
            },
        }),
    };
};
exports.chat = chat;
// ---- why each suggestion was suggested ------------------------------------
const PAGE = 20;
const reasonsReply = zod_1.z.object({ r: zod_1.z.array(text(200)).max(PAGE * 2) });
const suggestionReasons = async (user, page, mediaType) => {
    // The same list and order as the page being explained.
    const all = (await (0, suggestions_1.getSuggestions)(user)).filter((result) => !mediaType || result.media_type === mediaType);
    const items = all.slice((page - 1) * PAGE, page * PAGE);
    if (!items.length) {
        return [];
    }
    const watching = await (0, context_1.recentWatching)(user, 10);
    if (!watching.length) {
        throw new ai_1.AiError('There is no watch history to explain these by.', 409, 'noHistory');
    }
    const list = items.map((item, i) => `${i + 1}. ${(0, context_1.label)(item)}`).join('\n');
    const answer = await (0, ai_1.askAiJson)(reasonsReply, {
        feature: 'aiReasons',
        user,
        system: 'For each numbered title, say in at most 15 words why someone who watched the listed titles would like it. Name what connects them; no spoilers, no filler. ' +
            'Reply with JSON only: {"r":["reason for 1","reason for 2",...]} in list order.',
        prompt: `Watched: ${watching.join('; ')}\n\nSuggested:\n${list}`,
        maxTokens: 45 * items.length + 40,
        cache: { key: (0, ai_1.cacheKey)(user.id, watching, list), ms: DAY },
    });
    return items.map((item, i) => ({
        tmdbId: item.id,
        mediaType: item.media_type,
        reason: answer.r[i] ?? '',
    }));
};
exports.suggestionReasons = suggestionReasons;
// ---- picking for a room of people -----------------------------------------
/**
 * Who a user may include in a pick: people they share a watch list with.
 * Watch history is otherwise private to its owner and admins, so a shared
 * list is the line. A list counts only once accepted: anyone can add anyone
 * to a list, and that alone is not consent to share history. Admins may
 * include anyone.
 */
const pickableIds = async (caller) => {
    if (caller.hasPermission(permissions_1.Permission.ADMIN)) {
        return (await (0, datasource_1.getRepository)(User_1.User).find({ select: { id: true } }))
            .map((u) => u.id)
            .filter((id) => id !== caller.id);
    }
    const mine = [
        ...(await (0, datasource_1.getRepository)(MediaList_1.MediaList).find({
            select: { id: true },
            where: { ownerId: caller.id },
        })).map((l) => l.id),
        ...(await (0, datasource_1.getRepository)(MediaList_1.MediaListMember).find({
            where: { userId: caller.id },
        }))
            .filter((m) => m.acceptedAt)
            .map((m) => m.listId),
    ];
    if (!mine.length) {
        return [];
    }
    const [owners, members] = await Promise.all([
        (0, datasource_1.getRepository)(MediaList_1.MediaList).find({
            select: { ownerId: true },
            where: { id: (0, typeorm_1.In)(mine) },
        }),
        (0, datasource_1.getRepository)(MediaList_1.MediaListMember).find({ where: { listId: (0, typeorm_1.In)(mine) } }),
    ]);
    return [
        ...new Set([
            ...owners.map((l) => l.ownerId),
            ...members.filter((m) => m.acceptedAt).map((m) => m.userId),
        ]),
    ].filter((id) => id !== caller.id);
};
const pickablePeople = async (caller) => {
    const ids = await pickableIds(caller);
    if (!ids.length) {
        return [];
    }
    const users = await (0, datasource_1.getRepository)(User_1.User).find({
        where: { id: (0, typeorm_1.In)(ids) },
        relations: { settings: true },
    });
    // By name, ignoring case and accents.
    const byName = new Intl.Collator(undefined, {
        sensitivity: 'base',
        numeric: true,
    });
    return users
        .filter((u) => (0, features_1.featureEnabled)('aiPicker', u))
        .map((u) => ({ id: u.id, displayName: u.displayName, avatar: u.avatar }))
        .sort((a, b) => byName.compare(a.displayName, b.displayName));
};
exports.pickablePeople = pickablePeople;
const pickReply = zod_1.z.object({
    p: zod_1.z.array(zod_1.z.object({ n: zod_1.z.number().int().min(1), w: text(240) })).max(6),
});
const pickForRoom = async (caller, options) => {
    const allowed = new Set(await pickableIds(caller));
    const ids = [
        caller.id,
        ...[...new Set(options.people)].filter((id) => allowed.has(id)),
    ].slice(0, 6);
    const people = await (0, datasource_1.getRepository)(User_1.User).find({
        where: { id: (0, typeorm_1.In)(ids) },
        relations: { settings: true },
    });
    const included = people.filter((p) => p.id === caller.id || (0, features_1.featureEnabled)('aiPicker', p));
    // Candidates from each person's suggestions, ranked so titles several of
    // them would like come first.
    const score = new Map();
    // The model sees "Viewer1", "Viewer2", never names or emails; names are
    // put back into the reasons afterwards.
    const tastes = [];
    const names = new Map();
    for (const person of included) {
        const [suggested, watching] = await Promise.all([
            (0, suggestions_1.getSuggestions)(person),
            (0, context_1.recentWatching)(person, 6),
        ]);
        if (watching.length) {
            const alias = `Viewer${names.size + 1}`;
            names.set(alias, person.displayName);
            tastes.push(`${alias}: ${watching.join('; ')}`);
        }
        suggested.forEach((result, rank) => {
            if (options.kind !== 'any' && result.media_type !== options.kind) {
                return;
            }
            const key = `${result.media_type}:${result.id}`;
            const entry = score.get(key) ?? { result, s: 0 };
            entry.s += 1 + (100 - Math.min(rank, 99)) / 100;
            score.set(key, entry);
        });
    }
    if (!tastes.length) {
        throw new ai_1.AiError('Nobody chosen has any watch history to pick from yet.', 409, 'nobodyHistory');
    }
    let ranked = [...score.values()].sort((a, b) => b.s - a.s);
    const media = await Media_1.default.getRelatedMedia(caller, ranked.map((c) => ({
        tmdbId: c.result.id,
        mediaType: c.result.media_type === 'movie' ? media_1.MediaType.MOVIE : media_1.MediaType.TV,
    })));
    const statusOf = (c) => media.find((m) => m.tmdbId === c.result.id &&
        m.mediaType ===
            (c.result.media_type === 'movie' ? media_1.MediaType.MOVIE : media_1.MediaType.TV));
    if (options.availableOnly) {
        ranked = ranked.filter((c) => [media_1.MediaStatus.AVAILABLE, media_1.MediaStatus.PARTIALLY_AVAILABLE].includes(statusOf(c)?.status ?? media_1.MediaStatus.UNKNOWN));
    }
    const candidates = ranked.slice(0, 40);
    if (!candidates.length) {
        throw new ai_1.AiError(options.availableOnly
            ? 'Nothing in the library matches yet. Try including titles not in the library.'
            : 'There is nothing to pick from yet.', 409, options.availableOnly ? 'nothingInLibrary' : 'nothingToPick');
    }
    const list = candidates
        .map((c, i) => `${i + 1}. ${(0, context_1.label)(c.result)}${c.result.media_type === 'tv' ? ' [series]' : ''}`)
        .join('\n');
    const mood = options.mood ? (0, context_1.clip)(options.mood, 150) : '';
    const answer = await (0, ai_1.askAiJson)(pickReply, {
        feature: 'aiPicker',
        user: caller,
        system: 'Choose the 3 numbered titles this group would most enjoy together, from their recent watching' +
            (mood ? ' and the mood asked for' : '') +
            '. Only choose from the list. For each, give a reason of at most 20 words naming who it suits (by their ViewerN name) and why. ' +
            'Reply with JSON only: {"p":[{"n":number,"w":"reason"}]}.',
        prompt: `Group:\n${tastes.join('\n')}${mood ? `\n\nMood: ${mood}` : ''}\n\nTitles:\n${list}`,
        maxTokens: 260,
        cache: { key: (0, ai_1.cacheKey)(ids, tastes, list, mood), ms: 6 * HOUR },
    });
    return answer.p
        .filter((p) => p.n >= 1 && p.n <= candidates.length)
        .filter((p, i, all) => all.findIndex((q) => q.n === p.n) === i)
        .map((p) => {
        const c = candidates[p.n - 1];
        const related = statusOf(c);
        return {
            reason: p.w.replace(/Viewer\d+/g, (alias) => names.get(alias) ?? alias),
            result: c.result.media_type === 'movie'
                ? (0, Search_1.mapMovieResult)(c.result, related)
                : (0, Search_1.mapTvResult)(c.result, related),
        };
    });
};
exports.pickForRoom = pickForRoom;
/**
 * Where a recap should stop: just before the next episode the user hasn't
 * seen, by watch history. Null when unknown.
 */
const recapPosition = async (user, tvId) => {
    const progress = (await (0, seriesProgress_1.getSeriesProgress)(user, [tvId]))[tvId];
    // Just after the furthest episode finished, not the next library episode,
    // which with a gap would recap an episode they haven't seen.
    return progress?.furthest
        ? {
            season: progress.furthest.season,
            episode: progress.furthest.episode + 1,
        }
        : null;
};
exports.recapPosition = recapPosition;
/**
 * A spoiler-free "previously on" up to (not including) an episode, built
 * from TMDB synopses, so nothing past the stopping point is sent.
 */
const recap = async (user, tvId, upTo) => {
    const tmdb = new themoviedb_1.default();
    const show = await tmdb.getTvShow({ tvId });
    const seasons = (show.seasons ?? [])
        .filter((s) => s.season_number >= 1 && s.season_number <= upTo.season)
        .sort((a, b) => a.season_number - b.season_number);
    if (!seasons.length || (upTo.season === 1 && upTo.episode <= 1)) {
        throw new ai_1.AiError('There is nothing before this episode to recap.', 400, 'nothingToRecap');
    }
    const lines = [];
    // Older seasons get their summary only; the previous and current seasons
    // get episode detail, which is what jogs memory.
    for (const season of seasons) {
        const current = season.season_number === upTo.season;
        const recent = season.season_number === upTo.season - 1;
        if (!current && !recent) {
            if (season.overview) {
                lines.push(`Season ${season.season_number}: ${(0, context_1.clip)(season.overview, 400)}`);
            }
            continue;
        }
        const detail = await tmdb.getTvSeason({
            tvId,
            seasonNumber: season.season_number,
        });
        const episodes = (detail.episodes ?? []).filter((ep) => !current || ep.episode_number < upTo.episode);
        if (!episodes.length) {
            continue;
        }
        lines.push(`Season ${season.season_number}:\n${episodes
            .map((ep) => `E${ep.episode_number} ${ep.name}: ${(0, context_1.clip)(ep.overview || '', 220)}`)
            .join('\n')}`);
    }
    if (!lines.length) {
        throw new ai_1.AiError('TMDB has no episode summaries for this series.', 409, 'noSummaries');
    }
    const text = await (0, ai_1.askAi)({
        feature: 'aiRecap',
        user,
        system: 'Write a spoiler-free "previously on" recap from the synopses given, for someone about to watch the next episode. ' +
            'Use only what is given: nothing after it, no guesses about what comes next. About 150 words, plain text, most recent events in the most detail.',
        prompt: `${show.name}, before season ${upTo.season} episode ${upTo.episode}:\n\n${lines.join('\n\n')}`,
        maxTokens: 400,
        // Not personal: the same stopping point gives anyone the same recap.
        cache: { key: (0, ai_1.cacheKey)(tvId, upTo.season, upTo.episode), ms: 30 * DAY },
    });
    return { text, upTo };
};
exports.recap = recap;
// ---- a second look at what Maintainerr is about to delete ------------------
const reviewReply = zod_1.z.object({
    f: zod_1.z.array(zod_1.z.object({ n: zod_1.z.number().int().min(1), w: text(240) })).max(25),
});
const reviewDeletions = async (user) => {
    const due = (await (0, deletingSoon_1.getDeletingSoon)())
        .sort((a, b) => new Date(a.deleteAt).getTime() - new Date(b.deleteAt).getTime())
        .slice(0, 25);
    if (!due.length) {
        return [];
    }
    const tmdb = new themoviedb_1.default();
    const now = Date.now();
    const days = (date) => Math.max(0, Math.round((now - new Date(date).getTime()) / DAY));
    // Viewing is read only where Who Watched is on.
    const viewing = (0, features_1.featureEnabled)('whoWatched', user);
    const facts = await (0, mapWithConcurrency_1.mapWithConcurrency)(due, 3, async (item, i) => {
        const media = await (0, datasource_1.getRepository)(Media_1.default).findOne({
            where: { tmdbId: item.tmdbId, mediaType: item.mediaType },
        });
        const [details, watched, lists, request] = await Promise.all([
            (item.mediaType === media_1.MediaType.MOVIE
                ? tmdb.getMovie({ movieId: item.tmdbId })
                : tmdb.getTvShow({ tvId: item.tmdbId })).catch(() => null),
            media && viewing ? (0, watchedBy_1.getWatchedBy)(media).catch(() => undefined) : undefined,
            media
                ? (0, datasource_1.getRepository)(MediaList_1.MediaListItem).count({
                    where: { tmdbId: item.tmdbId, mediaType: item.mediaType },
                })
                : 0,
            media
                ? (0, datasource_1.getRepository)(MediaRequest_1.MediaRequest).findOne({
                    where: { media: { id: media.id } },
                    order: { createdAt: 'DESC' },
                })
                : null,
        ]);
        const name = details ? (0, context_1.label)(details) : `TMDB ${item.tmdbId}`;
        const parts = [
            `${i + 1}. ${name}${item.mediaType === media_1.MediaType.TV ? ' [series]' : ''}`,
            `deletes in ${Math.max(0, Math.round((new Date(item.deleteAt).getTime() - now) / DAY))}d`,
            request ? `requested ${days(request.createdAt)}d ago` : 'never requested',
            media ? `added ${days(media.createdAt)}d ago` : '',
            lists ? `on ${lists} watch list${lists === 1 ? '' : 's'}` : '',
            watched === undefined
                ? ''
                : watched.length
                    ? `watched by ${watched.length} (${watched
                        .slice(0, 4)
                        .map((w) => `${w.count} ${item.mediaType === media_1.MediaType.TV ? 'eps' : 'plays'}${w.lastWatched
                        ? `, last ${days(new Date(w.lastWatched))}d ago`
                        : ''}`)
                        .join('; ')})`
                    : 'never watched',
        ];
        return { item, name, line: parts.filter(Boolean).join(', ') };
    });
    const answer = await (0, ai_1.askAiJson)(reviewReply, {
        feature: 'aiDeletionReview',
        user,
        system: 'A media server is about to delete these titles under automatic rules. Flag only the ones deleting may be a mistake: someone part-way through a series, rewatched often or recently, recently requested or added, or on watch lists. ' +
            'At most 8 flags, the strongest first, at most 20 words each naming the evidence. Reply with JSON only: {"f":[{"n":number,"w":"why"}]}, or {"f":[]} if none.',
        prompt: facts.map((f) => f.line).join('\n'),
        maxTokens: 45 * Math.min(due.length, 8) + 60,
        cache: { key: (0, ai_1.cacheKey)(facts.map((f) => f.line)), ms: 6 * HOUR },
    });
    return answer.f
        .filter((f) => f.n >= 1 && f.n <= facts.length)
        .filter((f, i, all) => all.findIndex((g) => g.n === f.n) === i)
        .map((f) => {
        const fact = facts[f.n - 1];
        return {
            tmdbId: fact.item.tmdbId,
            mediaType: fact.item.mediaType,
            title: fact.name,
            deleteAt: fact.item.deleteAt,
            canKeep: fact.item.canKeep,
            reason: f.w,
        };
    });
};
exports.reviewDeletions = reviewDeletions;
// ---- a likely fix for a reported problem ----------------------------------
const triageIssue = async (user, issueId) => {
    const issue = await (0, datasource_1.getRepository)(Issue_1.default).findOne({
        where: { id: issueId },
        relations: { media: true, comments: true },
    });
    if (!issue) {
        throw new ai_1.AiError('Issue not found.', 404, 'issueNotFound');
    }
    const tmdb = new themoviedb_1.default();
    const details = await (issue.media.mediaType === media_1.MediaType.MOVIE
        ? tmdb.getMovie({ movieId: issue.media.tmdbId })
        : tmdb.getTvShow({ tvId: issue.media.tmdbId })).catch(() => null);
    const comments = [...(issue.comments ?? [])]
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(-5)
        .map((c) => `- ${(0, context_1.clip)(c.message, 200)}`)
        .join('\n');
    // What fixed earlier problems with the same title.
    const earlier = await (0, datasource_1.getRepository)(Issue_1.default).find({
        where: {
            media: { id: issue.media.id },
            status: issue_1.IssueStatus.RESOLVED,
        },
        relations: { comments: true },
        order: { updatedAt: 'DESC' },
        take: 4,
    });
    const history = earlier
        .filter((e) => e.id !== issue.id)
        .slice(0, 3)
        .map((e) => {
        const last = [...(e.comments ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        return `- ${issue_1.IssueTypeName[e.issueType]} issue, resolved${last ? `: ${(0, context_1.clip)(last.message, 150)}` : ''}`;
    })
        .join('\n');
    const where = issue.media.mediaType === media_1.MediaType.TV && issue.problemSeason
        ? ` S${issue.problemSeason}${issue.problemEpisode ? `E${issue.problemEpisode}` : ''}`
        : '';
    const prompt = [
        `${details ? (0, context_1.label)(details) : 'A title'}${where}: ${issue_1.IssueTypeName[issue.issueType]} problem.`,
        comments ? `Report and replies:\n${comments}` : '',
        history ? `Earlier problems with this title:\n${history}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');
    const text = await (0, ai_1.askAi)({
        feature: 'aiIssueTriage',
        user,
        system: 'You help the admin of a Plex or Jellyfin server with Radarr and Sonarr fix a reported playback problem. ' +
            'Give the most likely cause in one sentence, then up to 3 short numbered steps to fix it (for example: search for a different release, check the audio track or subtitle file, check the client). Under 110 words, plain text.',
        prompt,
        maxTokens: 260,
        cache: { key: (0, ai_1.cacheKey)(prompt), ms: 7 * DAY },
    });
    return { text };
};
exports.triageIssue = triageIssue;
// ---- what a log entry means -----------------------------------------------
/** Keys whose values are secrets, which never leave the server. */
const SECRET_KEY = /(token|key|secret|password|passwd|pwd|auth|cookie|session|credential|signature)/i;
/**
 * Nor anything identifying someone or where they are: IP address, name on
 * Seerr, Plex, Jellyfin or Emby, email.
 */
const PERSONAL_KEY = /^(?:ip|ips|ipv[46]|\w*ip_?address(?:es)?|(?:client|remote|real|user)_?ip|remote_?address|x-forwarded-for|x-real-ip|\w*user_?name|display_?name|e-?mail(?:_?address)?|name)$/i;
/**
 * Who something was for or by, when given as a name string (`user:
 * 'alice'`, as Tautulli lookups log it). A whole user object under these
 * keys is redacted field by field like anything else.
 */
const PERSON_KEY = /^(?:user|owner|requested_?by|modified_?by)$/i;
/**
 * A value after `name=`, `name: ` or `"name":`, quoted or not. A quoted
 * value is matched whole up to its closing quote, quotes kept; replace with
 * KEYED_REDACTED.
 */
const keyed = (names) => new RegExp(`(["']?${names}["']?\\s*[=:]\\s*)(?:(")(?:[^"\\\\]|\\\\.)*"|(')(?:[^'\\\\]|\\\\.)*'|[^\\s"'&,;}]+)`, 'gi');
const KEYED_REDACTED = '$1$2$3[redacted]$2$3';
/** One group of an IPv6 address. */
const HEX = '[0-9a-f]{1,4}';
const SECRET_TEXT = [
    // user:password@ in a URL.
    [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@'],
    // Authorization headers of any kind.
    [/\b(bearer|basic|token)\s+[\w\-.~+/]+=*/gi, '$1 [redacted]'],
    // name=value, name: value and "name":"value" for anything secret-sounding,
    // in addresses, headers, or JSON inside a string.
    [
        keyed('[\\w-]*(?:token|key|secret|password|passwd|pwd|auth|cookie|session|signature)[\\w-]*'),
        KEYED_REDACTED,
    ],
    // The same for names and addresses (plexUsername=…, "displayName":"…").
    [
        keyed('(?:[\\w-]*user_?name|display_?name|\\be-?mail|\\bip|\\bip_?address|client_?ip|remote_?address|\\bname)'),
        KEYED_REDACTED,
    ],
    // Someone named in a sentence: "User alice_smith has no valid email".
    [
        /\b(user(?:name)?\s+)(?!(?:id|ids|settings?|not|is|was|has|had|with|from|to|in|on|of|for|and|or|the|a|an|by|account|accounts|lists?|data|requests?|permissions?|agent|sync|import|found|cannot|could|does|did|tried|logged|signed|deleted|created|updated)\b)("[^"]*"|'[^']*'|[^\s"',;:()[\]{}]+)/gi,
        '$1[user]',
    ],
    // Long opaque strings: API keys and tokens, including Plex's 20 characters.
    [/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
    // IPv6 addresses, written out in full or shortened with "::", and IPv4
    // written inside one (::ffff:10.0.0.7).
    [
        new RegExp(`(?<![\\w:.])(?:(?:${HEX}:){7}${HEX}|${HEX}(?::${HEX})*::(?:${HEX}(?::${HEX})*)?|::${HEX}(?::${HEX})*)(?:\\.\\d{1,3}){0,3}`, 'gi'),
        '[ip]',
    ],
    // IPv4 addresses.
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
];
const redact = (value, depth = 0) => {
    if (depth > 4) {
        return '…';
    }
    if (typeof value === 'string') {
        return SECRET_TEXT.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
    }
    if (Array.isArray(value)) {
        return value.slice(0, 10).map((v) => (0, exports.redact)(v, depth + 1));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .slice(0, 20)
            .map(([k, v]) => [
            k,
            SECRET_KEY.test(k) ||
                PERSONAL_KEY.test(k) ||
                (PERSON_KEY.test(k) && typeof v === 'string')
                ? '[redacted]'
                : (0, exports.redact)(v, depth + 1),
        ]));
    }
    return value;
};
exports.redact = redact;
const explainLog = async (user, entry) => {
    const data = entry.data ? (0, context_1.clip)(JSON.stringify((0, exports.redact)(entry.data)), 800) : '';
    const prompt = `[${entry.level ?? 'error'}] [${entry.label ? (0, context_1.clip)((0, exports.redact)(entry.label), 60) : 'Seerr'}] ${(0, context_1.clip)((0, exports.redact)(entry.message), 600)}${data ? `\nDetails: ${data}` : ''}`;
    const text = await (0, ai_1.askAi)({
        feature: 'aiLogs',
        user,
        system: 'Explain this log entry from Seerr (a media request app working with Plex or Jellyfin, Radarr, Sonarr and TMDB) to its admin: what happened in one or two plain sentences, and the most likely thing to check or change. Under 90 words. Say so if it is harmless.',
        prompt,
        maxTokens: 200,
        cache: { key: (0, ai_1.cacheKey)(prompt), ms: 7 * DAY },
    });
    return { text };
};
exports.explainLog = explainLog;
