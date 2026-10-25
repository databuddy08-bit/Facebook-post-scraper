// Facebook ships data as Relay results: a root payload plus @defer / @stream pieces addressed by "path".
// These helpers rebuild complete objects from page HTML and from /api/graphql/ responses.

/** Parses the JSON at `i` (a "{") by bracket matching; tolerant of trailing junk. */
export function jsonAt(str, i) {
    let depth = 0;
    let inStr = false;
    for (let k = i; k < str.length; k++) {
        const c = str[k];
        if (inStr) {
            if (c === '\\') k++;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (!depth) {
                try {
                    return JSON.parse(str.slice(i, k + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/** All <script type="application/json"> blobs of a Facebook page. */
export function scriptBlobs(html) {
    const out = [];
    for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
            out.push(JSON.parse(m[1]));
        } catch { /* not JSON */ }
    }
    return out;
}

/** Relay results ({data, label?, path?}) found inside page blobs, in document order. */
export function relayResultsFromHtml(html) {
    const results = [];
    const walk = (o, d) => {
        if (!o || typeof o !== 'object' || d > 40) return;
        if (Array.isArray(o)) {
            for (const x of o) walk(x, d + 1);
            return;
        }
        if (o.__bbox?.result && typeof o.__bbox.result === 'object') results.push(o.__bbox.result);
        for (const v of Object.values(o)) walk(v, d + 1);
    };
    for (const b of scriptBlobs(html)) walk(b, 0);
    return results;
}

/** Relay results from an /api/graphql/ body (one JSON object per line, optional "for (;;);" prefix). */
export function relayResultsFromGraphql(body) {
    const text = String(body ?? '').replace(/^for \(;;\);/, '');
    const out = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
            out.push(JSON.parse(t));
        } catch {
            const j = jsonAt(t, 0);
            if (j) out.push(j);
        }
    }
    return out;
}

export function deepMerge(a, b) {
    if (b === undefined || b === null) return a;
    if (a === undefined || a === null) return b;
    if (Array.isArray(a) && Array.isArray(b)) {
        const out = [...a];
        b.forEach((x, i) => { out[i] = deepMerge(a[i], x); });
        return out;
    }
    if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        const out = { ...a };
        for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
        return out;
    }
    return b;
}

/**
 * Applies incremental payloads to their root. A payload without `path` starts a new root; one with `path` is merged at
 * that path (@defer: data object; @stream: `items` or `data` appended at the index in path).
 * @returns {object[]} complete root `data` objects
 */
export function assemble(results) {
    const roots = [];
    for (const r of results) {
        if (!r || typeof r !== 'object') continue;
        const payloadData = r.data ?? null;
        if (!Array.isArray(r.path)) {
            if (payloadData) roots.push({ data: payloadData });
            continue;
        }
        const root = roots.at(-1);
        if (!root) continue;
        const items = Array.isArray(r.items) ? r.items : payloadData ? [payloadData] : [];
        items.forEach((item, n) => {
            const path = [...r.path];
            if (Array.isArray(r.items) && typeof path.at(-1) === 'number') path[path.length - 1] += n;
            let parent = root;
            let key = 'data';
            for (const seg of path) {
                if (parent[key] === undefined || parent[key] === null) parent[key] = typeof seg === 'number' ? [] : {};
                parent = parent[key];
                key = seg;
            }
            parent[key] = deepMerge(parent[key], item);
        });
    }
    return roots.map((r) => r.data);
}

/** Depth-first search for the first object matching `pred`. `skip` keys are not entered. */
export function find(obj, pred, skip = new Set(), depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 60) return undefined;
    if (!Array.isArray(obj) && pred(obj)) return obj;
    for (const [k, v] of Array.isArray(obj) ? obj.entries() : Object.entries(obj)) {
        if (skip.has(k) || !v || typeof v !== 'object') continue;
        const r = find(v, pred, skip, depth + 1);
        if (r !== undefined) return r;
    }
    return undefined;
}

/** All matching objects (does not descend into a match when `stopAtMatch`). */
export function findAll(obj, pred, { skip = new Set(), stopAtMatch = true } = {}, out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 60) return out;
    if (!Array.isArray(obj) && pred(obj)) {
        out.push(obj);
        if (stopAtMatch) return out;
    }
    for (const [k, v] of Array.isArray(obj) ? obj.entries() : Object.entries(obj)) {
        if (skip.has(k) || !v || typeof v !== 'object') continue;
        findAll(v, pred, { skip, stopAtMatch }, out, depth + 1);
    }
    return out;
}

/** First value stored under `key` anywhere inside obj. */
export function findKey(obj, key, skip = new Set(), accept = (v) => v !== undefined && v !== null) {
    let hit;
    find(obj, (o) => {
        if (Object.prototype.hasOwnProperty.call(o, key) && accept(o[key])) {
            hit = o[key];
            return true;
        }
        return false;
    }, skip);
    return hit;
}
