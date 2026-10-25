# Facebook Posts Scraper Pro: Engagement, Comments, Views & Video Transcripts

Scrape posts from **public Facebook pages and profiles**, or from single **posts, photos, videos, reels and share links**. Every post comes with its text, an **exact reaction breakdown** (like, love, haha, wow, sad, angry, care), comment and share counts, **views**, media with photo descriptions, **top comments**, hashtags, mentions, links, shared-post details and an **engagement rate** based on the page's follower count. Video posts can include a **transcript**.

**No date-filter surcharge, and you never pay for filtered, duplicate or failed posts.**

## What you can scrape

| Input | Example |
|---|---|
| Page or profile | `https://www.facebook.com/cern`, `cern`, `profile.php?id=100064792144187`, `/people/Name/1000…` |
| Post | `https://www.facebook.com/cern/posts/pfbid…`, `permalink.php?story_fbid=…&id=…`, `/photo/?fbid=…` |
| Video / reel | `https://www.facebook.com/watch/?v=…`, `/reel/…`, `/page/videos/…` |
| Share link | `https://www.facebook.com/share/p/…`, `/share/v/…` |

Groups, events and search need a logged-in account, so this actor does not scrape them. They come back as a free `unsupported_input` row.

## What you get for each post

**Same fields as the official Facebook Posts Scraper** (your integrations keep working):
`facebookUrl`, `postId`, `pageName`, `url`, `time`, `timestamp`, `user`, `collaborators`, `text`, `textReferences`, `link`, `likes`, `comments`, `shares`, `topReactionsCount`, `media`, `feedbackId`, `reactionLikeCount`, `reactionLoveCount`…, `viewsCount`, `topLevelUrl`, `facebookId`, `pageAdLibrary`, `inputUrl`.

**Plus:**
- `postType`: photo, album, video, reel, link, text or shared.
- `reactionsBreakdown`: all reaction types in one object.
- `engagementTotal` and `engagementRatePercent`, plus `pageFollowers`.
- `topComments`: text, author, time, likes and replies. These come with the post at no extra cost.
- `hashtags`, `mentions`, `externalLinks`, `linkTitle`.
- `sharedPost`: the original post's text, author and URL.
- Video posts: `videoTitle`, `viewsCount`, `videoDurationSec`, `videoUrl` (the video file).
- `transcript`, `transcriptSource` (captions or AI) and `transcriptSegments` with timings, when you turn on transcripts.
- `matchedKeywords`: proof of why a post passed your keyword filter.

## How it is better than the official scraper

| | Facebook Posts Scraper | Facebook Posts Scraper Pro |
|---|---|---|
| Price | $5 / 1,000 posts, **+$2 / 1,000 with date filter** | $4 / 1,000 posts, date filter free |
| Single posts, videos, reels, share links | Pages only | ✅ |
| Reactions breakdown | ✅ | ✅ plus one handy `reactionsBreakdown` object |
| Engagement rate vs followers | ❌ | ✅ |
| Top comments | ❌ (separate actor) | ✅ included |
| Views and video file for videos | Reels only | ✅ every video and reel |
| Video transcripts | ✅ | ✅ captions or AI with your own key, for videos without captions |
| Filters: post type, keywords, min reactions, min comments, date window | Date only | ✅ All. Filtered posts are free |
| Skip posts from previous runs | ❌ | ✅ for scheduled monitoring |
| Failed inputs | Silent | ✅ free row with the reason and how to fix it |
| Blocked proxy | Run fails | ✅ switches automatically: residential → datacenter → server IP |

## Pricing (pay per event)

| Event | When | Price |
|---|---|---|
| `post` | One saved post | $0.004 ($4 per 1,000) |
| `video-transcript` | A transcript added to a video post | $0.005 |

The run stops cleanly at your **Maximum cost per run**. Posts that are filtered out, duplicates, seen in earlier runs, or from inputs that fail are never charged.

## Example input

```json
{
  "startUrls": [{ "url": "https://www.facebook.com/cern" }, { "url": "https://www.facebook.com/NASA" }],
  "resultsLimit": 50,
  "onlyPostsNewerThan": "30 days",
  "topCommentsPerPost": 5,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

## Example output (shortened)

```json
{
  "facebookUrl": "https://www.facebook.com/cern",
  "postId": "1315686150601111",
  "url": "https://www.facebook.com/cern/posts/pfbid0pbbgU3BUXfd1BPkAzYHNoRxyeo4H…",
  "time": "2026-01-20T13:00:05.000Z",
  "user": { "id": "100064792144187", "name": "CERN", "profileUrl": "https://www.facebook.com/cern" },
  "text": "What can you do with 380 million #Higgs bosons? …",
  "link": "https://cerncourier.com/a/what-can-you-do-with-380-million-higgs-bosons/",
  "likes": 1253,
  "comments": 76,
  "shares": 206,
  "reactionLikeCount": 1072,
  "reactionLoveCount": 157,
  "reactionsBreakdown": { "like": 1072, "love": 157, "wow": 11, "care": 7, "haha": 4, "angry": 2 },
  "postType": "photo",
  "hashtags": ["higgs", "antimatter", "standard", "hilumilhc", "cerncourier"],
  "engagementTotal": 1535,
  "media": [{ "__typename": "Photo", "id": "1315686073934452", "thumbnail": "https://scontent…jpg", "ocrText": "No photo description available." }],
  "topComments": [{ "text": "Higgs....the particle for the masses! ;)", "author": { "name": "…" }, "time": "2026-01-20T…" }]
}
```

A reel or video adds, for example, `"viewsCount": 360601`, `"videoDurationSec": 236.5`, `"videoTitle": "Panda bear marks territory"` and `"videoUrl": "https://video…mp4"`.

Inputs that return no posts come back as free rows, for example `"status": "no_timeline"` with `error` and `fixHint`. The possible statuses are `not_found`, `no_timeline`, `no_posts`, `blocked`, `invalid_input` and `unsupported_input`. Turn off "Show inputs without posts" to hide them.

## Run summary

Each run saves a `RUN_SUMMARY` in the key-value store. It contains:
- **Totals:** saved posts and charged events, with skip reasons (filters, duplicates, seen before).
- **Per input:** posts saved, pages requested and why paging stopped.
- **Data quality:** post types and the fill rate of the key fields.
- **Network:** which routes were used and how often Facebook blocked each one.

## Tips

- **Use residential proxy (the default).** Facebook sends datacenter IPs to its login page and rate-limits them. Keep "Automatic proxy fallback" on.
- **Monitor a page:** schedule the actor with `onlyPostsNewerThan: "2 days"` and "Skip posts saved in previous runs".
- **The date filter also saves money:** paging stops as soon as posts get older than your date.
- **Transcripts:** captions come from the video when the creator added them. For other videos, choose Groq or OpenAI and add your key. You pay them directly; Groq costs about $0.04 per audio hour.

## FAQ

**Can it scrape private profiles or groups?** No. It only reads what Facebook shows logged-out visitors on public pages and profiles.

**Is my API key safe?** The key field is a secret input. Apify stores it encrypted, and it is only sent to the AI provider you choose.

**A page returns fewer posts than expected?** Check `RUN_SUMMARY → perInput` for the stop reason and skip reasons. If it says `blocked`, run again with residential proxy.
