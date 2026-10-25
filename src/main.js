// Facebook Posts Pro — Apify actor entry point.
import { Actor, log } from 'apify';
import { Client, Session, BlockedError, StoppedError } from './http.js';
import { makeFacebook, parseFacebookInput } from './facebook.js';
import { storyToPost } from './parse.js';
import { transcribe, MAX_AUDIO_BYTES } from './ai.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_POST = 'post'; // one saved post
export const EVENT_TRANSCRIPT = 'video-transcript'; // a transcript added to a video post (captions or AI)

const PAGE_CONCURRENCY = 8; // pages paginate one request at a time each; this many pages run in parallel
const POST_CONCURRENCY = 15; // single post / video URLs
const STOP_BEFORE_TIMEOUT_MS = 45000;
const PROGRESS_EVERY = 50;
const TIMELINE_COUNT = 3; // posts per timeline request (what facebook.com itself asks for)
const OLDER_STREAK_TO_STOP = 3; // pinned / out-of-order posts tolerance for the "newer than" date filter

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : []).map((x) => String(typeof x === 'object' && x ? x.url ?? '' : x).trim()).filter(Boolean);
const TYPES = ['photo', 'album', 'video', 'reel', 'link', 'text', 'shared'];
const opts = {
    startUrls: list(input.startUrls),
    resultsLimit: num(input.resultsLimit, 20, 1, 100000),
    onlyPostsNewerThan: String(input.onlyPostsNewerThan ?? '').trim(),
    onlyPostsOlderThan: String(input.onlyPostsOlderThan ?? '').trim(),
    postTypes: list(input.postTypes).map((t) => t.toLowerCase()).filter((t) => TYPES.includes(t)),
    keywords: list(input.keywords),
    minReactions: num(input.minReactions, 0, 0, 1e9),
    minComments: num(input.minComments, 0, 0, 1e9),
    topCommentsPerPost: num(input.topCommentsPerPost, 5, 0, 50),
    fetchVideoDetails: input.fetchVideoDetails !== false,
    includeVideoTranscript: Boolean(input.includeVideoTranscript),
    aiProvider: ['openai', 'groq'].includes(input.aiProvider) ? input.aiProvider : 'none',
    aiApiKey: String(input.aiApiKey ?? '').trim(),
    aiMaxMinutes: num(input.aiMaxMinutes, 20, 1, 240),
    maxResults: num(input.maxResults, 0, 0, 1e9),
    includeFailedInputs: input.includeFailedInputs !== false,
    skipPreviouslyScraped: Boolean(input.skipPreviouslyScraped),
    dedupeStoreName: /^[a-z0-9-]{1,63}$/.test(input.dedupeStoreName ?? '') ? input.dedupeStoreName : 'facebook-posts-pro-seen',
};
if (opts.aiProvider !== 'none' && !opts.aiApiKey) {
    log.warning(`AI transcription is set to "${opts.aiProvider}" but no API key was given — AI fallback is off for this run.`);
    opts.aiProvider = 'none';
}
function parseDate(s, name) {
    if (!s) return null;
    const rel = s.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?(\s+ago)?$/i);
    const d = rel ? new Date(Date.now() - Number(rel[1]) * { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2].toLowerCase()]) : new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`"${s}" in "${name}" is not a valid date. Use "2025-01-31", "2025-01-31T12:00:00Z" or "30 days".`);
    return d;
}
let newerThan;
let olderThan;
try {
    newerThan = parseDate(opts.onlyPostsNewerThan, 'Only posts newer than');
    olderThan = parseDate(opts.onlyPostsOlderThan, 'Only posts older than');
} catch (err) {
    await Actor.fail(err.message);
}
const kwRes = opts.keywords.map((k) => ({ k, re: new RegExp(`(?<![\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu') }));

// ---------- Deadline, routes, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return stopReason ? 0 : deadline - Date.now();
};

let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
} catch (err) {
    log.warning(`Proxy could not be configured (${err.message}). Continuing without it.`);
}
const groups = input.proxyConfiguration?.apifyProxyGroups ?? [];
const proxyLabel = !proxyConfiguration ? 'no proxy (server IP)' : input.proxyConfiguration?.useApifyProxy ? `Apify proxy (${groups.length ? groups.join(', ') : 'datacenter'})` : 'custom proxy';
const routes = [{ label: proxyLabel, proxy: proxyConfiguration }];
if (input.proxyFallback !== false) {
    if (Actor.isAtHome() || Boolean(process.env.APIFY_PROXY_PASSWORD)) {
        for (const g of [['RESIDENTIAL'], []]) {
            const label = `Apify proxy (${g.length ? g[0] : 'datacenter'})`;
            if (label === proxyLabel) continue;
            try {
                const pc = await Actor.createProxyConfiguration({ useApifyProxy: true, ...(g.length ? { apifyProxyGroups: g } : {}) });
                if (pc) routes.push({ label, proxy: pc });
            } catch { /* group not available on this account */ }
        }
    }
    if (proxyConfiguration) routes.push({ label: 'no proxy (server IP)', proxy: undefined });
}
log.info(`Network routes: ${routes.map((r) => r.label).join(' → ')}`);
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();
const canCharge = (event) => !pricing.isPayPerEvent || charging.calculateMaxEventChargeCountWithinLimit(event) > 0;

const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null,
    saved: 0, transcripts: { fromCaptions: 0, fromAi: 0, unavailable: 0 }, failedRowsSaved: 0,
    chargedEvents: { [EVENT_POST]: 0, [EVENT_TRANSCRIPT]: 0 }, statusCounts: {}, skipReasons: {}, perInput: [],
    postTypes: {}, fillRates: null, requests: { requests: 0, blocked: 0, networkErrors: 0 }, routes: [],
};
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const client = new Client({ routes, msLeft, stats: summary.requests });
const fb = makeFacebook(client);

let seenStore = null;
let seenPrev = new Set();
if (opts.skipPreviouslyScraped) {
    seenStore = await Actor.openKeyValueStore(opts.dedupeStoreName);
    seenPrev = new Set((await seenStore.getValue('SEEN_POSTS')) ?? []);
    log.info(`Skip previous runs: ${seenPrev.size} posts remembered in "${opts.dedupeStoreName}".`);
}
const seenRun = new Set();

// ---------- Output ----------
let chain = Promise.resolve();
const FIX = {
    invalid_input: 'Use a public Facebook page or profile URL (facebook.com/name, profile.php?id=…) or a post, video or reel URL.',
    unsupported_input: 'Groups, events, hashtags and search need a logged-in account. Use public pages, profiles, posts, videos or reels.',
    not_found: 'Check the URL in a private browser window: the page, post or video may be deleted, renamed or not public.',
    no_timeline: 'The page loaded but shows no public posts to logged-out visitors (private profile, or an age/country-restricted page).',
    no_posts: 'No posts matched your date range or filters. Widen "Only posts newer than", or remove type / keyword / engagement filters.',
    blocked: `Facebook kept sending every attempt to its login page (routes tried: ${routes.map((r) => r.label).join(', ')}). Use RESIDENTIAL proxy and run again.`,
    error: 'Unexpected error. Run again; if it repeats, send the run log to the developer.',
};
function saveFailed(inputUrl, status, error, extra = {}) {
    bump(summary.statusCounts, status);
    if (!opts.includeFailedInputs) return chain;
    chain = chain.then(async () => {
        await Actor.pushData({ status, inputUrl, ...extra, error, fixHint: FIX[status] ?? FIX.error, scrapedAt: new Date().toISOString() }); // never charged
        summary.failedRowsSaved += 1;
    });
    return chain;
}

/** Saves one post (charged); returns false when the run has to stop. */
function save(row) {
    const p = chain.then(async () => {
        if (stopReason) return false;
        if (opts.maxResults && summary.saved >= opts.maxResults) {
            stop('max_results_reached');
            return false;
        }
        if (!canCharge(EVENT_POST)) {
            stop('max_cost_per_run_reached');
            return false;
        }
        const res = await Actor.pushData(row, EVENT_POST);
        summary.saved += 1;
        summary.chargedEvents[EVENT_POST] += res?.chargedCount ?? 0;
        if (row.transcript) {
            const t = await charging.charge({ eventName: EVENT_TRANSCRIPT });
            summary.chargedEvents[EVENT_TRANSCRIPT] += t?.chargedCount ?? 0;
            if (t?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        }
        bump(summary.statusCounts, 'ok');
        bump(summary.postTypes, row.postType);
        fill(row);
        if (seenStore) seenPrev.add(row.postId);
        if (res?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        if (opts.maxResults && summary.saved >= opts.maxResults) stop('max_results_reached');
        if (summary.saved % PROGRESS_EVERY === 0) {
            const min = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
            log.info(`Progress: ${summary.saved} posts saved, ${Math.round(summary.saved / min)}/min.`);
        }
        return true;
    });
    chain = p.then(() => {}, () => {});
    return p;
}

const FILL_FIELDS = ['text', 'time', 'url', 'likes', 'comments', 'shares', 'media', 'viewsCount', 'topComments', 'user'];
const fillCounts = {};
function fill(row) {
    for (const f of FILL_FIELDS) {
        const v = row[f];
        if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) bump(fillCounts, f);
    }
}

// ---------- One post ----------
function skipReason(row) {
    const t = row.timestamp ? row.timestamp * 1000 : null;
    if (seenRun.has(row.postId)) return 'duplicate_post';
    if (seenPrev.has(row.postId)) return 'seen_in_previous_run';
    if (newerThan && t !== null && t < newerThan.getTime()) return 'filtered_older_than_range';
    if (olderThan && t !== null && t > olderThan.getTime()) return 'filtered_newer_than_range';
    if (opts.postTypes.length && !opts.postTypes.includes(row.postType)) return 'filtered_post_type';
    if (opts.minReactions && (row.likes ?? 0) < opts.minReactions) return 'filtered_min_reactions';
    if (opts.minComments && (row.comments ?? 0) < opts.minComments) return 'filtered_min_comments';
    if (kwRes.length) {
        const hay = [row.text, row.linkTitle, row.sharedPost?.text].filter(Boolean).join('\n');
        const hits = kwRes.filter((x) => x.re.test(hay)).map((x) => x.k);
        if (!hits.length) return 'filtered_keywords';
        row.matchedKeywords = hits;
    }
    return null;
}

async function addVideo(row, video, session) {
    const v = row._video;
    let details = video ?? null;
    if (!details && v?.id && (opts.fetchVideoDetails || opts.includeVideoTranscript)) {
        try {
            details = await fb.loadVideo(v.id, session);
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            row.videoDetailsError = err.message;
        }
    }
    if (details) {
        const vr = storyToPost(details.story, {});
        row.videoTitle = details.title ?? null;
        row.viewsCount = row.viewsCount ?? details.views ?? vr.viewsCount ?? null;
        row.videoUrl = row.videoUrl ?? vr.videoUrl;
        row.videoDurationSec = row.videoDurationSec ?? vr.videoDurationSec;
        row.shares = row.shares ?? vr.shares;
        if (vr._video) row._video = { ...vr._video, ...Object.fromEntries(Object.entries(row._video ?? {}).filter(([, x]) => x)) };
        row.captionLanguages = details.captionLocales ?? [];
    }
    if (!opts.includeVideoTranscript || !row._video) return;
    if (!canCharge(EVENT_TRANSCRIPT)) return;
    const cap = details?.captionsUrl ?? row._video.captionsUrl;
    if (cap) {
        try {
            const segs = await fb.captions(cap, session);
            if (segs.length) {
                Object.assign(row, { transcript: segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), transcriptSource: 'captions', transcriptSegments: segs });
                summary.transcripts.fromCaptions += 1;
                return;
            }
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            row.transcriptError = `captions: ${err.message}`;
        }
    }
    if (opts.aiProvider === 'none') {
        row.transcriptError = row.transcriptError ?? 'no captions on this video (turn on AI transcription with your own key to transcribe it)';
        summary.transcripts.unavailable += 1;
        return;
    }
    const dur = row.videoDurationSec ?? row._video.durationSec;
    if (dur && dur > opts.aiMaxMinutes * 60) {
        row.transcriptError = `no captions; video is ${Math.round(dur / 60)} min — above your AI limit of ${opts.aiMaxMinutes} min`;
        summary.transcripts.unavailable += 1;
        return;
    }
    const src = row._video.sdUrl ?? row.videoUrl;
    if (!src) {
        row.transcriptError = 'no captions and no downloadable video file';
        summary.transcripts.unavailable += 1;
        return;
    }
    try {
        const file = await fb.downloadVideo(src, session, MAX_AUDIO_BYTES);
        const r = await transcribe(opts.aiProvider, opts.aiApiKey, file, 'video/mp4');
        if (r.segments.length) {
            Object.assign(row, { transcript: r.segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), transcriptSource: 'ai', transcriptLanguage: r.language, transcriptModel: r.model, transcriptSegments: r.segments });
            summary.transcripts.fromAi += 1;
            return;
        }
        row.transcriptError = 'AI found no speech in this video';
    } catch (err) {
        if (err instanceof StoppedError) throw err;
        if (err.badKey) {
            log.error(`AI provider rejected the API key (${err.message}). Turning AI transcription off for the rest of the run.`);
            opts.aiProvider = 'none';
        }
        row.transcriptError = `AI transcription failed: ${err.message}`;
    }
    summary.transcripts.unavailable += 1;
}

/** Builds, filters, enriches and saves one story. Returns the skip reason or 'saved' / 'stopped'. */
async function handleStory(story, ctx, session, video = null) {
    const row = storyToPost(story, { inputUrl: ctx.input, facebookUrl: ctx.facebookUrl, pageName: ctx.pageName, page: ctx.page, maxTopComments: opts.topCommentsPerPost });
    if (!row.postId) return 'no_post_id';
    const reason = skipReason(row);
    if (reason) {
        if (reason !== 'duplicate_post') seenRun.add(row.postId);
        bump(summary.skipReasons, reason);
        return reason;
    }
    seenRun.add(row.postId);
    if (row._video || video) {
        try {
            await addVideo(row, video, session);
        } catch (err) {
            if (err instanceof StoppedError) return 'stopped';
            throw err;
        }
    }
    if (!opts.topCommentsPerPost) delete row.topComments;
    delete row._video;
    row.status = 'ok';
    row.scrapedAt = new Date().toISOString();
    const ok = await save(row);
    return ok ? 'saved' : 'stopped';
}

// ---------- Pages ----------
let debugSaved = false;
async function scrapePage(t, rec) {
    const session = new Session();
    let page;
    try {
        page = await fb.loadPage(t.path, session);
    } catch (err) {
        if (err instanceof StoppedError) return;
        rec.error = err.message;
        const status = err.notFound ? 'not_found' : err.noTimeline ? 'no_timeline' : err instanceof BlockedError ? 'blocked' : 'error';
        await saveFailed(t.input, status, err.message);
        return;
    }
    const pageName = page.finalUrl?.match(/facebook\.com\/(?!profile\.php)([^/?#]+)/)?.[1] ?? (t.path.startsWith('profile.php') ? null : t.path);
    const ctx = { input: t.input, path: t.path, vars: page.vars, userId: page.userId, pageName, facebookUrl: `https://www.facebook.com/${pageName ?? `profile.php?id=${page.userId}`}`, page: page.header };
    rec.page = { id: page.userId, name: page.header.name, followers: page.header.followers };
    let olderStreak = 0;
    const consume = async (stories) => {
        for (const s of stories) {
            if (rec.saved >= opts.resultsLimit || stopReason) return false;
            const r = await handleStory(s, ctx, session);
            rec.seen += 1;
            if (r === 'saved') rec.saved += 1;
            else if (r !== 'stopped') bump(rec.skipped, r);
            olderStreak = r === 'filtered_older_than_range' ? olderStreak + 1 : 0;
            if (olderStreak >= OLDER_STREAK_TO_STOP) {
                rec.stopReason = 'reached_posts_older_than_date';
                return false;
            }
        }
        return true;
    };
    let more = await consume(page.stories);
    let cursor = page.cursor;
    let hasNext = page.hasNext;
    let emptyPages = 0;
    while (more && hasNext && cursor && rec.saved < opts.resultsLimit && !stopReason) {
        let res;
        try {
            res = await fb.timelinePage(ctx, cursor, session, TIMELINE_COUNT);
            rec.pages += 1;
        } catch (err) {
            if (err instanceof StoppedError) return;
            rec.error = `pagination stopped after ${rec.pages} pages: ${err.message}`;
            rec.stopReason = err instanceof BlockedError ? 'blocked' : 'error';
            log.warning(`${t.input}: ${rec.error}`);
            if (!rec.saved) await saveFailed(t.input, err instanceof BlockedError ? 'blocked' : 'error', rec.error);
            return;
        }
        emptyPages = res.stories.length ? 0 : emptyPages + 1;
        if (!res.stories.length && !debugSaved) { // unexpected answer: keep a sample so the parser can be fixed quickly
            debugSaved = true;
            await Actor.setValue('DEBUG_TIMELINE_RESPONSE', { input: t.input, cursor, hasNext: res.hasNext, sample: res.raw }).catch(() => {});
            log.warning(`${t.input}: a timeline page came back without posts — a sample was saved as DEBUG_TIMELINE_RESPONSE.`);
        }
        if (emptyPages >= 2) break;
        more = await consume(res.stories);
        if (res.cursor === cursor) break;
        cursor = res.cursor;
        hasNext = res.hasNext;
    }
    rec.stopReason = rec.stopReason ?? (stopReason ? stopReason : rec.saved >= opts.resultsLimit ? 'results_limit_reached' : 'no_more_posts');
    if (!rec.saved && !stopReason) await saveFailed(t.input, 'no_posts', `${rec.seen} posts checked, none matched (${JSON.stringify(rec.skipped)})`, { pageName: page.header.name });
}

// ---------- Single posts / videos ----------
async function scrapeSingle(t, rec) {
    const session = new Session();
    try {
        let story;
        let video = null;
        if (t.kind === 'video') {
            video = await fb.loadVideo(t.videoId, session, { reel: /\/reels?\//.test(t.input) });
            story = video.story;
        } else {
            const r = await fb.loadPost(t.url, t.postId, session);
            if (r.redirectVideo) {
                video = await fb.loadVideo(r.redirectVideo, session);
                story = video.story;
            } else story = r.story;
        }
        const res = await handleStory(story, { input: t.input, facebookUrl: null, pageName: null, page: null }, session, video);
        if (res === 'saved') rec.saved += 1;
        else if (res !== 'stopped') bump(rec.skipped, res);
    } catch (err) {
        if (err instanceof StoppedError) return;
        rec.error = err.message;
        await saveFailed(t.input, err.notFound ? 'not_found' : err instanceof BlockedError ? 'blocked' : 'error', err.message);
    }
}

// ---------- Run ----------
const pages = [];
const singles = [];
const seenInputs = new Set();
for (const raw of opts.startUrls) {
    const t = parseFacebookInput(raw);
    if (!t) continue;
    if (t.invalid) {
        await saveFailed(t.input, t.status ?? 'invalid_input', t.error);
        continue;
    }
    const key = t.kind === 'page' ? `page:${t.path.toLowerCase()}` : t.kind === 'video' ? `video:${t.videoId}` : `post:${t.url}`;
    if (seenInputs.has(key)) {
        bump(summary.skipReasons, 'duplicate_input');
        continue;
    }
    seenInputs.add(key);
    (t.kind === 'page' ? pages : singles).push(t);
}
log.info(`${pages.length} page(s) (up to ${opts.resultsLimit} posts each) and ${singles.length} single post/video URL(s). Filters: ${[newerThan && `newer than ${newerThan.toISOString().slice(0, 10)}`, olderThan && `older than ${olderThan.toISOString().slice(0, 10)}`, opts.postTypes.length && `types ${opts.postTypes.join('/')}`, kwRes.length && `keywords ${opts.keywords.join(', ')}`, opts.minReactions && `≥${opts.minReactions} reactions`, opts.minComments && `≥${opts.minComments} comments`].filter(Boolean).join(', ') || 'none'}.`);

const newRec = (t) => {
    const rec = { input: t.input, kind: t.kind, saved: 0, seen: 0, pages: 0, skipped: {}, stopReason: null };
    summary.perInput.push(rec);
    return rec;
};
async function pool(items, concurrency, fn) {
    const queue = [...items];
    const runOne = async (t) => {
        try {
            await fn(t);
        } catch (err) {
            if (err instanceof StoppedError) return;
            log.exception(err, `Unexpected error for ${t.input}`);
            await saveFailed(t.input, 'error', err.message);
        }
    };
    if (queue.length && !stopReason) await runOne(queue.shift()); // the first one runs alone so route problems are found before fan-out
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length && !stopReason && msLeft() > 0) await runOne(queue.shift());
    }));
}
await pool(pages, PAGE_CONCURRENCY, (t) => scrapePage(t, newRec(t)));
await pool(singles, POST_CONCURRENCY, (t) => scrapeSingle(t, newRec(t)));
await chain;

// ---------- Summary ----------
summary.stopReason = stopReason ?? 'completed';
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.routes = client.routesSummary();
summary.fillRates = summary.saved ? Object.fromEntries(FILL_FIELDS.map((f) => [f, `${Math.round(((fillCounts[f] ?? 0) / summary.saved) * 100)}%`])) : null;
await Actor.setValue('RUN_SUMMARY', summary);
if (seenStore) await seenStore.setValue('SEEN_POSTS', [...seenPrev]);
const msg = `Saved ${summary.saved} posts from ${pages.length} page(s) and ${singles.length} URL(s)${summary.chargedEvents[EVENT_TRANSCRIPT] ? `, ${summary.chargedEvents[EVENT_TRANSCRIPT]} with transcripts` : ''}. ${summary.failedRowsSaved} inputs without posts (not charged). Stop reason: ${summary.stopReason}.`;
log.info(msg);
await Actor.exit({ statusMessage: msg });
