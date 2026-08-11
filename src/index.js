// ===========================================================================
// Worker Cloudflare unique : sert le site (public/) ET gère deux routes
// dynamiques, /create-checkout et /get-availability.
// Remplace l'ancienne approche Cloudflare Pages (functions/*.js séparés).
// ===========================================================================

import Stripe from 'stripe';

// -------- À adapter à votre configuration --------
const SITE_URL = 'https://leslogesdevero.fr'; // vos pages de confirmation/annulation
const TARIFS_PATH = '/tarifs.json'; // servi depuis public/tarifs.json, même déploiement
const ICS_URLS = {
  duplex: 'https://app.superhote.com/export-ics/pCsTr5ULxk',
  rdc: 'https://app.superhote.com/export-ics/qCQMbqI1LK'
};
const PROPERTY_NAMES = { duplex: 'Le Duplex', rdc: 'Le Rez-de-chaussée' };
const FROM_EMAIL = 'Les Loges de Véro <onboarding@resend.dev>';
const OWNER_EMAIL = 'contact@leslogesdevero.fr';
// --------------------------------------------------

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

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
    while (d < ev.end) { set.add(fmt(d)); d.setUTCDate(d.getUTCDate() + 1); }
  }
  return set;
}
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
  });
}

async function handleAvailability(request, origin) {
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const url = new URL(request.url);
  const requested = url.searchParams.get('property') || 'all';
  const properties = requested === 'all' ? Object.keys(ICS_URLS) : [requested];

  if (!properties.every(p => ICS_URLS[p])) {
    return new Response(JSON.stringify({ error: 'Logement inconnu.' }), { status: 400, headers });
  }
  try {
    const result = {};
    await Promise.all(properties.map(async p => { result[p] = Array.from(await getBookedSet(p)); }));
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Erreur serveur.' }), { status: 500, headers });
  }
}

async function handleCheckout(request, env, origin) {
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };
  const stripe = Stripe(env.STRIPE_SECRET_KEY);

  try {
    const { property, checkin, checkout, adults, children, guest } = await request.json();

    if (!PROPERTY_NAMES[property]) {
      return new Response(JSON.stringify({ error: 'Logement inconnu.' }), { status: 400, headers });
    }

    const g = guest || {};
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email || '');
    const telOk = (g.telephone || '').replace(/[^0-9+]/g, '').length >= 8;
    if (!g.prenom || !g.nom || !g.adresse || !telOk || !emailOk) {
      return new Response(JSON.stringify({ error: 'Merci de renseigner des coordonnées complètes et valides.' }), { status: 400, headers });
    }

    const start = new Date(checkin + 'T00:00:00Z');
    const end = new Date(checkout + 'T00:00:00Z');
    const nights = Math.round((end - start) / 86400000);
    const adultsCount = parseInt(adults, 10);
    const childrenCount = parseInt(children, 10) || 0;

    if (!checkin || !checkout || !(nights > 0)) {
      return new Response(JSON.stringify({ error: 'Dates invalides.' }), { status: 400, headers });
    }
    if (!Number.isInteger(adultsCount) || adultsCount < 1) {
      return new Response(JSON.stringify({ error: "Nombre d'adultes invalide." }), { status: 400, headers });
    }
    if (!Number.isInteger(childrenCount) || childrenCount < 0) {
      return new Response(JSON.stringify({ error: "Nombre d'enfants invalide." }), { status: 400, headers });
    }

    const tarifsRes = await env.ASSETS.fetch(new Request(new URL(TARIFS_PATH, request.url)));
    if (!tarifsRes.ok) throw new Error('Impossible de charger les tarifs.');
    const tarifs = await tarifsRes.json();
    const tarif = tarifs[property];
    if (!tarif) throw new Error('Tarif introuvable pour ce logement.');

    if (nights < (tarif.minNights || 1)) {
      return new Response(JSON.stringify({ error: `Séjour minimum de ${tarif.minNights} nuits pour ce logement.` }), { status: 400, headers });
    }
    if (tarif.maxGuests && (adultsCount + childrenCount) > tarif.maxGuests) {
      return new Response(JSON.stringify({ error: `Ce logement accueille au maximum ${tarif.maxGuests} personnes.` }), { status: 400, headers });
    }

    const booked = await getBookedSet(property);
    const d = new Date(start);
    while (d < end) {
      if (booked.has(fmt(d))) {
        return new Response(JSON.stringify({ error: "Ces dates viennent d'être réservées par quelqu'un d'autre. Merci de choisir une autre période." }), { status: 409, headers });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    const cleaningFee = tarif.cleaningFee || 0;
    const accommodationCents = Math.round((tarif.nightly * nights + cleaningFee) * 100);
    const taxeParUnite = tarif.taxeSejourParAdulteParNuit || 0;
    const taxeUnitCents = Math.round(taxeParUnite * 100);
    const taxeQuantity = adultsCount * nights;

    const lineItems = [{
      price_data: {
        currency: 'eur',
        unit_amount: accommodationCents,
        product_data: { name: `${PROPERTY_NAMES[property]} — du ${checkin} au ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})` }
      },
      quantity: 1
    }];
    if (taxeUnitCents > 0 && taxeQuantity > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          unit_amount: taxeUnitCents,
          product_data: { name: `Taxe de séjour (${adultsCount} adulte${adultsCount > 1 ? 's' : ''} × ${nights} nuit${nights > 1 ? 's' : ''})` }
        },
        quantity: taxeQuantity
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: g.email,
      line_items: lineItems,
      success_url: `${SITE_URL}/reservation-confirmee?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/reservation-annulee`,
      metadata: {
        property, checkin, checkout, nights: String(nights), adults: String(adultsCount), children: String(childrenCount),
        prenom: g.prenom, nom: g.nom, adresse: g.adresse, telephone: g.telephone, email: g.email
      }
    });

    const totalTTC = ((accommodationCents + taxeUnitCents * taxeQuantity) / 100).toFixed(2);
    const occupantsTxt = `${adultsCount} adulte${adultsCount > 1 ? 's' : ''}${childrenCount > 0 ? ', ' + childrenCount + ' enfant' + (childrenCount > 1 ? 's' : '') : ''}`;
    const datesTxt = `du ${checkin} au ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})`;

    try {
      await sendEmail(env, g.email, 'Votre pré-réservation — Les Loges de Véro',
        `<p>Bonjour ${g.prenom},</p>
         <p>Nous avons bien reçu votre demande de réservation pour <strong>${PROPERTY_NAMES[property]}</strong>, ${datesTxt}, pour ${occupantsTxt}.</p>
         <p><strong>Cette pré-réservation est en attente de confirmation de votre paiement.</strong></p>
         <p>Montant total : <strong>${totalTTC} €</strong> (taxe de séjour incluse).</p>
         <p>À bientôt,<br>Les Loges de Véro</p>`);
    } catch (e) {}
    try {
      await sendEmail(env, OWNER_EMAIL, `Nouvelle pré-réservation — ${PROPERTY_NAMES[property]}`,
        `<p>Nouvelle demande, ${datesTxt}, pour ${occupantsTxt}.</p>
         <p><strong>${g.prenom} ${g.nom}</strong><br>${g.adresse}<br>Tél : ${g.telephone}<br>Email : ${g.email}</p>
         <p>Montant total : ${totalTTC} €</p>`);
    } catch (e) {}

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Erreur serveur.' }), { status: 500, headers });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin; // le widget est servi par ce même Worker : origine toujours autorisée

    if (request.method === 'OPTIONS' && (url.pathname === '/create-checkout' || url.pathname === '/get-availability')) {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === '/get-availability' && request.method === 'GET') {
      return handleAvailability(request, origin);
    }
    if (url.pathname === '/create-checkout' && request.method === 'POST') {
      return handleCheckout(request, env, origin);
    }
    // Tout le reste : fichiers statiques servis depuis public/
    return env.ASSETS.fetch(request);
  }
};
