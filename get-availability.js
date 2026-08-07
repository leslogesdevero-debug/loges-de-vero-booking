// ===========================================================================
// Fonction serveur : lit les flux iCal Superhote côté serveur (donc aucun
// problème de CORS) et renvoie la liste des dates réservées par logement.
// Remplace le recours à un proxy CORS tiers peu fiable côté navigateur.
// ===========================================================================

const ICS_URLS = {
  duplex: 'https://app.superhote.com/export-ics/pCsTr5ULxk',
  rdc: 'https://app.superhote.com/export-ics/qCQMbqI1LK'
};

const SITE_URL = 'https://leslogesdevero.fr';

function unfoldICS(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseICSDate(line) {
  const val = line.split(':').pop().trim();
  return new Date(Date.UTC(+val.slice(0, 4), +val.slice(4, 6) - 1, +val.slice(6, 8)));
}

function parseICS(text) {
  const lines = unfoldICS(text).split(/\r\n|\n|\r/);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('BEGIN:VEVENT')) cur = {};
    else if (line.startsWith('END:VEVENT')) {
      if (cur && cur.start && cur.end) events.push(cur);
      cur = null;
    } else if (cur) {
      if (line.startsWith('DTSTART')) cur.start = parseICSDate(line);
      else if (line.startsWith('DTEND')) cur.end = parseICSDate(line);
    }
  }
  return events;
}

function fmt(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

async function getBookedDates(property) {
  const res = await fetch(ICS_URLS[property]);
  if (!res.ok) throw new Error('Impossible de lire le calendrier ' + property);
  const events = parseICS(await res.text());
  const set = new Set();
  for (const ev of events) {
    const d = new Date(ev.start);
    while (d < ev.end) {
      set.add(fmt(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return Array.from(set);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': SITE_URL,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const requested = (event.queryStringParameters && event.queryStringParameters.property) || 'all';
  const properties = requested === 'all' ? Object.keys(ICS_URLS) : [requested];

  if (!properties.every(p => ICS_URLS[p])) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Logement inconnu.' }) };
  }

  try {
    const result = {};
    await Promise.all(properties.map(async p => {
      result[p] = await getBookedDates(p);
    }));
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Erreur serveur.' }) };
  }
};
