// End-to-end tests: runs the real actor (src/main.js) against the local Facebook mock. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-facebook.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICING = (a = 0.004, b = 0.01) => JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { post: { eventPriceUsd: a, eventTitle: 'p' }, 'video-transcript': { eventPriceUsd: b, eventTitle: 't' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);

async function run(name, input, { mock, env = {}, keep = false } = {}) {
    const dir = join(ROOT, 'storage-test', name);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, 'datasets'), { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify({ proxyConfiguration: { useApifyProxy: false }, ...input }));
    const t0 = Date.now();
    const child = spawn('node', ['src/main.js'], {
        cwd: ROOT,
        env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', APIFY_PROXY_PASSWORD: '', CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0',
            FB_BASE: mock.base, OPENAI_BASE: `${mock.base}/v1/audio/transcriptions`, GROQ_BASE: `${mock.base}/v1/audio/transcriptions`, HTTP_RATE_SCALE: '40',
            ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true', APIFY_ACTOR_PRICING_INFO: PRICING(), APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}', ...env },
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    writeFileSync(join(dir, 'run.log'), logs);
    const rows = readDir(join(dir, 'datasets', 'default'));
    const kv = (k) => (existsSync(join(dir, 'key_value_stores', 'default', `${k}.json`)) ? JSON.parse(readFileSync(join(dir, 'key_value_stores', 'default', `${k}.json`), 'utf8')) : null);
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    const count = (e) => charges.filter((c) => c.eventName === e).reduce((s, c) => s + (c.count ?? 1), 0);
    return { code, rows, ok: rows.filter((r) => r.status === 'ok'), failed: rows.filter((r) => r.status !== 'ok'), charges, posts: count('post'), transcripts: count('video-transcript'), other: charges.filter((c) => !['post', 'video-transcript'].includes(c.eventName)).length,
        summary: kv('RUN_SUMMARY'), logs, secs: Math.round((Date.now() - t0) / 100) / 10 };
}

const results = [];
const check = (label, pass, detail = '') => {
    results.push(Boolean(pass));
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const billed = (r) => r.posts === r.ok.length && r.other === 0;
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const mock = await startMock();
const B = 'https://www.facebook.com';

if (want('pages')) {
    console.log('\n=== 1. PAGES (HTML first post + GraphQL pagination, header, enrichment, failures) ===');
    const r = await run('pages', { startUrls: [`${B}/newsroom`, { url: `${B}/quietpage/` }, 'newsroom', `${B}/privateprofile`, `${B}/ghostpage999`, `${B}/groups/123`, 'https://twitter.com/x', `${B}/profile.php?id=100000000000002`], resultsLimit: 12, topCommentsPerPost: 1 }, { mock });
    const news = r.ok.filter((x) => x.facebookUrl?.endsWith('/newsroom'));
    const by = (t) => news.find((x) => x.postType === t);
    check('12 newsroom posts (1 from page HTML + 4 GraphQL pages) and 2 quiet-page posts', r.code === 0 && news.length === 12 && r.ok.length === 14 && r.summary.perInput[0].pages === 4, `${r.ok.length} ok in ${r.secs}s; pages=${r.summary.perInput.map((p) => p.pages)}`);
    check('newest first, no duplicates (repeated input + profile.php alias skipped)', news.every((x, i) => !i || x.timestamp < news[i - 1].timestamp) && new Set(r.ok.map((x) => x.postId)).size === r.ok.length && r.summary.skipReasons.duplicate_input === 1 && r.summary.skipReasons.duplicate_post === 2, JSON.stringify(r.summary.skipReasons));
    check('every post charged once as "post", failed rows free', billed(r));
    const p0 = news[0];
    check('core fields: text, time, url, user, likes, comments, shares, reaction breakdown', p0.text.startsWith('Post 0 from Newsroom Daily') && p0.time && p0.url.includes('/posts/') && p0.user.name === 'Newsroom Daily' && p0.likes === 1000 && p0.comments === 50 && p0.shares === 30 && p0.reactionLikeCount === 990 && p0.reactionLoveCount === 10 && p0.reactionsBreakdown.like === 990, JSON.stringify({ likes: p0.likes, comments: p0.comments, shares: p0.shares }));
    check('page header: followers parsed (1.2M) + engagement rate + Ad Library ID', p0.pageFollowers === 1200000 && typeof p0.engagementRatePercent === 'number' && p0.pageAdLibrary?.id, `${p0.pageFollowers} / ${p0.engagementRatePercent}%`);
    check('post types detected: photo, album(3 media), video, link, text, shared', by('photo')?.media[0]?.ocrText && by('album')?.media.length === 3 && by('video')?.isVideo && by('link')?.link === 'https://news.example.com/story-2' && by('link').linkTitle === 'Headline 2' && by('text') && by('shared')?.sharedPost?.text === 'The original shared post', JSON.stringify(r.summary.postTypes));
    check('video posts enriched from the watch page (views, title, duration, video URL)', by('video')?.viewsCount === 50001 && by('video').videoTitle === 'Video 1 title' && by('video').videoDurationSec === 61 && by('video').videoUrl?.includes('/video/'), JSON.stringify({ v: by('video')?.viewsCount, t: by('video')?.videoTitle }));
    check('hashtags from text and links, top comments capped at 1', news[1].hashtags.includes('ai') && news[0].hashtags.includes('climate') && news.every((x) => x.topComments.length <= 1) && news[0].topComments[0]?.text);
    check('failure rows: no_timeline, not_found, unsupported_input (group), invalid_input — all with fix hints', ['no_timeline', 'not_found', 'unsupported_input', 'invalid_input'].every((s) => r.failed.some((x) => x.status === s)) && r.failed.every((x) => x.fixHint), r.failed.map((x) => x.status).join(','));
    check('RUN_SUMMARY: per input, fill rates, post types, routes', r.summary.perInput.length === 5 && r.summary.fillRates?.likes === '100%' && r.summary.postTypes.video >= 1 && r.summary.routes.length === 1, JSON.stringify(r.summary.fillRates));
}

if (want('singles')) {
    console.log('\n=== 2. SINGLE POSTS, VIDEOS, REELS, SHARE LINKS ===');
    const id3 = mock.postSpec('newsroom', 3).id;
    const vid = `77${mock.postSpec('newsroom', 9).id}`;
    const r = await run('singles', { startUrls: [`${B}/newsroom/posts/${id3}`, `${B}/permalink.php?story_fbid=${mock.postSpec('newsroom', 5).id}&id=100000000000001`, `${B}/share/p/AbCdEf/`, `${B}/reel/${vid}/`, `${B}/watch/?v=77${mock.postSpec('newsroom', 7).id}`, `${B}/share/v/XyZ/`, `${B}/newsroom/posts/123456789`, `${B}/watch/?v=123`] }, { mock });
    check('6 saved: post, permalink, share link (redirect), reel, watch video, video share link', r.ok.length === 6 && billed(r), `${r.ok.length} in ${r.secs}s: ${r.ok.map((x) => x.postType).join(',')}`);
    const reel = r.ok.find((x) => x.url?.includes('/reel/'));
    check('reel: views, likes, comments, author, text, duration from the watch page', reel?.viewsCount === 50009 && reel.likes === 820 && reel.comments === 41 && reel.user?.name === 'Newsroom Daily' && reel.text?.startsWith('Post 9') && reel.postType === 'reel' && reel.videoDurationSec === 61, JSON.stringify({ v: reel?.viewsCount, l: reel?.likes, c: reel?.comments, type: reel?.postType }));
    check('missing post and missing video -> not_found rows', r.failed.filter((x) => x.status === 'not_found').length === 2, r.failed.map((x) => `${x.status}:${x.error}`).join(' | '));
}

if (want('filters')) {
    console.log('\n=== 3. FILTERS (never charged; date filter stops paging early) ===');
    const a = await run('date', { startUrls: [`${B}/newsroom`], resultsLimit: 100, onlyPostsNewerThan: '10 days' }, { mock });
    check('"10 days" -> 10 posts, paging stops soon after the date (not all 40)', a.ok.length === 10 && a.summary.perInput[0].stopReason === 'reached_posts_older_than_date' && a.summary.perInput[0].pages <= 5 && billed(a), `${a.ok.length} posts, ${a.summary.perInput[0].pages} pages, ${a.summary.perInput[0].stopReason}`);
    const b = await run('types', { startUrls: [`${B}/newsroom`], resultsLimit: 3, postTypes: ['video'] }, { mock });
    check('postTypes [video] -> only videos, others free', b.ok.length === 3 && b.ok.every((x) => x.postType === 'video') && billed(b) && b.summary.skipReasons.filtered_post_type > 0);
    const c = await run('keywords', { startUrls: [`${B}/newsroom`], resultsLimit: 4, keywords: ['climate'], minReactions: 900 }, { mock });
    check('keywords + min reactions -> matching posts with matchedKeywords evidence', c.ok.length === 2 && c.ok.every((x) => x.matchedKeywords?.includes('climate') && x.likes >= 900) && billed(c), `${c.ok.length}: ${c.ok.map((x) => x.likes)}`);
    const d = await run('window', { startUrls: [`${B}/newsroom`], resultsLimit: 50, onlyPostsNewerThan: '8 days', onlyPostsOlderThan: '3 days' }, { mock });
    check('date window (older than 3 days, newer than 8 days) -> 5 posts', d.ok.length === 5 && d.ok.every((x) => x.timestamp * 1000 < Date.now() - 3 * 864e5), `${d.ok.length}`);
    const e = await run('baddate', { startUrls: [`${B}/newsroom`], onlyPostsNewerThan: 'last week' }, { mock });
    check('invalid date -> clear error', e.code !== 0 && /not a valid date/.test(e.logs));
    const f = await run('nomatch', { startUrls: [`${B}/quietpage`], keywords: ['zzzz'] }, { mock });
    check('nothing matches -> free no_posts row explaining what was skipped', f.ok.length === 0 && f.failed[0]?.status === 'no_posts' && /filtered_keywords/.test(f.failed[0].error));
}

if (want('transcripts')) {
    console.log('\n=== 4. VIDEO TRANSCRIPTS (captions, AI with own key) ===');
    const a = await run('tr-captions', { startUrls: [`${B}/newsroom`], resultsLimit: 2, postTypes: ['video'], includeVideoTranscript: true }, { mock });
    const withT = a.ok.filter((x) => x.transcript);
    check('captioned video -> transcript from captions, charged as video-transcript; uncaptioned -> reason, not charged', withT.length === 1 && withT[0].transcriptSource === 'captions' && withT[0].transcript.startsWith('Hello and welcome') && a.transcripts === 1 && a.ok.find((x) => !x.transcript)?.transcriptError?.includes('no captions'), `${withT.length} transcripts, ${a.transcripts} charged`);
    const b = await run('tr-ai', { startUrls: [`${B}/newsroom`], resultsLimit: 2, postTypes: ['video'], includeVideoTranscript: true, aiProvider: 'openai', aiApiKey: 'sk-good' }, { mock });
    check('AI fills the uncaptioned video (video file -> Whisper)', b.ok.filter((x) => x.transcriptSource === 'ai').length === 1 && b.transcripts === 2 && mock.hits.videoFile >= 1, `${b.transcripts} transcripts`);
    const c = await run('tr-badkey', { startUrls: [`${B}/newsroom`], resultsLimit: 2, postTypes: ['video'], includeVideoTranscript: true, aiProvider: 'groq', aiApiKey: 'nope' }, { mock });
    check('bad AI key -> post still saved, error explained, transcript not charged', c.ok.length === 2 && c.transcripts === 1 && c.ok.some((x) => /API key/.test(x.transcriptError ?? '')));
}

if (want('blocks')) {
    console.log('\n=== 5. BLOCKS (rate limits, login walls, flagged proxy) ===');
    const rl = await startMock({ rateLimitEvery: 3 });
    const a = await run('ratelimit', { startUrls: [`${B}/newsroom`], resultsLimit: 15 }, { mock: rl });
    check('GraphQL rate limit -> new session, page reloaded for fresh tokens, same cursor continues', a.ok.length === 15 && new Set(a.ok.map((x) => x.postId)).size === 15 && a.summary.requests.blocked >= 1 && billed(a), `${a.ok.length} posts, ${a.summary.requests.blocked} blocked, ${rl.hits['page:newsroom']} page loads`);
    rl.close();
    const lw = await startMock({ loginWallFirst: 2 });
    const b = await run('loginwall', { startUrls: [`${B}/quietpage`] }, { mock: lw });
    check('login-wall redirects retried with a fresh session', b.ok.length === 2 && b.summary.requests.blocked >= 2, `${b.summary.requests.blocked} blocked`);
    lw.close();
    const c = await run('proxy-fallback', { startUrls: [`${B}/quietpage`], proxyConfiguration: { useApifyProxy: false, proxyUrls: [mock.proxyUrl] } }, { mock });
    check('flagged proxy abandoned, run continues on the next route', c.ok.length === 2 && c.summary.requests.routeSwitches === 1 && /Switching to "no proxy/.test(c.logs), JSON.stringify(c.summary.routes));
    const d = await run('proxy-nofallback', { startUrls: [`${B}/quietpage`], proxyConfiguration: { useApifyProxy: false, proxyUrls: [mock.proxyUrl] }, proxyFallback: false }, { mock });
    check('fallback off -> free blocked row with a fix hint', d.ok.length === 0 && d.failed[0]?.status === 'blocked' && d.posts === 0, d.failed[0]?.error);
    const e = await run('walled-page', { startUrls: [`${B}/loginwalled`] }, { mock });
    check('page that always shows the login wall -> blocked row', e.failed[0]?.status === 'blocked');
}

if (want('dedupe')) {
    console.log('\n=== 6. SKIP POSTS FROM PREVIOUS RUNS ===');
    const input = { startUrls: [`${B}/newsroom`], resultsLimit: 5, skipPreviouslyScraped: true, dedupeStoreName: 'e2e-seen' };
    const a = await run('dedupe', input, { mock });
    const b = await run('dedupe', { ...input, resultsLimit: 8 }, { mock, keep: true });
    check('second run returns only the 8 posts it has not saved before', a.ok.length === 5 && b.ok.length === 8 && !b.ok.some((x) => a.ok.find((y) => y.postId === x.postId)) && b.summary.skipReasons.seen_in_previous_run === 5, `${a.ok.length} then ${b.ok.length}`);
}

if (want('limits')) {
    console.log('\n=== 7. MAX COST, MAX RESULTS, TIMEOUT ===');
    const mc = await run('maxcost', { startUrls: [`${B}/newsroom`], resultsLimit: 30 }, { mock, env: { ACTOR_MAX_TOTAL_CHARGE_USD: '5', APIFY_ACTOR_PRICING_INFO: PRICING(1, 1) } });
    check('max cost $5 at $1/post -> exactly 5 saved and charged', mc.ok.length === 5 && mc.posts === 5 && mc.summary.stopReason === 'max_cost_per_run_reached', `${mc.ok.length} / ${mc.posts} / ${mc.summary.stopReason}`);
    const mr = await run('maxresults', { startUrls: [`${B}/newsroom`, `${B}/quietpage`], resultsLimit: 30, maxResults: 7 }, { mock });
    check('maxResults 7 across pages -> exactly 7', mr.ok.length === 7 && mr.posts === 7 && mr.summary.stopReason === 'max_results_reached');
    const slow = await startMock({ delayMs: 500 });
    const to = await run('timeout', { startUrls: [`${B}/newsroom`], resultsLimit: 40 }, { mock: slow, env: { ACTOR_TIMEOUT_AT: new Date(Date.now() + 60000).toISOString(), HTTP_RATE_SCALE: '1' } });
    check('stops 45 s before timeout with data and RUN_SUMMARY saved', to.code === 0 && to.ok.length > 0 && to.ok.length < 40 && /timeout_approaching/.test(to.summary?.stopReason ?? '') && billed(to) && to.secs < 60, `${to.ok.length} saved in ${to.secs}s`);
    slow.close();
}

mock.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
