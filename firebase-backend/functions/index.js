const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { XMLParser } = require("fast-xml-parser");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!response.ok) return [];

    const xml = await response.text();
    return parseRSSItems(xml, query);
  } catch (e) {
    logger.error("Error fetching RSS for " + query, e);
    return [];
  }
}

function parseRSSItems(xml, query) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_"
  });
  const parsed = parser.parse(xml);

  const items = parsed?.rss?.channel?.item || [];
  const articlesArray = Array.isArray(items) ? items : [items];

  const results = [];
  
  for (const item of articlesArray) {
    if (!item || !item.title) continue;
    
    const fullTitle = item.title;
    const link = item.link;
    const pubDate = item.pubDate;
    const description = item.description || '';
    const sourceObj = item.source || {};
    const sourceName = typeof sourceObj === 'object' ? sourceObj['#text'] : sourceObj;
    const sourceUrl = typeof sourceObj === 'object' ? sourceObj['@_url'] : '';

    if (fullTitle.length > 10) {
      // Clean title "Headline - Source Name"
      const titleParts = fullTitle.split(' - ');
      const cleanTitle = titleParts.length > 1
        ? titleParts.slice(0, -1).join(' - ')
        : fullTitle;
      const finalSourceName = sourceName || (titleParts.length > 1
        ? titleParts[titleParts.length - 1]
        : 'Desconocido');

      const realUrl = extractRealUrl(description) || link;

      results.push({
        title: cleanTitle.trim(),
        link: realUrl,
        googleLink: link,
        pubDate: pubDate,
        timestamp: new Date(pubDate).getTime() || Date.now(),
        description: stripHtml(description).substring(0, 500),
        source: finalSourceName.trim(),
        sourceUrl: sourceUrl || '',
        query: query,
        fetchedAt: Date.now(),
      });
    }
  }

  return results;
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

function deduplicateArticles(articles) {
  const seen = new Map();
  return articles.filter(a => {
    const key = a.title.toLowerCase().replace(/[^a-záéíóúñü\s]/g, '').substring(0, 60);
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CRON JOB: Fetch and store
// ═══════════════════════════════════════════════════════════════════════════

async function processNewsUpdate() {
  let allArticles = [];
  let successCount = 0;
  let errorCount = 0;

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
  }

  const newsRef = db.collection('cache').doc('news_data');
  const doc = await newsRef.get();
  
  let existing = [];
  if (doc.exists) {
    existing = doc.data().articles || [];
  }

  const merged = deduplicateArticles([...allArticles, ...existing]);
  merged.sort((a, b) => b.timestamp - a.timestamp);
  const final = merged.slice(0, MAX_ARTICLES);

  const meta = {
    lastFetch: new Date().toISOString(),
    lastFetchNewCount: allArticles.length,
    totalStored: final.length,
    queriesSucceeded: successCount,
    queriesTotal: SEARCH_QUERIES.length,
    queriesFailed: errorCount,
  };

  await newsRef.set({
    articles: final,
    meta: meta
  });

  logger.info(`Fetch complete: ${allArticles.length} new, ${final.length} total.`);
  return meta;
}

// Se ejecuta cada 5 minutos
exports.fetchNewsCron = onSchedule("every 5 minutes", async (event) => {
  await processNewsUpdate();
});

// Endpoint para invocar el cron manualmente (útil para pruebas iniciales)
exports.manualFetch = onRequest(async (req, res) => {
  cors(req, res, async () => {
    const result = await processNewsUpdate();
    res.json({ status: "ok", ...result });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HTTP API: Servir las noticias al Frontend
// ═══════════════════════════════════════════════════════════════════════════

exports.api = onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "GET") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const doc = await db.collection('cache').doc('news_data').get();
      if (!doc.exists) {
        res.json({ status: "ok", count: 0, articles: [] });
        return;
      }

      const data = doc.data();
      let articles = data.articles || [];
      const meta = data.meta || {};

      const since = req.query.since;
      if (since) {
        const sinceTs = parseInt(since);
        if (!isNaN(sinceTs)) {
          articles = articles.filter(a => a.timestamp > sinceTs);
        }
      }

      res.json({
        status: "ok",
        count: articles.length,
        totalStored: data.articles.length,
        lastFetch: meta.lastFetch || null,
        articles: articles
      });
    } catch (e) {
      logger.error("Error serving API", e);
      res.status(500).json({ status: "error", error: e.message });
    }
  });
});
