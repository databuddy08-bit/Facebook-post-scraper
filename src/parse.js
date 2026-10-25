// Story (Facebook post) -> output row. Field names follow apify/facebook-posts-scraper so existing integrations keep working;
// everything after `inputUrl` in the row is new.
import { find, findAll, findKey } from './relay.js';

// Keys that hold *other* stories or comments: post-level lookups never descend into them.
const OTHERS = new Set(['attached_story', 'attached_story_layout', 'interesting_top_level_comments', 'top_level_comments', 'comment_list_renderer', 'comment_rendering_instance_for_feed_location', 'all_subattachments_prefetch', 'related_posts', 'aggregated_stories']);
const REACTIONS = { Like: 'reactionLikeCount', Love: 'reactionLoveCount', Care: 'reactionCareCount', Haha: 'reactionHahaCount', Wow: 'reactionWowCount', Sad: 'reactionSadCount', Angry: 'reactionAngryCount' };
const FB = 'https://www.facebook.com';

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const isFacebookUrl = (u) => /^https?:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.com|fb\.me|fbcdn\.net)\//i.test(u ?? '');

/** Turns "897K followers" / "1.2M" / "12,345" into a number (approximate for K/M/B). */
export function parseCount(text) {
    const m = String(text ?? '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1);
    return Number.isFinite(n) ? Math.round(n) : null;
}

/** Stories that are posts (have a post_id). Nested stories (shared posts, comments) are not returned separately. */
export function storiesIn(root) {
    return findAll(root, (o) => o.__typename === 'Story' && typeof o.post_id === 'string', { skip: OTHERS });
}

function actorOf(a) {
    if (!a) return null;
    return { id: str(a.id), name: str(a.name), profileUrl: str(a.url) ?? str(a.profile_url) ?? (a.id ? `${FB}/${a.id}` : null), profilePic: str(a.profile_picture?.uri) };
}

function mediaItem(m) {
    if (!m || typeof m !== 'object' || !m.__typename) return null;
    const t = m.__typename;
    if (t === 'Photo' || t === 'Image') {
        const img = m.photo_image ?? m.image ?? m.viewer_image ?? null;
        return { __typename: 'Photo', id: str(m.id), url: str(m.url), thumbnail: str(img?.uri), photo_image: img ? { uri: str(img.uri), height: num(img.height), width: num(img.width) } : null, ocrText: str(m.accessibility_caption) };
    }
    if (t === 'Video') {
        const durationMs = num(m.playable_duration_in_ms);
        return {
            __typename: 'Video', id: str(m.id), url: str(m.url) ?? str(m.permalink_url) ?? (m.id ? `${FB}/watch/?v=${m.id}` : null),
            thumbnail: str(m.preferred_thumbnail?.image?.uri) ?? str(m.thumbnailImage?.uri) ?? str(m.image?.uri),
            videoUrl: str(m.browser_native_hd_url) ?? str(m.playable_url_quality_hd) ?? str(m.browser_native_sd_url) ?? str(m.playable_url),
            videoSdUrl: str(m.browser_native_sd_url) ?? str(m.playable_url),
            durationSec: num(m.length_in_second) ?? (durationMs !== null ? Math.round(durationMs / 100) / 10 : null),
            viewsCount: num(m.play_count) ?? num(m.video_view_count),
            captionsUrl: str(m.captions_url),
        };
    }
    if (t === 'GenericAttachmentMedia' || t === 'ExternalUrl') return null;
    return null;
}

function media(story) {
    const out = [];
    const seen = new Set();
    const add = (m) => {
        const it = mediaItem(m);
        if (it && !seen.has(it.id ?? it.thumbnail)) {
            seen.add(it.id ?? it.thumbnail);
            out.push(it);
        }
    };
    const atts = story.attachments ?? story.comet_sections?.content?.story?.attachments ?? findKey(story, 'attachments', OTHERS, Array.isArray) ?? [];
    for (const a of atts) {
        const sub = a?.styles?.attachment?.all_subattachments?.nodes ?? a?.all_subattachments?.nodes;
        if (Array.isArray(sub) && sub.length) sub.forEach((n) => add(n?.media ?? n));
        else add(a?.styles?.attachment?.media ?? a?.media);
    }
    return out;
}

function externalLink(story, refs) {
    const atts = findKey(story, 'attachments', OTHERS, Array.isArray) ?? [];
    for (const a of atts) {
        const u = a?.styles?.attachment?.story_attachment_link_renderer?.attachment?.web_link?.url ?? a?.styles?.attachment?.url ?? a?.target?.external_url ?? a?.url;
        if (u && !isFacebookUrl(u)) return { url: u, title: str(a?.styles?.attachment?.title_with_entities?.text) ?? str(a?.title_with_entities?.text) ?? null };
    }
    const fromRefs = refs.find((r) => r.external_url && !isFacebookUrl(r.external_url));
    return fromRefs ? { url: fromRefs.external_url, title: null } : null;
}

function comment(c) {
    if (!c || typeof c !== 'object') return null;
    const text = c.body?.text ?? c.preferred_body?.text ?? null;
    if (text === null && !c.author) return null;
    const created = num(c.created_time);
    return {
        id: str(c.legacy_fbid) ?? str(c.id),
        text,
        author: actorOf(c.author),
        time: created ? new Date(created * 1000).toISOString() : null,
        likes: num(c.feedback?.reactors?.count) ?? num(c.feedback?.reaction_count?.count) ?? num(c.feedback?.reaction_count) ?? null,
        replies: num(c.feedback?.replies_fields?.total_count) ?? num(c.feedback?.total_reply_count) ?? null,
        url: str(c.url) ?? str(c.feedback?.url),
    };
}

/** Top comments shipped with the post (no extra requests). */
export function topComments(story, max = 50) {
    const out = [];
    const seen = new Set();
    const push = (c) => {
        const x = comment(c);
        if (x && x.text && !seen.has(x.id ?? x.text)) {
            seen.add(x.id ?? x.text);
            out.push(x);
        }
    };
    for (const arr of findAll(story, (o) => Array.isArray(o.interesting_top_level_comments), { stopAtMatch: false, skip: new Set(['attached_story']) })) arr.interesting_top_level_comments.forEach((e) => push(e?.comment));
    for (const tl of findAll(story, (o) => Array.isArray(o.top_level_comments?.edges), { stopAtMatch: false, skip: new Set(['attached_story']) })) tl.top_level_comments.edges.forEach((e) => push(e?.node));
    return out.slice(0, max);
}

/**
 * @param story Facebook Story object
 * @param ctx {inputUrl, facebookUrl, pageName, page: {followers,…}}
 */
export function storyToPost(story, ctx = {}) {
    const content = story.comet_sections?.content?.story ?? story;
    const actors = content.actors ?? story.comet_sections?.context_layout?.story?.actors ?? findKey(story, 'actors', OTHERS, Array.isArray) ?? [];
    const user = actorOf(actors[0]);
    const postId = story.post_id;
    const withRanges = (m) => typeof m?.text === 'string' && Array.isArray(m.ranges) && m.ranges.length > 0;
    const message = [content.comet_sections?.message?.story?.message, content.message].find(withRanges)
        ?? findKey(story, 'message', OTHERS, withRanges) ?? content.message ?? findKey(story, 'message', OTHERS, (m) => typeof m?.text === 'string');
    const text = message?.text ?? null;
    const ranges = Array.isArray(message?.ranges) ? message.ranges : [];
    const textReferences = ranges.map((r) => r?.entity).filter((e) => e && (e.url || e.external_url)).map((e) => ({
        url: str(e.url), external_url: str(e.external_url) ?? str(e.web_link?.url), id: str(e.id), __typename: str(e.__typename),
        mobileUrl: e.url ? e.url.replace('://www.facebook.com', '://m.facebook.com').replace(/\?__eep__=\d+$/, '') : null,
    }));
    const creation = num(findKey(story, 'creation_time', OTHERS));
    const meta = story.comet_sections?.context_layout?.story?.comet_sections?.metadata;
    const url = (Array.isArray(meta) ? meta.map((m) => m?.story?.url).find(Boolean) : null)
        ?? str(content.comet_sections?.message?.story?.url) ?? str(story.url) ?? str(findKey(story, 'permalink_url', OTHERS)) ?? (user?.id ? `${FB}/${user.id}/posts/${postId}` : null);

    const fb = findKey(story, 'comet_ufi_summary_and_actions_renderer', OTHERS)?.feedback ?? find(story, (o) => o.reaction_count && o.share_count, OTHERS) ?? {};
    const reactions = {};
    for (const e of fb.top_reactions?.edges ?? []) {
        const k = REACTIONS[e?.node?.localized_name];
        if (k) reactions[k] = num(e.reaction_count);
    }
    const commentsTotal = num(findKey(story, 'comment_rendering_instance', new Set(['attached_story']))?.comments?.total_count)
        ?? num(findKey(story, 'total_comment_count', OTHERS)) ?? num(findKey(story, 'comments', OTHERS, (c) => typeof c?.total_count === 'number')?.total_count);
    const items = media(story);
    const video = items.find((m) => m.__typename === 'Video');
    const views = num(findKey(story, 'video_view_count', OTHERS)) ?? num(findKey(story, 'play_count', OTHERS)) ?? num(findKey(story, 'post_view_count', OTHERS)) ?? video?.viewsCount ?? null;
    const delegate = actors[0]?.delegate_page ?? findKey(story, 'delegate_page', OTHERS);
    const link = externalLink(story, textReferences);
    const shared = findKey(story, 'attached_story', new Set(), (s) => s && typeof s === 'object' && (s.post_id || s.id));
    const likes = num(fb.reaction_count?.count) ?? parseCount(fb.i18n_reaction_count);
    const shares = num(fb.share_count?.count) ?? parseCount(fb.i18n_share_count);
    const isReel = /\/reel\//.test(url ?? '') || /\/reel\//.test(video?.url ?? '') || Boolean(findKey(story, 'short_form_video_context', OTHERS));
    const hashtags = [...new Set([...textReferences.filter((r) => r.__typename === 'Hashtag').map((r) => r.url?.match(/\/hashtag\/([^/?]+)/)?.[1]).filter(Boolean), ...[...String(text ?? '').matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1])].map((h) => decodeURIComponent(h).toLowerCase()))];
    const mentions = ranges.filter((r) => r?.entity && ['User', 'Page'].includes(r.entity.__typename)).map((r) => ({ name: text ? [...text].slice(r.offset, r.offset + r.length).join('') : null, id: str(r.entity.id), url: str(r.entity.url) }));
    const postType = isReel ? 'reel' : video ? 'video' : items.length > 1 ? 'album' : items.length ? 'photo' : link ? 'link' : shared ? 'shared' : 'text';
    const engagement = (likes ?? 0) + (commentsTotal ?? 0) + (shares ?? 0);
    const followers = ctx.page?.followers ?? null;

    return {
        facebookUrl: ctx.facebookUrl ?? (user?.profileUrl || null),
        postId,
        pageName: ctx.pageName ?? null,
        url,
        time: creation ? new Date(creation * 1000).toISOString() : null,
        timestamp: creation,
        user,
        collaborators: actors.slice(1).map(actorOf).filter(Boolean),
        text,
        textReferences,
        link: link?.url ?? null,
        likes,
        comments: commentsTotal,
        shares,
        topReactionsCount: num(fb.top_reactions?.count) ?? (Object.keys(reactions).length || null),
        media: items.map(({ captionsUrl, videoSdUrl, ...m }) => m),
        feedbackId: str(story.feedback?.id) ?? str(content.feedback?.id),
        ...reactions,
        viewsCount: views,
        topLevelUrl: user?.id ? `${FB}/${user.id}/posts/${postId}` : null,
        facebookId: user?.id ?? null,
        pageAdLibrary: delegate ? { is_business_page_active: delegate.is_business_page_active ?? null, id: str(delegate.id) } : null,
        inputUrl: ctx.inputUrl ?? null,
        // ---- additions ----
        postType,
        isVideo: Boolean(video),
        isReel,
        videoUrl: video?.videoUrl ?? null,
        videoDurationSec: video?.durationSec ?? null,
        linkTitle: link?.title ?? null,
        hashtags,
        mentions,
        externalLinks: [...new Set([link?.url, ...textReferences.map((r) => r.external_url)].filter((u) => u && !isFacebookUrl(u)))],
        sharedPost: shared ? { postId: str(shared.post_id), url: str(findKey(shared, 'url', new Set(), (u) => /facebook\.com\/.+\/(posts|videos|photos)|permalink|reel/.test(u))), text: findKey(shared, 'message', new Set(), (m) => typeof m?.text === 'string')?.text ?? null, user: actorOf(findKey(shared, 'actors', new Set(), Array.isArray)?.[0]) } : null,
        reactionsBreakdown: Object.keys(reactions).length ? Object.fromEntries(Object.entries(reactions).map(([k, v]) => [k.replace(/^reaction|Count$/g, '').toLowerCase(), v])) : null,
        engagementTotal: likes === null && commentsTotal === null && shares === null ? null : engagement,
        engagementRatePercent: followers ? Math.round((engagement / followers) * 1e6) / 1e4 : null,
        pageFollowers: followers,
        topComments: topComments(story, ctx.maxTopComments ?? 10),
        _video: video ? { id: video.id, url: video.url, sdUrl: video.videoSdUrl, captionsUrl: video.captionsUrl, durationSec: video.durationSec } : null,
    };
}
