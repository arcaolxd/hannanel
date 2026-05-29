/* ========================================================================
   HANNANEL NEWS WORKER — Cloudflare Worker
   Backend de noticias en tiempo real para Hannanel Pro
   Busca Google News RSS cada 5 min, almacena en KV, sirve vía API
   ======================================================================== */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE BÚSQUEDA
// ═══════════════════════════════════════════════════════════════════════════

const SEARCH_QUERIES = [
  // Sujeto principal
  '"Gaby Molina"',
  '"Gabriela Molina Aguilar"',
  '"Gaby Molina" Michoacán',
  '"Gaby Molina" educación',
  '"Gaby Molina" secretaria',
  'Molina Aguilar Michoacán',
  // Institucional
  '"Secretaría de Educación" Michoacán',
  '"SEE Michoacán"',
  // Contexto educativo Michoacán
  'maestros Michoacán atentado OR violencia OR agresión',
  'educación Michoacán crisis OR protesta OR paro',
  'escuelas Michoacán inseguridad OR cierre',
];

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const MAX_ARTICLES = 500;

// ═══════════════════════════════════════════════════════════════════════════
// RSS FETCHING & PARSING
// ═══════════════════════════════════════════════════════════════════════════

async function fetchRSS(query) {
  const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=es-419&gl=MX&ceid=MX:es-419`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!response.ok) return [];

    const xml = await response.text();
    return parseRSSItems(xml, query);
  } catch {
    return [];
  }
}

function parseRSSItems(xml, query) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];

    const fullTitle = extractTag(itemXml, 'title');
    const link = extractTagSimple(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');
    const description = extractTag(itemXml, 'description');
    const source = extractTag(itemXml, 'source');
    const sourceUrl = extractAttr(itemXml, 'source', 'url');

    if (fullTitle && fullTitle.length > 10) {
      // Google News titles: "Headline - Source Name"
      const titleParts = fullTitle.split(' - ');
      const cleanTitle = titleParts.length > 1
        ? titleParts.slice(0, -1).join(' - ')
        : fullTitle;
      const sourceName = source || (titleParts.length > 1
        ? titleParts[titleParts.length - 1]
        : 'Desconocido');

      // Extract real URL from description HTML if possible
      const realUrl = extractRealUrl(description) || link;

      items.push({
        title: cleanTitle.trim(),
        link: realUrl,
        googleLink: link,
        pubDate: pubDate,
        timestamp: new Date(pubDate).getTime() || Date.now(),
        description: stripHtml(description || '').substring(0, 500),
        source: sourceName.trim(),
        sourceUrl: sourceUrl || '',
        query: query,
        fetchedAt: Date.now(),
      });
    }
  }

  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// XML HELPERS (zero dependencies — no DOMParser in Workers)
// ═══════════════════════════════════════════════════════════════════════════

function extractTag(xml, tag) {
  // CDATA content
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = cdataRegex.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();

  // Regular content
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1].trim() : '';
}

function extractTagSimple(xml, tag) {
  // For <link> which is often self-contained text without nested tags
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i');
  const match = regex.exec(xml);
  return match ? match[1].trim() : '';
}

function extractAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
  const match = regex.exec(xml);
  return match ? match[1] : '';
}

function extractRealUrl(descriptionHtml) {
  if (!descriptionHtml) return null;
  const hrefMatch = /href="([^"]+)"/.exec(descriptionHtml);
  if (hrefMatch && !hrefMatch[1].includes('news.google.com')) {
    return hrefMatch[1];
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════

function deduplicateArticles(articles) {
  const seen = new Map();

  return articles.filter(a => {
    // Deduplicate by normalized title (first 60 chars lowercase)
    const key = a.title.toLowerCase().replace(/[^a-záéíóúñü\s]/g, '').substring(0, 60);
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: FETCH & STORE
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndStoreNews(env) {
  let allArticles = [];
  let successCount = 0;
  let errorCount = 0;

  // Fetch all queries (sequential to avoid rate limiting)
  for (const query of SEARCH_QUERIES) {
    try {
      const items = await fetchRSS(query);
      if (items.length > 0) {
        allArticles.push(...items);
        successCount++;
      }
    } catch {
      errorCount++;
    }
    // Small delay between queries to be nice to Google
    await new Promise(r => setTimeout(r, 200));
  }

  // Get existing articles from KV
  let existing = [];
  try {
    existing = await env.NEWS_KV.get('articles', { type: 'json' }) || [];
  } catch {
    existing = [];
  }

  // Merge new + existing, deduplicate
  const merged = deduplicateArticles([...allArticles, ...existing]);

  // Sort by timestamp (newest first), cap at MAX_ARTICLES
  merged.sort((a, b) => b.timestamp - a.timestamp);
  const final = merged.slice(0, MAX_ARTICLES);

  // Store articles
  await env.NEWS_KV.put('articles', JSON.stringify(final));

  // Store metadata
  const meta = {
    lastFetch: new Date().toISOString(),
    lastFetchNewCount: allArticles.length,
    totalStored: final.length,
    queriesSucceeded: successCount,
    queriesTotal: SEARCH_QUERIES.length,
    queriesFailed: errorCount,
  };
  await env.NEWS_KV.put('meta', JSON.stringify(meta));

  console.log(`[Hannanel] Fetch complete: ${allArticles.length} new, ${final.length} total, ${successCount}/${SEARCH_QUERIES.length} queries OK`);

  return meta;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKER EXPORT (Cloudflare Workers entry point)
// ═══════════════════════════════════════════════════════════════════════════

export default {
  // ── Cron Trigger (every 5 minutes) ──
  async scheduled(controller, env, ctx) {
    console.log(`[Hannanel] Cron fired: ${controller.cron} at ${new Date().toISOString()}`);
    ctx.waitUntil(fetchAndStoreNews(env));
  },

  // ── HTTP API ──
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers — allow Hannanel Pro from any origin
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── GET /api/news ──
    // Returns all stored articles, optionally filtered by ?since=TIMESTAMP
    if (url.pathname === '/api/news') {
      try {
        const since = url.searchParams.get('since');
        const stored = await env.NEWS_KV.get('articles', { type: 'json' }) || [];
        const meta = await env.NEWS_KV.get('meta', { type: 'json' }) || {};

        let articles = stored;
        if (since) {
          const sinceTs = parseInt(since);
          if (!isNaN(sinceTs)) {
            articles = stored.filter(a => a.timestamp > sinceTs);
          }
        }

        return new Response(JSON.stringify({
          status: 'ok',
          count: articles.length,
          totalStored: stored.length,
          lastFetch: meta.lastFetch || null,
          lastFetchNewCount: meta.lastFetchNewCount || 0,
          articles: articles,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({
          status: 'error',
          error: err.message,
          articles: [],
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // ── GET /api/status ──
    // Health check + stats
    if (url.pathname === '/api/status') {
      const meta = await env.NEWS_KV.get('meta', { type: 'json' }) || {};
      const stored = await env.NEWS_KV.get('articles', { type: 'json' }) || [];

      return new Response(JSON.stringify({
        status: 'online',
        worker: 'hannanel-news-worker',
        version: '1.0.0',
        totalArticles: stored.length,
        ...meta,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── GET /api/fetch ──
    // Manual trigger (for testing / first load)
    if (url.pathname === '/api/fetch') {
      const result = await fetchAndStoreNews(env);
      return new Response(JSON.stringify({
        status: 'ok',
        message: 'News fetch completed',
        ...result,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Root ──
    return new Response(
      '♛ Hannanel News Worker v1.0 — Endpoints: /api/news, /api/status, /api/fetch',
      { headers: { 'Content-Type': 'text/plain', ...corsHeaders } }
    );
  },
};
