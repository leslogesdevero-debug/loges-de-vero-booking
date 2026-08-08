// ===========================================================================
// Fonction serveur : calcule le prix, revérifie la disponibilité, puis crée
// une session de paiement Stripe. La clé secrète Stripe reste ici, jamais
// dans le site public.
// ===========================================================================

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// -------- À adapter à votre configuration --------
const SITE_URL = 'https://leslogesdevero.fr'; // vos pages de confirmation/annulation
const ALLOWED_ORIGIN = 'https://extraordinary-cuchufli-7c8423.netlify.app'; // où le widget est intégré (iframe)
const TARIFS_URL = 'https://extraordinary-cuchufli-7c8423.netlify.app/tarifs.json';
const ICS_URLS = {
  duplex: 'https://app.superhote.com/export-ics/pCsTr5ULxk',
  rdc: 'https://app.superhote.com/export-ics/qCQMbqI1LK'
};
const PROPERTY_NAMES = { duplex: 'Le Duplex', rdc: 'Le Rez-de-chaussée' };
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Adresse d'expédition : utilisez onboarding@resend.dev tant que votre domaine
// n'est pas vérifié sur Resend, puis remplacez par une adresse @leslogesdevero.fr
const FROM_EMAIL = 'Les Loges de Véro <onboarding@resend.dev>';
// Adresse à laquelle vous recevez une notification de chaque pré-réservation
const OWNER_EMAIL = 'contact@leslogesdevero.fr';
// --------------------------------------------------

async function sendEmail(to, subject, html){
  if(!RESEND_API_KEY) return; // envoi désactivé si la clé n'est pas configurée
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
  });
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
    while (d < ev.end) {
      set.add(fmt(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return set;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };

  try {
    const { property, checkin, checkout, adults, children, guest } = JSON.parse(event.body || '{}');

    const g = guest || {};
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email || '');
    const telOk = (g.telephone || '').replace(/[^0-9+]/g, '').length >= 8;
    if (!g.prenom || !g.nom || !g.adresse || !telOk || !emailOk) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Merci de renseigner des coordonnées complètes et valides.' }) };
    }

    if (!PROPERTY_NAMES[property]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Logement inconnu.' }) };
    }

    const start = new Date(checkin + 'T00:00:00Z');
    const end = new Date(checkout + 'T00:00:00Z');
    const nights = Math.round((end - start) / 86400000);
    const adultsCount = parseInt(adults, 10);
    const childrenCount = parseInt(children, 10) || 0;

    if (!checkin || !checkout || !(nights > 0)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dates invalides.' }) };
    }

    if (!Number.isInteger(adultsCount) || adultsCount < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nombre d\'adultes invalide.' }) };
    }

    if (!Number.isInteger(childrenCount) || childrenCount < 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nombre d\'enfants invalide.' }) };
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

    if (tarif.maxGuests && (adultsCount + childrenCount) > tarif.maxGuests) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Ce logement accueille au maximum ${tarif.maxGuests} personnes.` }) };
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

    // 3. Calcul du montant (logement + taxe de séjour, calculée séparément)
    const cleaningFee = tarif.cleaningFee || 0;
    const accommodationCents = Math.round((tarif.nightly * nights + cleaningFee) * 100);
    const taxeParUnite = tarif.taxeSejourParAdulteParNuit || 0;
    const taxeUnitCents = Math.round(taxeParUnite * 100);
    const taxeQuantity = adultsCount * nights;

    const lineItems = [{
      price_data: {
        currency: 'eur',
        unit_amount: accommodationCents,
        product_data: {
          name: `${PROPERTY_NAMES[property]} — du ${checkin} au ${checkout} (${nights} nuit${nights > 1 ? 's' : ''})`
        }
      },
      quantity: 1
    }];

    if (taxeUnitCents > 0 && taxeQuantity > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          unit_amount: taxeUnitCents,
          product_data: {
            name: `Taxe de séjour (${adultsCount} adulte${adultsCount > 1 ? 's' : ''} × ${nights} nuit${nights > 1 ? 's' : ''})`
          }
        },
        quantity: taxeQuantity
      });
    }

    // 4. Création de la session de paiement Stripe
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

    // 5. Email de pré-réservation au client (ne bloque pas la réservation en cas d'échec d'envoi)
    try {
      await sendEmail(
        g.email,
        'Votre pré-réservation — Les Loges de Véro',
        `<p>Bonjour ${g.prenom},</p>
         <p>Nous avons bien reçu votre demande de réservation pour <strong>${PROPERTY_NAMES[property]}</strong>, ${datesTxt}, pour ${occupantsTxt}.</p>
         <p><strong>Cette pré-réservation est en attente de confirmation de votre paiement.</strong> Si le paiement n'a pas encore été finalisé, merci de retourner sur la page de paiement pour le compléter.</p>
         <p>Montant total : <strong>${totalTTC} €</strong> (taxe de séjour incluse).</p>
         <p>Vous recevrez une confirmation définitive dès que le paiement sera validé.</p>
         <p>À bientôt,<br>Les Loges de Véro</p>`
      );
    } catch (e) { /* on n'interrompt pas la réservation si l'email échoue */ }

    // 6. Notification au propriétaire
    try {
      await sendEmail(
        OWNER_EMAIL,
        `Nouvelle pré-réservation — ${PROPERTY_NAMES[property]}`,
        `<p>Nouvelle demande de réservation, ${datesTxt}, pour ${occupantsTxt}.</p>
         <p><strong>${g.prenom} ${g.nom}</strong><br>
         ${g.adresse}<br>
         Tél : ${g.telephone}<br>
         Email : ${g.email}</p>
         <p>Montant total : ${totalTTC} €</p>
         <p>En attente de confirmation du paiement.</p>`
      );
    } catch (e) { /* idem */ }

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Erreur serveur.' }) };
  }
};
