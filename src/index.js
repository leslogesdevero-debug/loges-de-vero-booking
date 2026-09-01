import Stripe from 'stripe';

// Configuration des constantes
const SITE_URL = 'https://leslogesdevero.fr';
const TARIFS_PATH = '/tarifs.json';
const BLOCKED_DATES_PATH = '/dates-bloquees.json';

const ICS_URLS = {
  duplex: 'https://app.superhote.com/export-ics/pCsTr5ULxk',
  rdc: 'https://app.superhote.com/export-ics/qCQMbqI1LK'
};

const PROPERTY_NAMES = { 
  duplex: 'Le Duplex', 
  rdc: 'Le Rez-de-chaussée' 
};

const FROM_EMAIL = 'Les Loges de Véro <contact@leslogesdevero.fr>';
const OWNER_EMAIL = 'leslogesdevero@gmail.com';

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

// Parseur de dates iCal tolérant aux formats d'heures et de timezones
function parseICSDate(line) {
  const rawVal = line.split(':').pop().trim();
  const match = rawVal.match(/(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(+y, +m - 1, +d));
}

function parseICSEvents(icsText) {
  const events = [];
  const lines = icsText.split(/\r?\n/);
  let currentEvent = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      currentEvent = {};
    } else if (line.startsWith('END:VEVENT')) {
      if (currentEvent && currentEvent.start && currentEvent.end) {
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      if (line.startsWith('DTSTART')) {
        const dt = parseICSDate(line);
        if (dt) currentEvent.start = dt;
      } else if (line.startsWith('DTEND')) {
        const dt = parseICSDate(line);
        if (dt) currentEvent.end = dt;
      }
    }
  }
  return events;
}

async function fetchTarifs(env, requestOrigin) {
  const res = await env.ASSETS.fetch(new URL(TARIFS_PATH, requestOrigin));
  if (!res.ok) throw new Error('Impossible de charger tarifs.json');
  return await res.json();
}

async function fetchBlockedDates(env, requestOrigin) {
  try {
    if (env.CONFIG_KV) {
      const kvBlocked = await env.CONFIG_KV.get('blocked_dates');
      if (kvBlocked) return JSON.parse(kvBlocked);
    }
    const res = await env.ASSETS.fetch(new URL(BLOCKED_DATES_PATH, requestOrigin));
    if (res.ok) return await res.json();
  } catch (e) {
    console.error('Erreur lecture dates bloquées:', e);
  }
  return [];
}

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/disponibilites') {
        const property = url.searchParams.get('property') || 'duplex';
        const icsUrl = ICS_URLS[property];
        if (!icsUrl) return new Response('Logement inconnu', { status: 400 });

        let events = [];
        try {
          const icsRes = await fetch(icsUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
          if (icsRes.ok) {
            const icsText = await icsRes.text();
            events = parseICSEvents(icsText);
          }
        } catch (err) {
          console.error('Erreur fetch iCal Superhote:', err);
        }

        const manualBlocked = await fetchBlockedDates(env, request.url);

        const allBlocked = [
          ...events.map(e => ({ 
            start: e.start.toISOString().split('T')[0], 
            end: e.end.toISOString().split('T')[0] 
          })),
          ...manualBlocked.filter(b => b.property === property)
        ];

        return new Response(JSON.stringify(allBlocked), {
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/api/calculate-price' && request.method === 'POST') {
        const body = await request.json();
        const { property, startDate, endDate, guests = 2 } = body;

        const tarifs = await fetchTarifs(env, request.url);
        const propTarifs = tarifs[property];
        if (!propTarifs) return new Response('Propriété inconnue', { status: 400 });

        const start = new Date(startDate);
        const end = new Date(endDate);
        const nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

        if (nights < propTarifs.minNights) {
          return new Response(JSON.stringify({ error: `Durée minimale : ${propTarifs.minNights} nuits` }), { status: 400, headers: corsHeaders(origin) });
        }

        let accommodationTotal = 0;
        let curr = new Date(start);
        while (curr < end) {
          const dateStr = curr.toISOString().split('T')[0];
          const customPrice = propTarifs.customPrices && propTarifs.customPrices[dateStr];
          accommodationTotal += customPrice || propTarifs.basePrice;
          curr.setDate(curr.getDate() + 1);
        }

        const cleaningFee = propTarifs.cleaningFee || 0;
        const taxPerPersonPerNight = propTarifs.touristTaxPerPersonPerNight || 0;
        const totalTouristTax = taxPerPersonPerNight * guests * nights;
        const totalAmount = accommodationTotal + cleaningFee + totalTouristTax;

        const daysUntilCheckin = Math.ceil((start - new Date()) / (1000 * 60 * 60 * 24));
        const isDepositEligible = daysUntilCheckin > 30;
        const depositAmount = isDepositEligible ? Math.round(accommodationTotal * 0.3) + cleaningFee + totalTouristTax : totalAmount;

        return new Response(JSON.stringify({
          nights,
          accommodationTotal,
          cleaningFee,
          totalTouristTax,
          totalAmount,
          isDepositEligible,
          depositAmount,
          remainingBalance: totalAmount - depositAmount
        }), { headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/checkout' && request.method === 'POST') {
        const body = await request.json();
        const stripe = getStripe(env);
        const { property, startDate, endDate, name, email, phone, guests, optionDeposit } = body;

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          customer_email: email,
          line_items: [{
            price_data: {
              currency: 'eur',
              product_data: { name: `Réservation ${PROPERTY_NAMES[property]} (${startDate} au ${endDate})` },
              unit_amount: Math.round(body.amountToPay * 100),
            },
            quantity: 1,
          }],
          metadata: { property, startDate, endDate, name, email, phone, guests, optionDeposit: optionDeposit ? 'true' : 'false' },
          success_url: `${SITE_URL}/reservation-confirmee.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${SITE_URL}/reservation-annulee.html`,
        });

        return new Response(JSON.stringify({ url: session.url }), {
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/api/webhook' && request.method === 'POST') {
        const signature = request.headers.get('stripe-signature');
        const stripe = getStripe(env);
        const bodyText = await request.text();

        let event;
        try {
          event = stripe.webhooks.constructEvent(bodyText, signature, env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
          return new Response(`Webhook Error: ${err.message}`, { status: 400 });
        }

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const meta = session.metadata;

          const emailBody = `
            <h2>Nouvelle réservation directe enregistrée !</h2>
            <p><b>Logement :</b> ${PROPERTY_NAMES[meta.property]}</p>
            <p><b>Client :</b> ${meta.name}</p>
            <p><b>Email :</b> ${meta.email}</p>
            <p><b>Téléphone :</b> ${meta.phone}</p>
            <p><b>Dates :</b> Du ${meta.startDate} au ${meta.endDate}</p>
            <p><b>Voyageurs :</b> ${meta.guests}</p>
            <p><b>Montant encaissement Stripe :</b> ${session.amount_total / 100} €</p>
            <hr>
            <p><i>N'oubliez pas d'ajouter cette réservation manuellement dans votre application Superhote pour bloquer ces dates sur les autres plateformes.</i></p>
          `;

          await sendEmail(env, {
            to: OWNER_EMAIL,
            subject: `[Réservation Directe] ${PROPERTY_NAMES[meta.property]} - ${meta.name}`,
            html: emailBody
          });

          await sendEmail(env, {
            to: meta.email,
            subject: 'Confirmation de votre réservation - Les Loges de Véro',
            html: `<p>Bonjour ${meta.name},</p><p>Nous avons bien confirmé votre réservation pour le <b>${PROPERTY_NAMES[meta.property]}</b> du ${meta.startDate} au ${meta.endDate}.</p><p>A très bientôt !</p>`
          });
        }

        return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      return await env.ASSETS.fetch(request);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
      });
    }
  }
};
