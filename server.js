require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Inicializar Firebase Admin SDK
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
    console.log('✅ Firebase Admin inicializado con Service Account personalizada');
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

// Obtener instancia de Firestore
const databaseId = process.env.FIRESTORE_DATABASE_ID || "ai-studio-android-vecicham-c3eb739c-16fe-485e-bb7f-97cf61d37af7";
let db;
try {
  const { getFirestore } = require('firebase-admin/firestore');
  db = (databaseId && databaseId !== '(default)') ? getFirestore(databaseId) : admin.firestore();
} catch (e) {
  db = admin.firestore();
}

// Configuración de Stripe
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

if (!STRIPE_SECRET_KEY) {
  console.warn('⚠️ AVISO: STRIPE_SECRET_KEY no está definida en las variables de entorno.');
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn('⚠️ AVISO: STRIPE_WEBHOOK_SECRET no está definida en las variables de entorno.');
}

const stripe = require('stripe')(STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

// Ruta de estado de salud (Health Check) requerida por Render
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'VeciChamba Stripe Webhook Server (Render)',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

/**
 * Manejador unificado para el Webhook de Stripe.
 * IMPORTANTE: Debe procesar el body como buffer binario crudo (rawBody)
 * para que stripe.webhooks.constructEvent pueda verificar la firma criptográfica.
 */
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (STRIPE_WEBHOOK_SECRET && STRIPE_WEBHOOK_SECRET !== 'whsec_...') {
      // Verificación de firma criptográfica
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // Fallback si aún no se ha configurado la firma
      const payload = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
      event = JSON.parse(payload);
    }
  } catch (err) {
    console.error('⚠️ Error validando webhook de Stripe:', err.message);
    return res.status(400).send(`Webhook Signature Error: ${err.message}`);
  }

  // Procesar evento de pago completado en Stripe Checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('💰 [PAGO EXITOSO] Stripe Checkout Session ID:', session.id);

    // Obtener el taskId desde client_reference_id o metadata
    const taskId = session.client_reference_id || (session.metadata && session.metadata.taskId);

    if (taskId) {
      console.log(`📌 Vinculando pago de 1,00 € a la tarea ID: ${taskId}`);

      try {
        const paymentRef = db.collection('payments').doc(taskId.toString());
        await paymentRef.set({
          taskId: taskId.toString(),
          status: 'paid',
          sessionId: session.id,
          amount: session.amount_total ? session.amount_total / 100 : 1.00,
          currency: session.currency ? session.currency.toUpperCase() : 'EUR',
          customerEmail: session.customer_details ? session.customer_details.email : null,
          paidAt: Date.now(),
          updatedAt: Date.now()
        }, { merge: true });

        // Si la tarea existe en la colección tasks, actualizar su estado de publicación
        try {
          const taskRef = db.collection('tasks').doc(taskId.toString());
          const taskSnap = await taskRef.get();
          if (taskSnap.exists) {
            await taskRef.update({
              paymentStatus: 'PAID',
              paymentTxId: session.id,
              publicationFeePaid: true
            });
          }
        } catch (taskErr) {
          console.warn(`No se pudo actualizar el documento /tasks/${taskId}:`, taskErr.message);
        }

        console.log(`✅ [FIRESTORE] Colección 'payments' actualizada a status 'paid' para taskId: ${taskId}`);
      } catch (dbError) {
        console.error('❌ Error guardando en Firestore desde Webhook:', dbError);
        return res.status(500).send('Database Error');
      }
    } else {
      console.warn('⚠️ Evento checkout.session.completed recibido sin client_reference_id:', session.id);
    }
  }

  res.status(200).json({ received: true });
}

// Escuchar tanto en /stripeWebhook como en /webhook con express.raw
app.post('/stripeWebhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// Middleware para el resto de rutas JSON si se añaden endpoints futuros
app.use(express.json());

// Iniciar servidor en el puerto dinámico de Render (process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor VeciChamba activo y escuchando en el puerto ${PORT}`);
  console.log(`📡 Endpoints disponibles para Stripe:`);
  console.log(`   - POST http://localhost:${PORT}/stripeWebhook`);
  console.log(`   - POST http://localhost:${PORT}/webhook`);
});
