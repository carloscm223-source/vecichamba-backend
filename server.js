/**
 * Procesa la actualización de Firestore en segundo plano para no bloquear
 * la respuesta a Stripe ni provocar errores de timeout.
 */
async function processWebhookEventInBackground(event) {
  try {
    // Procesar evento de pago completado en Stripe PaymentIntent
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const paymentIntentId = paymentIntent.id;
      console.log('💰 [payment_intent.succeeded] (Segundo Plano) ID:', paymentIntentId);

      // 1. Buscar en Firestore tareas por paymentIntentId
      const tasksQuery = await db.collection('tasks')
        .where('paymentIntentId', '==', paymentIntentId)
        .get();

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
          console.log(`✅ [FIRESTORE] Tarea ${doc.id} actualizada a ACTIVE vía paymentIntentId: ${paymentIntentId}`);
        }
      }

      // 2. Comprobar si viene taskId en metadata
      const taskId = (paymentIntent.metadata && (paymentIntent.metadata.taskId || paymentIntent.metadata.client_reference_id)) ||
                     paymentIntent.client_reference_id;
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
          console.log(`✅ [FIRESTORE] Tarea ${taskId} actualizada a ACTIVE desde metadata en payment_intent.succeeded`);
        }
      }

      // 3. Registrar en colección 'payments'
      const docId = taskId ? taskId.toString() : paymentIntentId;
      await db.collection('payments').doc(docId).set({
        taskId: taskId ? taskId.toString() : '',
        paymentIntentId: paymentIntentId,
        status: 'paid',
        amount: paymentIntent.amount ? paymentIntent.amount / 100 : 1.00,
        currency: paymentIntent.currency ? paymentIntent.currency.toUpperCase() : 'EUR',
        paidAt: Date.now(),
        updatedAt: Date.now()
      }, { merge: true });

    } else if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('💰 [PAGO EXITOSO] (Segundo Plano) Stripe Checkout Session ID:', session.id);

      // Obtener el taskId desde client_reference_id o metadata
      const taskId = session.client_reference_id || (session.metadata && session.metadata.taskId);
      const paymentIntentId = session.payment_intent || session.id;

      if (taskId) {
        console.log(`📌 Vinculando pago de 1,00 € a la tarea ID: ${taskId}`);

        const paymentRef = db.collection('payments').doc(taskId.toString());
        await paymentRef.set({
          taskId: taskId.toString(),
          paymentIntentId: paymentIntentId ? paymentIntentId.toString() : '',
          status: 'paid',
          sessionId: session.id,
          amount: session.amount_total ? session.amount_total / 100 : 1.00,
          currency: session.currency ? session.currency.toUpperCase() : 'EUR',
          customerEmail: session.customer_details ? session.customer_details.email : null,
          paidAt: Date.now(),
          updatedAt: Date.now()
        }, { merge: true });

        // Si la tarea existe en la colección tasks, actualizar su estado de publicación a ACTIVE
        try {
          const taskRef = db.collection('tasks').doc(taskId.toString());
          const taskSnap = await taskRef.get();
          if (taskSnap.exists) {
            await taskRef.update({
              status: 'ACTIVE',
              paymentIntentId: paymentIntentId ? paymentIntentId.toString() : (taskSnap.data().paymentIntentId || ''),
              paymentStatus: 'PAID',
              paymentTxId: session.id,
              paymentReference: paymentIntentId ? paymentIntentId.toString() : session.id,
              publicationFeePaid: true,
              updatedAt: Date.now()
            });
            console.log(`✅ [FIRESTORE] Tarea ${taskId} actualizada a status 'ACTIVE'`);
          }
        } catch (taskErr) {
          console.warn(`No se pudo actualizar el documento /tasks/${taskId}:`, taskErr.message);
        }

        console.log(`✅ [FIRESTORE] Colección 'payments' y tarea actualizadas a status 'paid'/ACTIVE para taskId: ${taskId}`);
      } else {
        console.warn('⚠️ Evento checkout.session.completed recibido sin client_reference_id:', session.id);
      }
    }
  } catch (dbError) {
    console.error('❌ Error guardando en Firestore en segundo plano:', dbError);
  }
}

/**
 * Manejador unificado para el Webhook de Stripe.
 * Responde 200 OK inmediatamente tras verificar la firma y ejecuta
 * la actualización de Firebase en segundo plano sin bloquear.
 */
function handleStripeWebhook(req, res) {
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

  // 1. Responder INMEDIATAMENTE a Stripe con 200 OK para evitar timeouts
  res.status(200).json({ received: true });

  // 2. Ejecutar la actualización de Firestore en segundo plano (sin await)
  processWebhookEventInBackground(event).catch(bgErr => {
    console.error('❌ Error no controlado en proceso en segundo plano:', bgErr);
  });
}

// Escuchar tanto en /stripeWebhook como en /webhook con express.raw
app.post('/stripeWebhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
