// Optional AI transcription for videos without captions (Facebook video files are sent as-is; Whisper reads mp4), using the user's own API key (OpenAI or Groq Whisper).

const PROVIDERS = {
    openai: { url: process.env.OPENAI_BASE ?? 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', label: 'OpenAI Whisper' },
    groq: { url: process.env.GROQ_BASE ?? 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', label: 'Groq Whisper large-v3-turbo' },
};
export const MAX_AUDIO_BYTES = 24_500_000; // both providers accept up to 25 MB per file

/** Smallest audio stream (cheapest to download, plenty for speech). */
export function pickAudio(formats) {
    return [...formats].sort((a, b) => (a.bitrate ?? 1e9) - (b.bitrate ?? 1e9))[0] ?? null;
}

/**
 * @returns {Promise<{segments:{text,start,dur}[], language:string|null, model:string}>}
 */
export async function transcribe(provider, apiKey, audio, mime, { language } = {}) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`unknown AI provider "${provider}"`);
    const ext = /webm/.test(mime) ? 'webm' : /video\/mp4/.test(mime) ? 'mp4' : 'm4a';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime.split(';')[0] }), `audio.${ext}`);
    form.append('model', p.model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language.split('-')[0]);
    let res;
    for (let a = 0; a < 3; a++) {
        res = await fetch(p.url, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(300000) });
        if (res.status !== 429 && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 3000 * (a + 1)));
    }
    const body = await res.text();
    if (!res.ok) {
        const msg = (() => {
            try {
                return JSON.parse(body).error?.message;
            } catch {
                return body.slice(0, 200);
            }
        })();
        const err = new Error(`${p.label}: HTTP ${res.status} ${msg ?? ''}`.trim());
        err.badKey = res.status === 401 || res.status === 403;
        throw err;
    }
    const j = JSON.parse(body);
    const segments = (j.segments ?? []).map((s) => ({ text: String(s.text ?? '').trim(), start: Math.round(s.start * 1000) / 1000, dur: Math.round((s.end - s.start) * 1000) / 1000 })).filter((s) => s.text);
    if (!segments.length && j.text) segments.push({ text: j.text.trim(), start: 0, dur: j.duration ?? 0 });
    return { segments, language: j.language ?? null, model: `${p.label} (${p.model})` };
}
