// Unit tests on real Facebook pages saved in Oct 2026 (test/fixtures/*.html.gz) and on the helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { relayResultsFromHtml, relayResultsFromGraphql, assemble } from '../src/relay.js';
import { storiesIn, storyToPost, parseCount } from '../src/parse.js';
import { parseFacebookInput, parseCaptionFile, makeFacebook } from '../src/facebook.js';
import { blockReason, Session } from '../src/http.js';

const fixture = (f) => gunzipSync(readFileSync(new URL(`./fixtures/${f}.html.gz`, import.meta.url))).toString();
const postsOf = (html) => assemble(relayResultsFromHtml(html)).flatMap(storiesIn).map((s) => storyToPost(s, {}));

test('real page (CERN): first timeline post with engagement, reactions, media, comments', () => {
    const [p] = postsOf(fixture('page-cern'));
    assert.equal(p.postId, '1555002106669513');
    assert.equal(p.user.name, 'CERN');
    assert.equal(p.likes, 756);
    assert.equal(p.comments, 137);
    assert.equal(p.shares, 56);
    assert.equal(p.reactionLikeCount, 658);
    assert.equal(p.reactionLoveCount, 80);
    assert.equal(p.time, '2026-10-23T08:59:42.000Z');
    assert.match(p.url, /facebook\.com\/cern\/posts\/pfbid/);
    assert.equal(p.media[0].__typename, 'Photo');
    assert.ok(p.media[0].ocrText);
    assert.ok(p.topComments[0].text && p.topComments[0].author.name);
    assert.deepEqual(p.hashtags, ['atcern']);
    assert.equal(p.pageAdLibrary.id, '169005736520113');
});

test('real post page: text links, external link, 6 reaction types', () => {
    const [p] = postsOf(fixture('post-cern'));
    assert.equal(p.postId, '1315686150601111');
    assert.equal(p.likes, 1253);
    assert.equal(p.shares, 206);
    assert.equal(p.comments, 76);
    assert.equal(p.textReferences.length, 6);
    assert.equal(p.link, 'https://cerncourier.com/a/what-can-you-do-with-380-million-higgs-bosons/');
    assert.deepEqual(Object.keys(p.reactionsBreakdown).sort(), ['angry', 'care', 'haha', 'like', 'love', 'wow']);
    assert.ok(p.hashtags.includes('higgs'));
});

test('real watch page: video post with views, reactions, comments, duration, video URL', async () => {
    const html = fixture('video-bbc');
    const fb = makeFacebook({ fetch: async () => ({ status: 200, body: html, url: 'https://www.facebook.com/bbcearth/videos/895509256298494/' }) });
    const v = await fb.loadVideo('895509256298494', new Session());
    const p = storyToPost(v.story, {});
    assert.equal(v.title, 'Panda bear marks territory');
    assert.equal(p.postId, '1441693187314472');
    assert.equal(p.viewsCount, 360601);
    assert.equal(p.likes, 1843);
    assert.equal(p.comments, 29);
    assert.equal(p.user.name, 'BBC Earth');
    assert.ok(p.videoUrl.startsWith('https://video'));
    assert.equal(p.videoDurationSec, 236.5);
    assert.equal(p.postType, 'reel');
});

test('real reel page: related reels are separate posts with text and comment counts', () => {
    const posts = postsOf(fixture('reel-bbc'));
    assert.ok(posts.length >= 3);
    assert.ok(posts.every((p) => p.postId && p.text && p.isReel));
});

test('page tokens and preloaded timeline variables are found', async () => {
    const html = fixture('page-cern');
    const fb = makeFacebook({ fetch: async () => ({ status: 200, body: html, url: 'https://www.facebook.com/cern' }) });
    const s = new Session();
    const page = await fb.loadPage('cern', s);
    assert.equal(page.userId, '100064792144187');
    assert.ok(page.cursor.length > 30 && page.hasNext);
    assert.equal(page.header.followers, 897000);
    assert.ok(s.tokens.lsd && s.tokens.datr && s.tokens.rev && s.tokens.jazoest);
});

test('Relay incremental GraphQL: stream + defer pieces are reassembled', () => {
    const body = ['{"data":{"node":{"timeline_list_feed_units":{"edges":[{"node":{"__typename":"Story","post_id":"1"}}]}}}}',
        '{"label":"x$stream$y","path":["node","timeline_list_feed_units","edges",1],"data":{"node":{"__typename":"Story","post_id":"2"}}}',
        '{"label":"x$defer$page_info","path":["node","timeline_list_feed_units"],"data":{"page_info":{"end_cursor":"NEXT","has_next_page":true}}}'].join('\r\n');
    const [root] = assemble(relayResultsFromGraphql(body));
    assert.deepEqual(storiesIn(root).map((s) => s.post_id), ['1', '2']);
    assert.equal(root.node.timeline_list_feed_units.page_info.end_cursor, 'NEXT');
});

test('input parsing: pages, profiles, posts, videos, reels, share links, groups', () => {
    const k = (s) => { const r = parseFacebookInput(s); return r.invalid ? `invalid${r.status ? `:${r.status}` : ''}` : `${r.kind}:${r.path ?? r.videoId ?? r.url}`; };
    assert.equal(k('nike'), 'page:nike');
    assert.equal(k('https://m.facebook.com/nike/?ref=x'), 'page:nike');
    assert.equal(k('https://www.facebook.com/profile.php?id=100064792144187'), 'page:profile.php?id=100064792144187');
    assert.equal(k('https://www.facebook.com/people/Jane-Doe/100012345678901/'), 'page:profile.php?id=100012345678901');
    assert.equal(k('100064792144187'), 'page:profile.php?id=100064792144187');
    assert.equal(k('https://www.facebook.com/cern/posts/pfbid02abc'), 'post:https://www.facebook.com/cern/posts/pfbid02abc');
    assert.equal(k('https://www.facebook.com/permalink.php?story_fbid=123&id=456'), 'post:https://www.facebook.com/456/posts/123');
    assert.equal(k('https://www.facebook.com/reel/895509256298494'), 'video:895509256298494');
    assert.equal(k('https://www.facebook.com/watch/?v=895509256298494'), 'video:895509256298494');
    assert.equal(k('https://www.facebook.com/bbcearth/videos/895509256298494/'), 'video:895509256298494');
    assert.equal(k('https://www.facebook.com/share/p/1AbC/'), 'post:https://www.facebook.com/share/p/1AbC/');
    assert.equal(k('https://www.facebook.com/groups/123'), 'invalid:unsupported_input');
    assert.equal(k('https://instagram.com/nike'), 'invalid');
});

test('block detection: login walls and rate limits, but not normal pages', () => {
    assert.match(blockReason({ statusCode: 200, url: 'https://www.facebook.com/login/?next=x', body: '' }), /login/);
    assert.match(blockReason({ statusCode: 200, url: 'https://www.facebook.com/api/graphql/', body: '{"errors":[{"message":"Rate limit exceeded","code":1675004}]}' }), /rate limit/);
    assert.equal(blockReason({ statusCode: 200, url: 'https://www.facebook.com/cern', body: fixture('page-cern') }), null);
});

test('helpers: counts, captions', () => {
    assert.equal(parseCount('897K followers'), 897000);
    assert.equal(parseCount('1.2M'), 1200000);
    assert.equal(parseCount('12,345'), 12345);
    assert.deepEqual(parseCaptionFile('1\n00:00:01,500 --> 00:00:03,000\nHello <i>there</i>\n\n2\n00:01:00.000 --> 00:01:02.000\nBye\n'), [{ text: 'Hello there', start: 1.5, dur: 1.5 }, { text: 'Bye', start: 60, dur: 2 }]);
});
