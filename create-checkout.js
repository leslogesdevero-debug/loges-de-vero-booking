// ===========================================================================
// Fonction serveur : calcule le prix, revérifie la disponibilité, puis crée
// une session de paiement Stripe. La clé secrète Stripe reste ici, jamais
// dans le site public.
// ===========================================================================

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// -------- À adapter à votre configuration --------
const SITE_URL = 'https://leslogesdevero.fr';
const TARIFS_URL = 'https://leslogesdevero.fr/tarifs.json';
const ICS_URLS = {
  duplex: 'https://app.superhote.com/export-ics/pCsTr5ULxk',
  rdc: 'https://app.superhote.com/export-ics/qCQMbqI1LK'
};
const PROPERTY_NAMES = { duplex: 'Le Duplex', rdc: 'Le Rez-de-chaussée' };
// --------------------------------------------------

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

async function getBookedSet(property) {
  const res = await fetch(ICS_URLS[property]);
  if (!res.ok) throw new Error('Impossible de lire le calendrier de disponibilité.');
  const events = parseICS(await res.text());
  const set = new Set();
  for (const ev of events) {
    const d = new Date(ev.start);
    while (d < ev.end) {
      set.add(fmt(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return set;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': SITE_URL,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };

  try {
    const { property, checkin, checkout } = JSON.parse(event.body || '{}');

    if (!PROPERTY_NAMES[property]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Logement inconnu.' }) };
    }

    const start = new Date(checkin + 'T00:00:00Z');
    const end = new Date(checkout + 'T00:00:00Z');
    const nights = Math.round((end - start) / 86400000);

    if (!checkin || !checkout || !(nights > 0)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dates invalides.' }) };
    }

    // 1. Tarifs à jour (fichier modifiable par la propriétaire, sans redéploiement)
    const tarifsRes = await fetch(TARIFS_URL, { cache: 'no-store' });
    if (!tarifsRes.ok) throw new Error('Impossible de charger les tarifs.');
    const tarifs = await tarifsRes.json();
    const tarif = tarifs[property];
    if (!tarif) throw new Error('Tarif introuvable pour ce logement.');

    if (nights < (tarif.minNights || 1)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Séjour minimum de ${tarif.minNights} nuits pour ce logement.` }) };
    }

    // 2. Disponibilité revérifiée côté serveur (ne jamais faire confiance au client)
    const booked = await getBookedSet(property);
    const d = new Date(start);
    while (d < end) {
      if (booked.has(fmt(d))) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Ces dates viennent d\'être réservées par quelqu\'un d\'autre. Merci de choisir une autre période.' }) };
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    // 3. Calcul du montant total
    const cleaningFee = tarif.cleaningFee || 0;
    const totalCents = Math.round((tarif.nightly * nights + cleaningFee) * 100);

    // 4. Création de la session de paiement Stripe
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: totalCents,
          product_data: {
            name: `${PROPERTY_NAMES[property]} — du ${checkin} au ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})`
          }
        },
        quantity: 1
      }],
      success_url: `${SITE_URL}/reservation-confirmee?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/reservation-annulee`,
      metadata: { property, checkin, checkout, nights: String(nights) }
    });

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Erreur serveur.' }) };
  }
};
