require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

// 1. Inicializar Firebase Admin SDK
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount;
    const rawConfig = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    if (rawConfig.startsWith('{')) {
      serviceAccount = JSON.parse(rawConfig);
    } else {
      serviceAccount = require(rawConfig);
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin inicializado con cuenta de servicio personalizada');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
    console.log('✅ Firebase Admin inicializado mediante GOOGLE_APPLICATION_CREDENTIALS');
  } else {
    admin.initializeApp();
    console.log('ℹ️ Firebase Admin inicializado con credenciales predeterminadas');
  }
} catch (fbErr) {
  console.warn('⚠️ Advertencia al inicializar Firebase Admin:', fbErr.message);
}

const db = admin.firestore();

// 2. Configuración de Express
const app = express();
app.use(cors());

// Rutas de salud para Render
app.get('/', (req, res) => {
  res.status(200).json({ status: 'en línea', service: 'Backend VeciChamba' });
});
app.get('/salud', (req, res) => {
  res.status(200).send('OK');
});

// 3. Lógica del Webhook (Procesamiento en segundo plano)
async function processWebhookEventInBackground(event) {
  try {
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const paymentIntentId = paymentIntent.id;
      console.log('💰 [payment_intent.succeeded] ID:', paymentIntentId);

      const tasksQuery = await db.collection('tasks').where('paymentIntentId', '==', paymentIntentId).get();
      if (!tasksQuery.empty) {
        for (const doc of tasksQuery.docs) {
          await doc.ref.update({
            status: 'ACTIVE',
            publicationFeePaid: true,
            paymentStatus: 'PAID',
            paymentReference: paymentIntentId,
            paidAt: Date.now(),
            updatedAt: Date.now()
          });
          console.log(`✅ [FIRESTORE] Tarea ${doc.id} actualizada a ACTIVE`);
        }
      }

      const taskId = (paymentIntent.metadata && (paymentIntent.metadata.taskId || paymentIntent.metadata.client_reference_id)) || paymentIntent.client_reference_id;
      if (taskId) {
        const taskRef = db.collection('tasks').doc(taskId.toString());
        const taskSnap = await taskRef.get();
        if (taskSnap.exists) {
          await taskRef.update({
            status: 'ACTIVE',
            paymentIntentId: paymentIntentId,
            publicationFeePaid: true,
            paymentStatus: 'PAID',
            paymentReference: paymentIntentId,
            paidAt: Date.now(),
            updatedAt: Date.now()
          });
          console.log(`✅ [FIRESTORE] Tarea ${taskId} actualizada a ACTIVE desde metadata`);
        }
      }

    } else if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('💰 [PAGO EXITOSO] Checkout Session ID:', session.id);

      const taskId = session.client_reference_id || (session.metadata && session.metadata.taskId);
      const paymentIntentId = session.payment_intent || session.id;

      if (taskId) {
        console.log(`📌 Vinculando pago a la tarea ID: ${taskId}`);
        const paymentRef = db.collection('payments').doc(taskId.toString());
        await paymentRef.set({
          taskId: taskId.toString(),
          paymentIntentId: paymentIntentId ? paymentIntentId.toString() : '',
          status: 'paid',
          sessionId: session.id,
          amount: session.amount_total ? session.amount_total / 100 : 1.00,
          currency: session.currency ? session.currency.toUpperCase() : 'EUR',
          paidAt: Date.now(),
          updatedAt: Date.now()
        }, { merge: true });

        try {
          const taskRef = db.collection('tasks').doc(taskId.toString());
          const taskSnap = await taskRef.get();
          if (taskSnap.exists) {
            await taskRef.update({
              status: 'ACTIVE',
              paymentIntentId: paymentIntentId ? paymentIntentId.toString() : '',
              paymentStatus: 'PAID',
              paymentTxId: session.id,
              publicationFeePaid: true,
              updatedAt: Date.now()
            });
            console.log(`✅ [FIRESTORE] Tarea ${taskId} actualizada a ACTIVE`);
          }
        } catch (taskErr) {
          console.warn(`No se pudo actualizar la tarea ${taskId}:`, taskErr.message);
        }
      }
    }
  } catch (dbError) {
    console.error('❌ Error guardando en Firestore (Segundo plano):', dbError);
  }
}

// 4. Manejador del Webhook
function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET !== 'whsec_...') {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      const payload = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
      event = JSON.parse(payload);
    }
  } catch (err) {
    console.error('⚠️ Error validando webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // RESPONDER A STRIPE INMEDIATAMENTE (Evita el Timeout)
  res.status(200).json({ received: true });

  // Ejecutar actualización en segundo plano
  processWebhookEventInBackground(event).catch(bgErr => {
    console.error('❌ Error en proceso en segundo plano:', bgErr);
  });
}

// Rutas de webhook con express.raw
app.post('/stripeWebhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// 5. Arrancar el servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend VeciChamba escuchando en el puerto ${PORT}`);
});
