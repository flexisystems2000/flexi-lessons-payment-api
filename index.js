'use strict';

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// ======================================================
// 1. ENVIRONMENT CONFIGURATION
// ======================================================

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const FIREBASE_SERVICE_ACCOUNT_JSON =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

const PORT = process.env.PORT || 3000;

// Allowed frontend origins.
// You can override this list through Vercel environment variables.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://flexieduconsult.com.ng',
  'https://www.flexieduconsult.com.ng',
  'https://elearning.flexieduconsult.com.ng',
  'https://flexisystems2000.github.io',
  'http://localhost:3000',
  'http://localhost:5500'
];

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ||
  DEFAULT_ALLOWED_ORIGINS.join(',')
)
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Permit server-to-server requests and local API testing.
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/$/, '');

      if (ALLOWED_ORIGINS.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed by CORS'));
    },

    methods: ['GET', 'POST', 'OPTIONS'],

    allowedHeaders: ['Content-Type', 'Authorization'],

    credentials: false,

    maxAge: 86400
  })
);

// ======================================================
// 2. FIREBASE ADMIN INITIALIZATION
// ======================================================

let db;
let firebaseInitializationError = null;

try {
  if (!admin.apps.length) {
    if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not configured.'
      );
    }

    const serviceAccount = JSON.parse(
      FIREBASE_SERVICE_ACCOUNT_JSON
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();

  console.log('Firebase Admin initialized.');
} catch (error) {
  firebaseInitializationError = error.message;

  console.error(
    'Firebase initialization failed:',
    error.message
  );
}

// ======================================================
// 3. PAYMENT PLAN CONFIGURATION
// ======================================================

// These are the NET package prices in naira.
// Keep these synchronized with Page 3.
//
// monthly   = ₦4,000
// twoMonths = ₦7,500
// threeMonths = ₦10,000

const PAYMENT_PLANS = {
  monthly: 4000,
  twoMonths: 7500,
  threeMonths: 10000
};

// Normalize the plan values that may be saved by Page 3.
function normalizePlan(value) {
  if (!value) {
    return null;
  }

  const plan = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

  const aliases = {
    monthly: 'monthly',
    onemonth: 'monthly',
    '1month': 'monthly',
    one: 'monthly',

    twomonths: 'twoMonths',
    twomonth: 'twoMonths',
    '2months': 'twoMonths',
    '2month': 'twoMonths',

    threemonths: 'threeMonths',
    threemonth: 'threeMonths',
    '3months': 'threeMonths',
    '3month': 'threeMonths'
  };

  return aliases[plan] || null;
}

// This must match the gross-amount calculation used by Page 3.
//
// IMPORTANT:
// Confirm the actual amount charged at Paystack checkout before
// using this formula for production. Paystack's applicable fees
// and any fee handling in Page 3 must agree with this calculation.

function calculateGrossAmountNaira(netAmountNaira) {
  return Math.ceil(
    (netAmountNaira + 100) / (1 - 0.015)
  );
}

function getExpectedAmountKobo(registration) {
  // Preferred: store the exact expected checkout amount in kobo
  // when creating the registration.
  if (
    Number.isSafeInteger(registration.expectedAmountKobo) &&
    registration.expectedAmountKobo > 0
  ) {
    return registration.expectedAmountKobo;
  }

  // Alternative: use an explicitly stored gross amount in naira.
  if (
    Number.isFinite(Number(registration.grossAmount)) &&
    Number(registration.grossAmount) > 0
  ) {
    return Math.round(
      Number(registration.grossAmount) * 100
    );
  }

  // Backwards-compatible fallback for the existing plan names.
  const normalizedPlan = normalizePlan(
    registration.subscriptionPlan
  );

  if (!normalizedPlan) {
    return null;
  }

  const netAmount = PAYMENT_PLANS[normalizedPlan];

  const grossAmount = calculateGrossAmountNaira(netAmount);

  return grossAmount * 100;
}

// ======================================================
// 4. GENERAL HELPERS
// ======================================================

function normalizePaymentStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isPaymentConfirmed(registration) {
  return (
    registration.paymentStatus === true ||
    normalizePaymentStatus(registration.paymentStatus) ===
      'paid'
  );
}

function safeString(value) {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function requireConfiguration(res) {
  if (firebaseInitializationError || !db) {
    res.status(503).json({
      success: false,
      error: 'The database service is not ready.'
    });

    return false;
  }

  if (!PAYSTACK_SECRET_KEY) {
    res.status(503).json({
      success: false,
      error: 'The payment service is not configured.'
    });

    return false;
  }

  return true;
}

// ======================================================
// 5. HEALTH CHECK
// ======================================================

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Flexi Lessons Payment API',
    status: 'running',
    version: '1.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Flexi Lessons Payment API',
    status: 'running',
    firebaseReady: Boolean(db),
    paystackConfigured: Boolean(PAYSTACK_SECRET_KEY)
  });
});

// ======================================================
// 6. VERIFY PAYSTACK PAYMENT
// ======================================================

app.post('/api/verify-payment', async (req, res) => {
  if (!requireConfiguration(res)) {
    return;
  }

  try {
    const registrationId = safeString(
      req.body.registrationId
    );

    const reference = safeString(
      req.body.reference
    );

    // --------------------------------------------------
    // Validate input
    // --------------------------------------------------

    if (!registrationId || !reference) {
      return res.status(400).json({
        success: false,
        error: 'Registration ID and transaction reference are required.'
      });
    }

    // Avoid excessively long or malformed input.
    if (
      registrationId.length > 150 ||
      reference.length > 200
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid registration ID or transaction reference.'
      });
    }

    // --------------------------------------------------
    // Find the student's registration
    // --------------------------------------------------

    const registrationRef = db
      .collection('registrations')
      .doc(registrationId);

    const registrationSnapshot =
      await registrationRef.get();

    if (!registrationSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: 'Registration record was not found.'
      });
    }

    const registration = registrationSnapshot.data();

    // --------------------------------------------------
    // Ensure the reference belongs to this registration
    // --------------------------------------------------

    const savedReference = safeString(
      registration.paystackReference
    );

    const registrationReference = safeString(
      registration.registrationId
    );

    const referenceMatches =
      reference === registrationId ||
      reference === registrationReference ||
      reference === savedReference;

    if (!referenceMatches) {
      return res.status(403).json({
        success: false,
        error: 'The transaction reference does not match this registration.'
      });
    }

    // --------------------------------------------------
    // Return early if this payment is already confirmed
    // --------------------------------------------------

    if (
      isPaymentConfirmed(registration) &&
      (
        !savedReference ||
        reference === savedReference ||
        reference === registrationId
      )
    ) {
      return res.status(200).json({
        success: true,
        verified: true,
        alreadyConfirmed: true,
        registrationId,
        paymentStatus: 'paid',
        message: 'This registration already has a confirmed payment.'
      });
    }

    // --------------------------------------------------
    // Verify the transaction directly with Paystack
    // --------------------------------------------------

    const paystackResponse = await fetch(
      'https://api.paystack.co/transaction/verify/' +
        encodeURIComponent(reference),
      {
        method: 'GET',

        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          Accept: 'application/json'
        },

        signal: AbortSignal.timeout(15000)
      }
    );

    let paystackResult;

    try {
      paystackResult = await paystackResponse.json();
    } catch {
      return res.status(502).json({
        success: false,
        error: 'Paystack returned an invalid response.'
      });
    }

    if (
      !paystackResponse.ok ||
      paystackResult.status !== true ||
      !paystackResult.data
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'Paystack could not verify this transaction.'
      });
    }

    const transaction = paystackResult.data;

    // --------------------------------------------------
    // Check transaction status
    // --------------------------------------------------

    if (transaction.status !== 'success') {
      return res.status(200).json({
        success: true,
        verified: false,
        registrationId,
        paymentStatus: 'unconfirmed',
        transactionStatus: transaction.status || 'unknown',
        message: 'The transaction has not been confirmed as successful.'
      });
    }

    // --------------------------------------------------
    // Confirm the Paystack reference
    // --------------------------------------------------

    if (transaction.reference !== reference) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The transaction reference returned by Paystack does not match.'
      });
    }

    // --------------------------------------------------
    // Check currency
    // --------------------------------------------------

    if (transaction.currency !== 'NGN') {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The transaction currency does not match NGN.'
      });
    }

    // --------------------------------------------------
    // Check expected amount
    // --------------------------------------------------

    const expectedAmountKobo =
      getExpectedAmountKobo(registration);

    if (
      !Number.isSafeInteger(expectedAmountKobo) ||
      expectedAmountKobo <= 0
    ) {
      console.error(
        'Expected payment amount missing or invalid:',
        registrationId
      );

      return res.status(409).json({
        success: false,
        verified: false,
        error: 'The expected payment amount is missing or invalid. Check the registration plan and checkout amount.'
      });
    }

    if (transaction.amount !== expectedAmountKobo) {
      console.error('Payment amount mismatch:', {
        registrationId,
        expectedAmountKobo,
        actualAmountKobo: transaction.amount
      });

      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The verified payment amount does not match the expected amount.'
      });
    }

    // --------------------------------------------------
    // Check plan and registration
    // --------------------------------------------------

    if (
      registration.registrationId &&
      registration.registrationId !== registrationId
    ) {
      return res.status(400).json({
        success: false,
        error: 'The registration ID does not match the stored record.'
      });
    }

    // --------------------------------------------------
    // Update Firestore only after successful verification
    // --------------------------------------------------

    const confirmedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async firestoreTransaction => {
      const freshSnapshot =
        await firestoreTransaction.get(registrationRef);

      if (!freshSnapshot.exists) {
        throw new Error('Registration disappeared during verification.');
      }

      const freshData = freshSnapshot.data();

      // Prevent a different saved transaction reference from
      // silently replacing the original transaction.
      const freshSavedReference = safeString(
        freshData.paystackReference
      );

      if (
        freshSavedReference &&
        freshSavedReference !== reference
      ) {
        throw new Error(
          'The stored payment reference changed during verification.'
        );
      }

      firestoreTransaction.set(
        registrationRef,
        {
          registrationId,

          paystackReference: reference,

          paymentStatus: true,

          paymentVerificationPending: false,

          paymentVerified: true,

          paymentMethod: 'Paystack',

          paymentCurrency: transaction.currency,

          paymentAmountKobo: transaction.amount,

          paymentAmountNaira: transaction.amount / 100,

          paystackTransactionId: String(
            transaction.id || ''
          ),

          paymentChannel: transaction.channel || null,

          paymentVerifiedAt: confirmedAt,

          paymentUpdatedAt: confirmedAt
        },
        { merge: true }
      );
    });

    // --------------------------------------------------
    // Success response
    // --------------------------------------------------

    return res.status(200).json({
      success: true,
      verified: true,
      registrationId,
      reference,
      paymentStatus: 'paid',
      amount: transaction.amount / 100,
      currency: transaction.currency,
      message: 'Payment successfully verified.'
    });

  } catch (error) {
    console.error(
      'Payment verification error:',
      error.message
    );

    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError'
    ) {
      return res.status(504).json({
        success: false,
        error: 'Paystack verification timed out. Please try again later.'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'An internal error occurred while verifying the payment.'
    });
  }
});

// ======================================================
// 7. UNKNOWN ROUTES
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found.'
  });
});

// ======================================================
// 8. ERROR HANDLER
// ======================================================

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.message === 'Origin not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'This website is not permitted to access the API.'
    });
  }

  console.error('Unhandled API error:', error.message);

  return res.status(500).json({
    success: false,
    error: 'Internal server error.'
  });
});

// ======================================================
// 9. EXPORT FOR VERCEL
// ======================================================

// Vercel detects and deploys the exported Express app.
// The local listener is only used when running locally.

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `Flexi Lessons Payment API running on port ${PORT}`
    );
  });
}
