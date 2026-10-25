// Facebook: input parsing, page load (first posts + session tokens), timeline pagination via GraphQL, single posts and videos.
import { BlockedError, PAGE_HEADERS, BROWSER_UA } from './http.js';
import { relayResultsFromHtml, relayResultsFromGraphql, assemble, findKey, findAll, find, jsonAt, deepMerge } from './relay.js';
import { storiesIn, parseCount } from './parse.js';

export const FB = process.env.FB_BASE ?? 'https://www.facebook.com';
/** Absolute facebook.com URL -> the base this run talks to (FB_BASE is only set by the test mock). */
export const fbUrl = (u) => (FB === 'https://www.facebook.com' ? u : String(u).replace(/^https:\/\/(www\.)?facebook\.com/, FB));
// Logged-out Relay operation for the next pages of a timeline (verified Oct 2026; overridable if Facebook rotates it).
const TIMELINE_DOC_ID = process.env.FB_TIMELINE_DOC_ID ?? '29136684006021408';
const TIMELINE_QUERY = 'ProfileCometTimelineFeedRefetchQuery';

// ---------- Input parsing ----------

const RESERVED = new Set(['watch', 'reel', 'reels', 'groups', 'events', 'marketplace', 'gaming', 'hashtag', 'search', 'login', 'login.php', 'help', 'policies', 'privacy', 'settings', 'stories', 'photo', 'photo.php', 'permalink.php', 'story.php', 'share', 'sharer', 'sharer.php', 'profile.php', 'people', 'pages', 'pg', 'business', 'ads', 'messages', 'notifications', 'friends', 'bookmarks', 'video.php', 'l.php', 'dialog', 'plugins', 'home.php', 'fundraisers']);

/**
 * @returns {{kind:'page', path:string, input:string} | {kind:'post', url:string, postId?:string, input:string} | {kind:'video', videoId:string, input:string} | {invalid:true, input:string, error:string, status?:string}}
 */
export function parseFacebookInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return null;
    if (/^[\w.-]{3,80}$/.test(input) && !/^\d+$/.test(input) && !RESERVED.has(input.toLowerCase())) return { kind: 'page', path: input, input };
    if (/^\d{6,20}$/.test(input)) return { kind: 'page', path: `profile.php?id=${input}`, input };
    let u;
    try {
        u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return { invalid: true, input, error: 'not a Facebook URL or page name' };
    }
    const host = u.hostname.toLowerCase().replace(/^(www|m|mbasic|web|touch|business|free|lm|l)\./, '');
    if (!/^(facebook\.com|fb\.com|fb\.watch|[a-z]{2}-[a-z]{2}\.facebook\.com)$/.test(host)) return { invalid: true, input, error: 'not a facebook.com URL' };
    const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const q = u.searchParams;
    const s0 = (seg[0] ?? '').toLowerCase();
    if (host === 'fb.watch') return { kind: 'post', url: `https://fb.watch/${seg[0] ?? ''}/`, input };
    if (s0 === 'groups') return { invalid: true, status: 'unsupported_input', input, error: 'Facebook groups need a logged-in account — this actor scrapes public pages and profiles only.' };
    if (s0 === 'watch' && /^\d+$/.test(q.get('v') ?? '')) return { kind: 'video', videoId: q.get('v'), input };
    if ((s0 === 'reel' || s0 === 'reels') && /^\d+$/.test(seg[1] ?? '')) return { kind: 'video', videoId: seg[1], input };
    if (seg[1] === 'videos' && /^\d+$/.test(seg.at(-1) ?? '')) return { kind: 'video', videoId: seg.at(-1), input };
    if (s0 === 'video.php' && /^\d+$/.test(q.get('v') ?? '')) return { kind: 'video', videoId: q.get('v'), input };
    if (s0 === 'share' && seg[1]) return { kind: 'post', url: `https://www.facebook.com/share/${seg.slice(1).join('/')}/`, input };
    if (s0 === 'permalink.php' || s0 === 'story.php') {
        const sid = q.get('story_fbid');
        const id = q.get('id');
        if (sid && id) return { kind: 'post', url: /^\d+$/.test(sid) ? `https://www.facebook.com/${id}/posts/${sid}` : `https://www.facebook.com/permalink.php?story_fbid=${sid}&id=${id}`, postId: /^\d+$/.test(sid) ? sid : undefined, input };
    }
    if ((s0 === 'photo' || s0 === 'photo.php') && /^\d+$/.test(q.get('fbid') ?? '')) return { kind: 'post', url: `https://www.facebook.com/photo/?fbid=${q.get('fbid')}`, input };
    if (seg[1] === 'posts' && seg[2]) return { kind: 'post', url: `https://www.facebook.com/${seg[0]}/posts/${seg[2]}`, postId: /^\d+$/.test(seg[2]) ? seg[2] : undefined, input };
    if (seg[1] === 'photos' && seg.length >= 3) return { kind: 'post', url: `https://www.facebook.com/${seg.join('/')}`, input };
    if (s0 === 'profile.php' && /^\d+$/.test(q.get('id') ?? '')) return { kind: 'page', path: `profile.php?id=${q.get('id')}`, input };
    if (s0 === 'people' && /^\d+$/.test(seg[2] ?? '')) return { kind: 'page', path: `profile.php?id=${seg[2]}`, input };
    if ((s0 === 'pg' || s0 === 'pages') && seg[1]) {
        const id = seg.find((x) => /^\d{6,}$/.test(x));
        return { kind: 'page', path: id && s0 === 'pages' ? `profile.php?id=${id}` : seg[1], input };
    }
    if (seg[0] && !RESERVED.has(s0) && /^[\w.-]+$/.test(seg[0])) return { kind: 'page', path: seg[0], input };
    return { invalid: true, input, error: 'unsupported Facebook URL — use a page/profile URL or a post, video or reel URL' };
}

// ---------- Page load ----------

function tokensFrom(html) {
    const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] ?? html.match(/name="lsd" value="([^"]+)"/)?.[1] ?? null;
    let jz = 0;
    for (const c of lsd ?? '') jz += c.charCodeAt(0);
    return {
        lsd,
        rev: html.match(/"server_revision":(\d+)/)?.[1] ?? null,
        hsi: html.match(/"hsi":"(\d+)"/)?.[1] ?? null,
        hs: html.match(/"haste_session":"([^"]+)"/)?.[1] ?? null,
        spinT: html.match(/"__spin_t":(\d+)/)?.[1] ?? null,
        datr: html.match(/"_js_datr":\{"value":"([^"]+)"/)?.[1] ?? null,
        jazoest: lsd ? `2${jz}` : null,
    };
}

/** Variables of the timeline query the page preloaded (so pagination asks for exactly the same fields). */
function timelineVariables(html) {
    const qi = html.indexOf('"queryName":"ProfileCometTimelineFeedQuery"');
    if (qi < 0) return null;
    const vi = html.lastIndexOf('"variables":', qi);
    return vi < 0 ? null : jsonAt(html, vi + 12);
}

function pageInfoOf(roots) {
    for (const r of roots) {
        const unit = findKey(r, 'timeline_list_feed_units', new Set(), (v) => v && typeof v === 'object');
        const pi = unit?.page_info;
        if (pi && (pi.end_cursor || pi.has_next_page === false)) return { cursor: pi.end_cursor ?? null, hasNext: pi.has_next_page !== false && Boolean(pi.end_cursor) };
    }
    return { cursor: null, hasNext: false };
}

/** Page header facts from the page HTML (best effort). */
function headerFrom(html, roots) {
    const og = (p) => html.match(new RegExp(`<meta property="og:${p}" content="([^"]*)"`))?.[1] ?? null;
    const followersText = html.match(/"text":"([\d.,]+[KMB]?) followers"/)?.[1] ?? html.match(/([\d.,]+[KMB]?) followers/)?.[1] ?? null;
    const likesText = html.match(/"text":"([\d.,]+[KMB]?) likes"/)?.[1] ?? null;
    const user = roots.map((r) => r.user).find((u) => u?.id) ?? null;
    const delegate = findKey(roots, 'delegate_page', new Set(), (d) => d?.id);
    const name = user?.name ?? findKey(roots, 'profile_header_renderer', new Set(), (x) => x?.user?.name)?.user?.name ?? og('title')?.replace(/ \| .*$/, '') ?? null;
    return {
        id: user?.id ?? null,
        name: name ? name.replace(/&amp;/g, '&').replace(/&#039;/g, "'") : null,
        followers: parseCount(followersText),
        followersText: followersText ? `${followersText} followers` : null,
        likes: parseCount(likesText),
        profilePic: og('image')?.replace(/&amp;/g, '&') ?? null,
        pageAdLibraryId: delegate?.id ?? null,
        isBusinessPageActive: delegate?.is_business_page_active ?? null,
    };
}

export function makeFacebook(client) {
    const getPage = (url, session) => client.fetch({ url, headers: PAGE_HEADERS }, session).then(async (r) => {
        const html = String(r.body);
        const tokens = tokensFrom(html);
        if (tokens.datr) {
            try {
                await session.jar.setCookie(`datr=${tokens.datr}; Domain=.facebook.com; Path=/; Secure`, 'https://www.facebook.com/');
            } catch { /* mock hosts */ }
        }
        session.tokens = tokens;
        return { html, finalUrl: r.url, tokens };
    });

    /** Loads a page/profile: its first post(s), the cursor for the next ones and the header. */
    async function loadPage(path, session) {
        const { html, finalUrl } = await getPage(`${FB}/${path}`, session);
        const vars = timelineVariables(html);
        const roots = assemble(relayResultsFromHtml(html));
        if (!vars) {
            if (/content isn't available|This page isn't available|"isContentUnavailable":true|<title>Page not found/i.test(html)) throw Object.assign(new Error('page or profile not found (or not public)'), { notFound: true });
            // A page that loaded but has no timeline: private profile, restricted page, or an unexpected layout.
            throw Object.assign(new Error('no public timeline on this page (private profile, age/country-restricted page, or not a page)'), { noTimeline: true });
        }
        const stories = roots.flatMap(storiesIn);
        const header = headerFrom(html, roots);
        return { userId: vars.userID ?? header.id, vars, stories, ...pageInfoOf(roots), header, finalUrl };
    }

    /**
     * Next timeline page. The cursor survives IP changes: on a block the session rotates, the page is reloaded on the new IP
     * for fresh tokens (`prepare`), and the same cursor is requested again.
     */
    async function timelinePage(ctx, cursor, session, count = 3) {
        const r = await client.fetch({
            url: `${FB}/api/graphql/`,
            method: 'POST',
            headers: { 'user-agent': BROWSER_UA, 'content-type': 'application/x-www-form-urlencoded', accept: '*/*', 'accept-language': 'en-US,en;q=0.9', origin: 'https://www.facebook.com', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-fb-friendly-name': TIMELINE_QUERY, 'x-asbd-id': '359341' },
            prepare: async (s) => {
                if (!s.tokens?.lsd) await getPage(`${FB}/${ctx.path}`, s);
                const t = s.tokens;
                const variables = { ...ctx.vars, count, cursor, id: ctx.userId };
                delete variables.userID;
                const body = new URLSearchParams({
                    av: '0', __aaid: '0', __user: '0', __a: '1', __req: '1', __hs: t.hs ?? '', dpr: '1', __ccg: 'EXCELLENT', __rev: t.rev ?? '', __hsi: t.hsi ?? '', __comet_req: '15',
                    lsd: t.lsd ?? '', jazoest: t.jazoest ?? '', __spin_r: t.rev ?? '', __spin_b: 'trunk', __spin_t: t.spinT ?? '',
                    fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: TIMELINE_QUERY, variables: JSON.stringify(variables), server_timestamps: 'true', doc_id: TIMELINE_DOC_ID,
                });
                return { body: body.toString(), headers: { 'x-fb-lsd': t.lsd ?? '', referer: `https://www.facebook.com/${ctx.path}` } };
            },
        }, session);
        const results = relayResultsFromGraphql(r.body);
        const err = results.find((x) => x.errors && !x.data)?.errors?.[0];
        if (err) {
            if (/rate limit|1675004/i.test(`${err.message} ${err.code}`)) throw new BlockedError('Facebook rate limit for this IP');
            throw new Error(`timeline query failed: ${err.message ?? JSON.stringify(err).slice(0, 200)}`);
        }
        if (!results.length) throw new BlockedError(`timeline query returned no data (HTTP ${r.status})`);
        const roots = assemble(results);
        return { stories: roots.flatMap(storiesIn), ...pageInfoOf(roots), raw: String(r.body).slice(0, 60000) };
    }

    /** A single post page (posts/, permalink, photo, share links). */
    async function loadPost(url, postId, session) {
        const { html, finalUrl } = await getPage(fbUrl(url), session);
        const roots = assemble(relayResultsFromHtml(html));
        const stories = roots.flatMap(storiesIn);
        const story = (postId && stories.find((s) => s.post_id === postId)) ?? stories.find((s) => s.comet_sections?.feedback) ?? stories[0] ?? null;
        if (!story) {
            const video = /\/(videos|reel|watch)\b/.test(finalUrl) ? (finalUrl.match(/(?:videos\/|reel\/|v=)(\d+)/)?.[1] ?? null) : null;
            if (video) return { redirectVideo: video };
            if (/content isn't available|This content isn't available|"isContentUnavailable":true/i.test(html)) throw Object.assign(new Error('post not found, deleted, or not public'), { notFound: true });
            throw Object.assign(new Error('post not found, deleted, or not public'), { notFound: true });
        }
        return { story, finalUrl };
    }

    /**
     * A video or reel via its watch page: builds a Story-shaped object (text, author, time, feedback) plus full video details
     * (title, views, duration, video URLs, captions).
     */
    async function loadVideo(videoId, session, { reel = false } = {}) {
        const { html, finalUrl } = await getPage(`${FB}/watch/?v=${videoId}`, session);
        const roots = assemble(relayResultsFromHtml(html));
        const objs = roots.flatMap((r) => findAll(r, (o) => o.id === videoId, { stopAtMatch: false }));
        if (!objs.length) throw Object.assign(new Error('video not found, deleted, or not public'), { notFound: true });
        const merged = objs.reduce((a, o) => deepMerge(a, o), {});
        const delivery = merged.videoDeliveryLegacyFields ?? {};
        const creation = objs.map((o) => o.creation_story).find((c) => c && (findKey(c, 'post_id') || c.message)) ?? {};
        const feedback = objs.map((o) => o.feedback).find((f) => f && (f.reaction_count || f.comment_rendering_instance || f.total_comment_count !== undefined)) ?? findKey(creation, 'feedback', new Set(), (f) => f?.unified_reactors || f?.total_comment_count !== undefined) ?? {};
        const views = feedback.video_view_count_renderer?.feedback?.video_view_count ?? findKey(objs, 'video_view_count', new Set(), (v) => typeof v === 'number') ?? findKey(objs, 'play_count', new Set(), (v) => typeof v === 'number') ?? null;
        const captions = merged.captions_url ?? findKey(objs, 'captions_url', new Set(), (v) => typeof v === 'string') ?? null;
        const captionLocales = merged.video_available_captions_locales ?? [];
        const actors = findKey(creation, 'actors', new Set(), (a) => Array.isArray(a) && a.length) ?? (merged.owner ? [merged.owner] : []);
        const reelReact = findKey(creation, 'fb_reel_react_button')?.story?.feedback;
        const story = {
            __typename: 'Story',
            post_id: findKey(creation, 'post_id', new Set(), (v) => typeof v === 'string') ?? videoId,
            creation_time: findKey(creation, 'creation_time', new Set(), (v) => typeof v === 'number') ?? merged.publish_time ?? null,
            comet_sections: creation.comet_sections,
            message: creation.message ?? findKey(creation, 'message', new Set(), (m) => typeof m?.text === 'string') ?? null,
            actors,
            feedback: { id: feedback.id ?? null },
            ufi: {
                comet_ufi_summary_and_actions_renderer: {
                    feedback: {
                        ...feedback,
                        reaction_count: feedback.reaction_count ?? (reelReact?.unified_reactors ? { count: reelReact.unified_reactors.count } : undefined),
                        share_count: feedback.share_count ?? (creation.feedback?.share_count_reduced ? { count: parseCount(creation.feedback.share_count_reduced) } : undefined),
                    },
                },
                comment_rendering_instance: feedback.comment_rendering_instance ?? (creation.feedback?.total_comment_count !== undefined ? { comments: { total_count: creation.feedback.total_comment_count } } : undefined),
            },
            attachments: [{ media: { __typename: 'Video', id: videoId, permalink_url: merged.permalink_url ?? finalUrl, browser_native_hd_url: delivery.browser_native_hd_url ?? merged.browser_native_hd_url, browser_native_sd_url: delivery.browser_native_sd_url ?? merged.browser_native_sd_url, length_in_second: merged.length_in_second, playable_duration_in_ms: merged.playable_duration_in_ms, preferred_thumbnail: merged.preferred_thumbnail, thumbnailImage: merged.thumbnailImage, play_count: typeof views === 'number' ? views : null, captions_url: captions } }],
            url: merged.permalink_url ?? finalUrl,
        };
        if (reel || /\/reel\//.test(finalUrl) || creation.short_form_video_context) story.url = `https://www.facebook.com/reel/${videoId}`;
        return { story, title: merged.title?.text ?? null, views, captionsUrl: captions, captionLocales: captionLocales.map((c) => c?.locale ?? c).filter(Boolean), finalUrl };
    }

    /** Downloads a caption file (SRT / WebVTT / XML) and returns [{text,start,dur}]. */
    async function captions(url, session) {
        const r = await client.fetch({ url, headers: { 'user-agent': BROWSER_UA }, attempts: 2 }, session);
        return parseCaptionFile(String(r.body));
    }

    async function downloadVideo(url, session, maxBytes) {
        const r = await client.fetch({ url, headers: { 'user-agent': BROWSER_UA }, responseType: 'buffer', timeoutMs: 120000, attempts: 2 }, session);
        if (r.status >= 400) throw new Error(`video download HTTP ${r.status}`);
        if (r.body.length > maxBytes) throw new Error(`video file is ${Math.round(r.body.length / 1e6)} MB — above the ${Math.round(maxBytes / 1e6)} MB AI limit`);
        return r.body;
    }

    return { loadPage, timelinePage, loadPost, loadVideo, captions, downloadVideo };
}

const toSec = (t) => {
    const m = t.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

/** SRT / WebVTT / simple XML caption file -> segments. */
export function parseCaptionFile(body) {
    const out = [];
    const b = body.replace(/\r/g, '');
    if (/-->/.test(b)) {
        for (const block of b.split(/\n{2,}/)) {
            const lines = block.split('\n').filter(Boolean);
            const ti = lines.findIndex((l) => l.includes('-->'));
            if (ti < 0) continue;
            const [a, z] = lines[ti].split('-->');
            const text = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (text) out.push({ text, start: Math.round(toSec(a) * 1000) / 1000, dur: Math.round((toSec(z) - toSec(a)) * 1000) / 1000 });
        }
        return out;
    }
    for (const m of b.matchAll(/<(?:p|text)\b([^>]*)>([\s\S]*?)<\/(?:p|text)>/g)) {
        const start = Number(m[1].match(/(?:start|begin|t)="([\d.]+)/)?.[1] ?? NaN);
        const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (text && Number.isFinite(start)) out.push({ text, start, dur: Number(m[1].match(/(?:dur|d)="([\d.]+)/)?.[1] ?? 0) });
    }
    return out;
}

export { find };
