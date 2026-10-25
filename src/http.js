// HTTP client: network routes with automatic fallback, per-session cookies, Facebook block detection, rate limiting, retries.
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import { log } from 'apify';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export class BlockedError extends Error {}
export class StoppedError extends Error {}

class RateLimiter {
    constructor(perMinute) {
        this.interval = 60000 / perMinute;
        this.next = 0;
    }

    /** Waits for the next request slot; gives up as soon as the run starts stopping. */
    async wait(msLeft) {
        const slot = Math.max(Date.now(), this.next);
        this.next = slot + this.interval;
        while (Date.now() < slot) {
            if (msLeft() <= 0) throw new StoppedError('run stopping');
            await sleep(Math.min(500, slot - Date.now()));
        }
    }
}

/** One browser identity: proxy session (= IP), cookies and the page tokens Facebook bound to them. */
export class Session {
    constructor() {
        this.rotate();
    }

    rotate() {
        this.id = `s${Math.random().toString(36).slice(2, 12)}`;
        this.jar = new CookieJar();
        this.tokens = null; // lsd etc. from the last page load — only valid for this IP + cookies
    }
}

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Verified Oct 2026: these exact headers get public pages logged-out; a generated header set is sent to the login page more often.
export const PAGE_HEADERS = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };

/** Why Facebook refused a response, or null. */
export function blockReason(res) {
    const url = res.url ?? '';
    if (res.statusCode === 429) return 'HTTP 429';
    if (/\/login(?:\/|\.php)|\/checkpoint\//.test(url)) return 'login wall (Facebook sent the request to the login page)';
    const body = typeof res.body === 'string' ? res.body.slice(0, 3000) : '';
    if (/<title>Log in to Facebook|<title>Log into Facebook|id="login_form"/.test(typeof res.body === 'string' ? res.body.slice(0, 200000) : '') && !/"queryName":"ProfileCometTimelineFeedQuery"|"post_id":"\d+"/.test(String(res.body))) return 'login wall (Facebook showed its login page)';
    if (/"Rate limit exceeded"|"code":1675004/.test(body)) return 'Facebook rate limit for this IP';
    if (res.statusCode === 403 && !/<html/i.test(body)) return 'HTTP 403';
    return null;
}

export class Client {
    /** @param routes ordered [{label, proxy}] — proxy undefined = the server's own IP */
    constructor({ routes, msLeft, stats }) {
        const scale = Number(process.env.HTTP_RATE_SCALE ?? 1) || 1;
        // Playbook rates: 400/min through a proxy (new IP per session), 60/min from the server's own IP.
        this.routes = routes.map((r) => ({ ...r, ok: 0, fail: 0, streak: 0, limiter: new RateLimiter((r.proxy ? 400 : 60) * scale) }));
        this.routeIdx = 0;
        this.msLeft = msLeft;
        this.stats = stats;
    }

    get route() {
        return this.routes[this.routeIdx];
    }

    routeResult(idx, ok) {
        const r = this.routes[idx];
        if (ok) {
            r.ok += 1;
            r.streak = 0;
            return;
        }
        r.fail += 1;
        r.streak += 1;
        // Logged-out Facebook sends some good requests to the login page too, so a route is only dropped after a clear pattern.
        const dead = (r.ok === 0 && r.fail >= 6) || r.streak >= 15;
        if (dead && idx === this.routeIdx && this.routeIdx < this.routes.length - 1) {
            this.routeIdx += 1;
            this.stats.routeSwitches = (this.stats.routeSwitches ?? 0) + 1;
            log.warning(`Facebook keeps blocking "${r.label}" (${r.ok} ok / ${r.fail} blocked). Switching to "${this.route.label}".`);
        }
    }

    routesSummary() {
        return this.routes.map((r, i) => ({ route: r.label, used: i <= this.routeIdx, ok: r.ok, blocked: r.fail, active: i === this.routeIdx }));
    }

    /**
     * One request. On a block the session rotates (new IP + fresh cookies) and `onRotate` can rebuild what the next
     * attempt needs (e.g. reload the page for new tokens). The route switches when it keeps failing.
     * @returns {Promise<{status:number, body:any, headers:object, url:string}>}
     */
    async fetch(o, session) {
        const attempts = o.attempts ?? (this.route.proxy ? 8 : 3);
        let last = 'unknown';
        let restarts = 0;
        for (let a = 0; a < attempts; a++) {
            if (this.msLeft() <= 0) throw new StoppedError('run stopping');
            const extra = o.prepare ? await o.prepare(session) : {};
            const idx = this.routeIdx;
            const route = this.routes[idx];
            await route.limiter.wait(this.msLeft);
            this.stats.requests += 1;
            let res;
            try {
                res = await gotScraping({
                    url: extra.url ?? o.url,
                    method: o.method ?? 'GET',
                    ...(extra.body ?? o.body ? { body: extra.body ?? o.body } : {}),
                    headers: { ...(o.headers ?? PAGE_HEADERS), ...(extra.headers ?? {}) },
                    cookieJar: session.jar,
                    useHeaderGenerator: false,
                    proxyUrl: route.proxy ? await route.proxy.newUrl(session.id) : undefined,
                    responseType: o.responseType ?? 'text',
                    followRedirect: true,
                    throwHttpErrors: false,
                    retry: { limit: 0 },
                    timeout: { request: o.timeoutMs ?? 30000 },
                });
            } catch (err) {
                this.stats.networkErrors += 1;
                last = `network error ${err.code || err.message}`;
                this.routeResult(idx, false);
                session.rotate();
                await sleep(route.proxy ? 500 : 2000 * 2 ** a);
                continue;
            }
            const reason = blockReason(res) ?? o.isBlocked?.(res) ?? null;
            if (reason) {
                this.stats.blocked += 1;
                last = reason;
                this.routeResult(idx, false);
                session.rotate();
                if (this.routeIdx !== idx && restarts < this.routes.length) { // route changed: fresh budget on the new route
                    restarts += 1;
                    a = -1;
                    continue;
                }
                await sleep(route.proxy ? 300 + Math.random() * 400 : Math.min(20000, 2500 * 2 ** a));
                continue;
            }
            if (res.statusCode >= 500) {
                last = `HTTP ${res.statusCode}`;
                await sleep(1500);
                continue;
            }
            this.routeResult(idx, true);
            return { status: res.statusCode, body: res.body, headers: res.headers, url: res.url };
        }
        throw new BlockedError(last);
    }
}
