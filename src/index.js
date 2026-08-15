// Worker Cloudflare unique : sert le site (public/) ET gère deux routes
// dynamiques, /create-checkout et /get-availability.
// Remplace l'ancienne approche Cloudflare Pages (functions/*.js séparés).

import Stripe from 'stripe';

// -------- À adapter à votre configuration --------
const SITE_URL = 'https://leslogesdevero.fr'; // vos pages de confirmation/annulation
const TARIFS_PATH = '/tarifs.json'; // servi depuis public/tarifs.json, même déploiement
const BLOCKED_DATES_PATH = '/dates-bloquees.json'; // servi depuis public/dates-bloquees.json
const ICS_URLS = {
  duplex: 'https://app.superhote.com/export-ics/pCsTr5ULxk',
  rdc: 'https://app.superhote.com/export-ics/qCQMbqI1LK'
};
const PROPERTY_NAMES = { duplex: 'Le Duplex', rdc: 'Le Rez-de-chaussée' };
// -------- Synchronisation Superhote (à compléter avec vos identifiants) --------
const SUPERHOTE_PROPERTY_KEYS = {
  duplex: 'À_COMPLETER_property_key_duplex',
  rdc: 'À_COMPLETER_property_key_rdc'
};
// ---------------------------------------------------------------------------
const FROM_EMAIL = 'Les Loges de Véro <contact@leslogesdevero.fr>';
const OWNER_EMAIL = 'leslogesdevero@gmail.com';
const TELEGRAM_CHAT_ID = 'A_COMPLETER'; // votre identifiant de conversation Telegram

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
async function getBookedSet(property, env, request) {
  const res = await fetch(ICS_URLS[property]);
  if (!res.ok) throw new Error('Impossible de lire le calendrier de disponibilité.');
  const events = parseICS(await res.text());
  const set = new Set();
  for (const ev of events) {
    const d = new Date(ev.start);
    while (d < ev.end) { set.add(fmt(d)); d.setUTCDate(d.getUTCDate() + 1); }
  }

  try {
    const blockedRes = await env.ASSETS.fetch(new Request(new URL(BLOCKED_DATES_PATH, request.url)));
    if (blockedRes.ok) {
      const blocked = await blockedRes.json();
      for (const r of (blocked[property] || [])) {
        const d = new Date(r.debut + 'T00:00:00Z');
        const end = new Date(r.fin + 'T00:00:00Z');
        while (d <= end) { set.add(fmt(d)); d.setUTCDate(d.getUTCDate() + 1); }
      }
    }
  } catch (e) { console.error('Lecture dates-bloquees.json échouée:', e.message); }

  return set;
}
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) throw new Error('Service d\'email non configuré.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('Erreur Resend', res.status, detail);
    throw new Error('Échec de l\'envoi de l\'email.');
  }
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram non configuré.');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('Erreur Telegram', res.status, detail);
    throw new Error('Échec de l\'envoi Telegram.');
  }
}

function getNightlyRate(tarif, dateStr) {
  if (tarif.saisons) {
    for (const s of tarif.saisons) {
      if (dateStr >= s.debut && dateStr <= s.fin) return s.nightly;
    }
  }
  return tarif.nightlyDefault;
}
function getAccommodationSubtotal(tarif, checkinDate, nights) {
  let subtotal = 0;
  const d = new Date(checkinDate);
  for (let i = 0; i < nights; i++) {
    subtotal += getNightlyRate(tarif, fmt(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return subtotal;
}
function getDiscountPercent(tarif, nights) {
  let pct = 0;
  for (const r of (tarif.remises || [])) {
    if (nights >= r.minNuits && r.pourcentage > pct) pct = r.pourcentage;
  }
  return pct;
}
function getLastMinutePercent(tarif, checkin) {
  const rdm = tarif.remiseDerniereMinute;
  if (!rdm) return 0;
  const hoursUntilArrival = (new Date(checkin + 'T00:00:00Z') - new Date()) / 3600000;
  return (hoursUntilArrival >= 0 && hoursUntilArrival < rdm.seuilHeures) ? rdm.pourcentage : 0;
}

async function handleAvailability(request, env, origin) {
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const url = new URL(request.url);
  const requested = url.searchParams.get('property') || 'all';
  const properties = requested === 'all' ? Object.keys(ICS_URLS) : [requested];

  if (!properties.every(p => ICS_URLS[p])) {
    return new Response(JSON.stringify({ error: 'Logement inconnu.' }), { status: 400, headers });
  }
  try {
    const result = {};
    await Promise.all(properties.map(async p => { result[p] = Array.from(await getBookedSet(p, env, request)); }));
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
    if (!g.prenom || !g.nom || !g.adresse || !g.codePostal || !g.ville || !g.pays || !telOk || !emailOk) {
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

    const maxDateStr = tarifs.reservationsOuvertesJusquau;
    if (maxDateStr && checkout > maxDateStr) {
      return new Response(JSON.stringify({ error: `Les réservations ne sont ouvertes que jusqu'au ${maxDateStr}. Merci de choisir des dates antérieures.` }), { status: 400, headers });
    }

    if (nights < (tarif.minNights || 1)) {
      return new Response(JSON.stringify({ error: `Séjour minimum de ${tarif.minNights} nuits pour ce logement.` }), { status: 400, headers });
    }
    if (tarif.maxGuests && (adultsCount + childrenCount) > tarif.maxGuests) {
      return new Response(JSON.stringify({ error: `Ce logement accueille au maximum ${tarif.maxGuests} personnes.` }), { status: 400, headers });
    }

    const booked = await getBookedSet(property, env, request);
    const d = new Date(start);
    while (d < end) {
      if (booked.has(fmt(d))) {
        return new Response(JSON.stringify({ error: "Ces dates viennent d'être réservées par quelqu'un d'autre. Merci de choisir une autre période." }), { status: 409, headers });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    const subtotal = getAccommodationSubtotal(tarif, start, nights);
    const discountPct = getDiscountPercent(tarif, nights);
    const lastMinutePct = getLastMinutePercent(tarif, checkin);
    const totalDiscountPct = discountPct + lastMinutePct;
    const discountAmount = Math.round(subtotal * totalDiscountPct / 100 * 100) / 100;
    const accommodationCents = Math.round((subtotal - discountAmount) * 100);
    const cleaningFee = tarif.cleaningFee || 0;
    const cleaningCents = Math.round(cleaningFee * 100);
    const taxeParUnite = tarif.taxeSejourParAdulteParNuit || 0;
    const taxeUnitCents = Math.round(taxeParUnite * 100);
    const taxeQuantity = adultsCount * nights;

    const lineItems = [{
      price_data: {
        currency: 'eur',
        unit_amount: accommodationCents,
        product_data: { name: `${PROPERTY_NAMES[property]} — du ${checkin} au ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})${totalDiscountPct ? ` — remise -${totalDiscountPct}% incluse` : ''}` }
      },
      quantity: 1
    }];
    if (cleaningCents > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          unit_amount: cleaningCents,
          product_data: { name: `Ménage${tarif.cleaningFeeDetail ? ' (' + tarif.cleaningFeeDetail + ')' : ''}` }
        },
        quantity: 1
      });
    }
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

    const totalTTC = ((accommodationCents + cleaningCents + taxeUnitCents * taxeQuantity) / 100).toFixed(2);
    const occupantsTxt = `${adultsCount} adulte${adultsCount > 1 ? 's' : ''}${childrenCount > 0 ? ', ' + childrenCount + ' enfant' + (childrenCount > 1 ? 's' : '') : ''}`;
    const datesTxt = `du ${checkin} au ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})`;

    // L'email de confirmation au client est obligatoire : s'il échoue, on
    // n'ouvre pas le paiement plutôt que de laisser une réservation sans
    // confirmation envoyée.
    try {
      await sendEmail(env, g.email, 'Votre pré-réservation — Les Loges de Véro',
        `<p>Bonjour ${g.prenom},</p>
         <p>Nous avons bien reçu votre demande de réservation pour <strong>${PROPERTY_NAMES[property]}</strong>, ${datesTxt}, pour ${occupantsTxt}.</p>
         <p><strong>Cette pré-réservation est en attente de confirmation de votre paiement.</strong></p>
         <p>Vous recevrez un second email de confirmation définitive dès que le paiement sera validé.</p>
         <p>Montant total : <strong>${totalTTC} €</strong> (taxe de séjour incluse).</p>
         <p>À bientôt,<br>Les Loges de Véro</p>`);
    } catch (e) {
      console.error('Échec email client — réservation bloquée:', e.message);
      return new Response(JSON.stringify({ error: "Impossible d'envoyer l'email de confirmation pour le moment. Merci de réessayer dans quelques instants ou de nous contacter directement." }), { status: 502, headers });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: g.email,
      line_items: lineItems,
      success_url: `${origin}/reservation-confirmee.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/reservation-annulee.html`,
      metadata: {
        property, checkin, checkout, nights: String(nights), adults: String(adultsCount), children: String(childrenCount),
        prenom: g.prenom, nom: g.nom, adresse: g.adresse, codePostal: g.codePostal, ville: g.ville, pays: g.pays, telephone: g.telephone, email: g.email
      }
    });

    // La notification au propriétaire reste non-bloquante : un souci ici ne
    // doit pas empêcher un client de payer.
    try {
      await sendEmail(env, OWNER_EMAIL, `Nouvelle pré-réservation — ${PROPERTY_NAMES[property]}`,
        `<p>Nouvelle demande, ${datesTxt}, pour ${occupantsTxt}.</p>
         <p><strong>${g.prenom} ${g.nom}</strong><br>${g.adresse}<br>${g.codePostal} ${g.ville}<br>${g.pays}<br>Tél : ${g.telephone}<br>Email : ${g.email}</p>
         <p>Montant total : ${totalTTC} €</p>`);
    } catch (e) { console.error('Échec email propriétaire:', e.message); }

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Erreur serveur.' }), { status: 500, headers });
  }
}

async function pushToSuperhote(env, m, totalTTC) {
  if (!env.SUPERHOTE_API_KEY) throw new Error('SUPERHOTE_API_KEY non configurée.');
  const propertyKey = SUPERHOTE_PROPERTY_KEYS[m.property];
  if (!propertyKey) throw new Error('property_key Superhote manquant pour ' + m.property);

  const res = await fetch('https://app.superhote.com/api/v2/create-reservation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.SUPERHOTE_API_KEY,
      property_key: propertyKey,
      checking: m.checkin,
      checkout: m.checkout,
      nbr_adults: Number(m.adults) || 1,
      nbr_children: Number(m.children) || 0,
      first_name: m.prenom,
      last_name: m.nom,
      phone: m.telephone,
      email: m.email,
      address: m.adresse,
      zip_code: m.codePostal,
      city: m.ville,
      country: m.pays,
      status: 'confirmed',
      price: totalTTC
    })
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error('Erreur Superhote', res.status, detail);
    throw new Error('Échec de la synchronisation Superhote.');
  }
}

async function handleStripeWebhook(request, env) {
  const stripe = Stripe(env.STRIPE_SECRET_KEY);
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook Stripe invalide:', err.message);
    return new Response('Signature invalide.', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata || {};
    try {
      await sendEmail(env, m.email, 'Réservation confirmée — Les Loges de Véro',
        `<p>Bonjour ${m.prenom},</p>
         <p>Votre paiement a bien été validé. Votre réservation pour <strong>${PROPERTY_NAMES[m.property] || m.property}</strong>, du ${m.checkin} au ${m.checkout} (${m.nights} nuit${Number(m.nights) > 1 ? 's' : ''}), est maintenant <strong>confirmée</strong>.</p>
         <p>Nous avons hâte de vous accueillir aux Loges de Véro !</p>
         <p>À bientôt,<br>Les Loges de Véro</p>`);
    } catch (e) { console.error('Échec email confirmation définitive:', e.message); }

    let superhoteOk = true;
    let superhoteErrorMsg = '';
    try {
      await pushToSuperhote(env, m, (session.amount_total / 100).toFixed(2));
    } catch (e) {
      superhoteOk = false;
      superhoteErrorMsg = e.message;
      console.error('Échec synchronisation Superhote:', e.message);
    }

    try {
      await sendEmail(env, OWNER_EMAIL, `Paiement confirmé — ${PROPERTY_NAMES[m.property] || m.property}`,
        `<p>Le paiement pour la réservation de <strong>${m.prenom} ${m.nom}</strong> (du ${m.checkin} au ${m.checkout}) a bien été validé.</p>
         ${superhoteOk
           ? `<p>✅ Synchronisée automatiquement avec Superhote.</p>`
           : `<p><strong>⚠️ La synchronisation automatique avec Superhote a échoué (${superhoteErrorMsg}). Merci de bloquer ces dates manuellement dans Superhote pour éviter une double réservation.</strong></p>`}`);
    } catch (e) { console.error('Échec email propriétaire (confirmation):', e.message); }

    try {
      const totalTTC = (session.amount_total / 100).toFixed(2);
      await sendTelegram(env,
        `Nouvelle réservation payée : ${PROPERTY_NAMES[m.property] || m.property}, du ${m.checkin} au ${m.checkout}. ${m.prenom} ${m.nom} - ${m.telephone}. ${totalTTC}€.`);
    } catch (e) { console.error('Échec Telegram propriétaire:', e.message); }
  }

  return new Response('ok', { status: 200 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin; // le widget est servi par ce même Worker : origine toujours autorisée

    if (request.method === 'OPTIONS' && (url.pathname === '/create-checkout' || url.pathname === '/get-availability')) {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === '/get-availability' && request.method === 'GET') {
      return handleAvailability(request, env, origin);
    }
    if (url.pathname === '/create-checkout' && request.method === 'POST') {
      return handleCheckout(request, env, origin);
    }
    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    // Tout le reste : fichiers statiques servis depuis public/
    return env.ASSETS.fetch(request);
  }
};
