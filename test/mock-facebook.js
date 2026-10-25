// Local stand-in for facebook.com: page HTML with preloaded Relay data, /api/graphql/ timeline pagination (Relay incremental
// format), post pages, watch pages, captions, video files, Whisper. Stories are clones of a real Facebook story (Oct 2026).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { findKey } from '../src/relay.js';

const TEMPLATE = readFileSync(new URL('./fixtures/story-template.json', import.meta.url), 'utf8');
const T = JSON.parse(TEMPLATE);
const T_ID = T.post_id;
const T_TIME = String(findKey(T, 'creation_time'));
const T_TEXT = T.comet_sections.content.story.message.text;
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

const PAGES = {
    newsroom: { id: '100000000000001', name: 'Newsroom Daily', followers: '1.2M', count: 40 },
    quietpage: { id: '100000000000002', name: 'Quiet Page', followers: '850', count: 2 },
};
const TYPES = ['photo', 'video', 'link', 'text', 'shared', 'album', 'photo', 'text'];

/** Post n (0 = newest) of a page. */
function postSpec(page, n) {
    const p = PAGES[page];
    const id = `${p.id.slice(-4)}${String(900000000 + n)}`;
    const type = page === 'newsroom' ? TYPES[n % TYPES.length] : 'text';
    const text = `Post ${n} from ${p.name}: ${n % 3 === 0 ? 'Climate report #climate #science' : n % 3 === 1 ? 'Election update and AI news #ai' : 'Weekend reading list'}${n === 4 ? ' — mention @Some Person' : ''}`;
    return { page, n, id, type, text, time: NOW - n * DAY - 3600, likes: 1000 - n * 20, comments: 50 - n, shares: 30 - (n % 30), videoId: `77${id}` };
}

function setDeep(story, spec) {
    const ufi = findKey(story, 'comet_ufi_summary_and_actions_renderer').feedback;
    ufi.reaction_count = { count: spec.likes, is_empty: false };
    ufi.share_count = { count: spec.shares, is_empty: false };
    ufi.i18n_reaction_count = String(spec.likes);
    ufi.top_reactions = { count: 2, edges: [{ reaction_count: spec.likes - 10, node: { id: '1635855486666999', localized_name: 'Like' } }, { reaction_count: 10, node: { id: '1678524932434102', localized_name: 'Love' } }] };
    findKey(story, 'comment_rendering_instance').comments.total_count = spec.comments;
    const content = story.comet_sections.content.story;
    const ranges = spec.text.includes('#ai') ? [{ offset: spec.text.indexOf('#ai'), length: 3, entity: { __typename: 'Hashtag', url: 'https://www.facebook.com/hashtag/ai?__eep__=6', id: '1' } }] : [];
    content.message = { __typename: 'TextWithEntities', text: spec.text, ranges };
    content.comet_sections.message.story.message = { text: spec.text, ranges };
    const photo = (k) => ({ __typename: 'Photo', id: `${spec.id}${k}`, url: `https://www.facebook.com/photo/?fbid=${spec.id}${k}`, photo_image: { uri: `https://scontent.example/${spec.id}_${k}.jpg`, height: 720, width: 1280 }, accessibility_caption: `May be an image of item ${k}` });
    let atts;
    if (spec.type === 'photo') atts = [{ styles: { __typename: 'StoryAttachmentPhotoStyleRenderer', attachment: { media: photo(1) } }, media: { __typename: 'Photo', id: `${spec.id}1` } }];
    else if (spec.type === 'album') atts = [{ styles: { attachment: { all_subattachments: { count: 3, nodes: [1, 2, 3].map((k) => ({ media: photo(k) })) } } } }];
    else if (spec.type === 'video') atts = [{ styles: { attachment: { media: { __typename: 'Video', id: spec.videoId, url: `https://www.facebook.com/watch/?v=${spec.videoId}`, playable_duration_in_ms: 61000, preferred_thumbnail: { image: { uri: `https://scontent.example/${spec.videoId}.jpg` } } } } }, media: { __typename: 'Video', id: spec.videoId } }];
    else if (spec.type === 'link') atts = [{ styles: { attachment: { url: `https://news.example.com/story-${spec.n}`, title_with_entities: { text: `Headline ${spec.n}` }, story_attachment_link_renderer: { attachment: { web_link: { url: `https://news.example.com/story-${spec.n}` } } } } } }];
    else atts = [];
    story.attachments = atts;
    content.attachments = atts;
    if (spec.type === 'shared') content.attached_story = { __typename: 'Story', id: 'shared', post_id: '555000111', message: { text: 'The original shared post' }, actors: [{ __typename: 'User', id: '42', name: 'Original Author', url: 'https://www.facebook.com/original' }], url: 'https://www.facebook.com/original/posts/555000111' };
    return story;
}

function storyFor(spec, actor) {
    let j = TEMPLATE.split(T_ID).join(spec.id).split(T_TIME).join(String(spec.time)).split(JSON.stringify(T_TEXT).slice(1, -1)).join('x');
    j = j.replace(/"name":"CERN"/g, `"name":${JSON.stringify(actor.name)}`).replace(/"id":"100064792144187"/g, `"id":"${actor.id}"`).replace(/facebook\.com\\?\/cern/g, `facebook.com/${actor.slug}`);
    return setDeep(JSON.parse(j), spec);
}

const bbox = (result) => `<script type="application/json" data-sjs>${JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_x', { __bbox: { complete: true, result } }]]] } }]]] })}</script>`;
const html = (head, body) => `<!DOCTYPE html><html><head><title>${head}</title><meta property="og:image" content="https://scontent.example/pic.jpg" /></head><body>${body}</body></html>`;

export async function startMock({ rateLimitEvery = 0, loginWallFirst = 0, delayMs = 0 } = {}) {
    const hits = {};
    const hit = (k) => { hits[k] = (hits[k] ?? 0) + 1; };
    const tokens = new Set();
    const sessionHits = {};
    let base;
    let gqlCount = 0;
    const send = (res, code, body, type = 'text/html; charset=utf-8', headers = {}) => {
        res.writeHead(code, { 'content-type': type, ...headers });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
    const actorOf = (page) => ({ id: PAGES[page].id, name: PAGES[page].name, slug: page });

    function pageHtml(page) {
        const p = PAGES[page];
        const lsd = `LSD${Math.random().toString(36).slice(2, 10)}`;
        tokens.add(lsd);
        const first = storyFor(postSpec(page, 0), actorOf(page));
        const vars = { count: 1, feedbackSource: 0, feedLocation: 'TIMELINE', omitPinnedPost: true, renderLocation: 'timeline', scale: 1, userID: p.id };
        return html(`${p.name} | Facebook`,
            `<script>requireLazy(["Bootloader"],function(){});"LSD",[],{"token":"${lsd}"}; "server_revision":1051645477, "hsi":"7700509417621804741", "haste_session":"20751.HYP", "__spin_t":1792914564, "deferredCookies":{"_js_datr":{"value":"datr${lsd}","expiration_for_js":1}}</script>`
            + `<script>{"expectedPreloaders":[{"actorID":"0","preloaderID":"adp_x","queryID":"29762948859990584","variables":${JSON.stringify(vars)},"queryName":"ProfileCometTimelineFeedQuery"}]}</script>`
            + `<div>"text":"${p.followers} followers"</div>`
            + bbox({ data: { user: { id: p.id, name: p.name, delegate_page: { id: `9${p.id}`, is_business_page_active: true } } } })
            + bbox({ data: { user: { id: p.id, timeline_list_feed_units: { edges: [{ node: first, cursor: 'c0' }] } } }, extensions: {} })
            + bbox({ label: 'ProfileCometTimelineFeed_user$defer$ProfileCometTimelineFeed_user_timeline_list_feed_units$page_info', path: ['user', 'timeline_list_feed_units'], data: { page_info: { end_cursor: p.count > 1 ? `cur:${page}:1` : null, has_next_page: p.count > 1 } } }));
    }

    function videoHtml(videoId, page = 'newsroom') {
        const n = Number(String(videoId).slice(-3)) % 1000;
        const spec = postSpec(page, n);
        const withCaptions = n % 16 === 1; // post 1 has captions, post 9 does not
        const video = {
            __typename: 'Video', id: videoId, title: { text: `Video ${n} title` }, permalink_url: `https://www.facebook.com/${page}/videos/${videoId}/`,
            owner: { __typename: 'User', id: PAGES[page].id, name: PAGES[page].name },
            creation_story: { post_id: spec.id, creation_time: spec.time, message: { text: spec.text }, comet_sections: { title: { story: { post_id: spec.id, actors: [{ __typename: 'User', id: PAGES[page].id, name: PAGES[page].name, url: `https://www.facebook.com/${page}` }] } } } },
            feedback: { id: `fb${videoId}`, reaction_count: { count: spec.likes }, top_reactions: { count: 1, edges: [{ reaction_count: spec.likes, node: { localized_name: 'Like' } }] }, comment_rendering_instance: { comments: { total_count: spec.comments } }, video_view_count_renderer: { feedback: { video_view_count: 50000 + n } } },
            length_in_second: 61, videoDeliveryLegacyFields: { browser_native_sd_url: `${base}/video/${videoId}.mp4`, browser_native_hd_url: `${base}/video/${videoId}.mp4?hd=1` },
            captions_url: withCaptions ? `${base}/captions/${videoId}.srt` : null, video_available_captions_locales: withCaptions ? [{ locale: 'en_US' }] : [],
        };
        return html(`${video.title.text} | Facebook`, bbox({ data: { video } }));
    }

    const server = http.createServer(async (req, res) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const u = new URL(req.url, 'http://x');
        const path = u.pathname;
        const body = await readBody(req);
        const sid = req.headers.cookie ?? 'none';
        if (path.startsWith('/login')) return send(res, 200, html('Log in to Facebook', '<form id="login_form"></form>'));
        if (loginWallFirst && req.method === 'GET' && !path.startsWith('/captions') && !path.startsWith('/video/')) {
            sessionHits[sid] = (sessionHits[sid] ?? 0) + 1;
            if (!req.headers.cookie && (hits.wall ?? 0) < loginWallFirst) { hit('wall'); return send(res, 302, '', 'text/html', { location: `/login/?next=${encodeURIComponent(path)}` }); }
        }
        if (path === '/api/graphql/') {
            hit('graphql');
            gqlCount += 1;
            const f = new URLSearchParams(body);
            if (rateLimitEvery && gqlCount % rateLimitEvery === 0) return send(res, 200, '{"errors":[{"message":"Rate limit exceeded","severity":"CRITICAL","code":1675004}]}', 'application/json');
            if (!tokens.has(f.get('lsd')) || req.headers['x-fb-lsd'] !== f.get('lsd') || f.get('doc_id') !== '29136684006021408') return send(res, 200, '{"errors":[{"message":"A server error noncoercible_variable_value occured."}]}', 'application/json');
            const v = JSON.parse(f.get('variables'));
            const [, page, start] = String(v.cursor).split(':');
            const p = Object.entries(PAGES).find(([k]) => k === page);
            if (!p || v.id !== p[1].id) return send(res, 200, '{"errors":[{"message":"bad id"}]}', 'application/json');
            const from = Number(start);
            const to = Math.min(p[1].count, from + Number(v.count));
            const stories = [];
            for (let n = from; n < to; n++) stories.push(storyFor(postSpec(page, n), actorOf(page)));
            const lines = [];
            lines.push({ data: { node: { __typename: 'User', id: p[1].id, timeline_list_feed_units: { edges: stories.slice(0, 1).map((s, i) => ({ node: s, cursor: `x${from + i}` })) } } }, extensions: { is_final: false } });
            stories.slice(1).forEach((s, i) => lines.push({ label: 'ProfileCometTimelineFeed_user$stream$ProfileCometTimelineFeed_user_timeline_list_feed_units', path: ['node', 'timeline_list_feed_units', 'edges', i + 1], data: { node: s, cursor: `x${from + i + 1}` }, extensions: { is_final: false } }));
            lines.push({ label: 'ProfileCometTimelineFeed_user$defer$ProfileCometTimelineFeed_user_timeline_list_feed_units$page_info', path: ['node', 'timeline_list_feed_units'], data: { page_info: { end_cursor: to < p[1].count ? `cur:${page}:${to}` : null, has_next_page: to < p[1].count } }, extensions: { is_final: true } });
            return send(res, 200, lines.map((l) => JSON.stringify(l)).join('\r\n'), 'application/json');
        }
        if (path === '/watch/') {
            hit('watch');
            const v = u.searchParams.get('v');
            if (!/^77\d+$/.test(v ?? '')) return send(res, 200, html('Facebook', '<div>This content isn\'t available right now</div>'));
            return send(res, 200, videoHtml(v));
        }
        if (path.startsWith('/captions/')) {
            hit('captions');
            return send(res, 200, '1\n00:00:00,000 --> 00:00:02,500\nHello and welcome.\n\n2\n00:00:02,500 --> 00:00:05,000\nToday we talk about the climate.\n', 'text/plain');
        }
        if (path.startsWith('/video/')) {
            hit('videoFile');
            return send(res, 200, Buffer.alloc(200000, 1), 'video/mp4');
        }
        if (path === '/v1/audio/transcriptions') {
            hit('whisper');
            if (req.headers.authorization !== 'Bearer sk-good') return send(res, 401, { error: { message: 'Incorrect API key provided' } }, 'application/json');
            return send(res, 200, { text: 'Spoken words from the video.', language: 'english', segments: [{ start: 0, end: 3, text: ' Spoken words from the video.' }] }, 'application/json');
        }
        if (path.startsWith('/share/p/')) return send(res, 302, '', 'text/html', { location: `/newsroom/posts/${postSpec('newsroom', 6).id}` });
        if (path.startsWith('/share/v/')) return send(res, 302, '', 'text/html', { location: '/watch/?v=77' + postSpec('newsroom', 1).id });
        const seg = path.split('/').filter(Boolean);
        if (seg[1] === 'posts') {
            hit('post');
            const page = PAGES[seg[0]] ? seg[0] : Object.keys(PAGES).find((k) => PAGES[k].id === seg[0]) ?? null;
            const n = page ? [...Array(PAGES[page].count).keys()].find((k) => postSpec(page, k).id === seg[2]) : undefined;
            if (n === undefined) return send(res, 200, html('Facebook', '<div>This content isn\'t available right now</div>'));
            return send(res, 200, html('Post', bbox({ data: { node_v2: storyFor(postSpec(page, n), actorOf(page)) } })));
        }
        if (path === '/profile.php') {
            const id = u.searchParams.get('id');
            const page = Object.keys(PAGES).find((k) => PAGES[k].id === id);
            return page ? send(res, 302, '', 'text/html', { location: `/${page}/` }) : send(res, 200, html('Facebook', '<div>This content isn\'t available right now</div>'));
        }
        hit(`page:${seg[0]}`);
        if (PAGES[seg[0]]) return send(res, 200, pageHtml(seg[0]));
        if (seg[0] === 'privateprofile') return send(res, 200, html('Some Person | Facebook', '<div>Some Person</div>'));
        if (seg[0] === 'loginwalled') return send(res, 302, '', 'text/html', { location: `/login/?next=${seg[0]}` });
        return send(res, 200, html('Page not found', '<div>This content isn\'t available right now</div>'));
    });

    // A proxy pool Facebook has flagged: every request through it is sent to the login page.
    const proxy = http.createServer((req, res) => {
        hit('viaProxy');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Log in to Facebook</title></head><body><form id="login_form"></form></body></html>');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => proxy.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${server.address().port}`;
            resolve({ base, proxyUrl: `http://127.0.0.1:${proxy.address().port}`, hits, postSpec, PAGES, close: () => { server.close(); proxy.close(); } });
        }));
    });
}
