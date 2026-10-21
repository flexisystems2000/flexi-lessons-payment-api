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
      // Requests without an Origin header can be server-to-server.
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

// These are the package prices before the checkout fee.
//
// monthly   = ₦4,000
// twoMonths = ₦7,500
// threeMonths = ₦10,000
//
// Keep these synchronized with page3.html and renewal.html.

const PAYMENT_PLANS = {
  monthly: 4000,
  twoMonths: 7500,
  threeMonths: 10000
};

const PLAN_MONTHS = {
  monthly: 1,
  twoMonths: 2,
  threeMonths: 3
};

const PLAN_LABELS = {
  monthly: '1 Month',
  twoMonths: '2 Months',
  threeMonths: '3 Months'
};

// ======================================================
// 4. GENERAL HELPERS
// ======================================================

function safeString(value) {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function normalizePaymentStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isPaymentConfirmed(registration) {
  return (
    registration.paymentStatus === true ||
    normalizePaymentStatus(registration.paymentStatus) === 'paid'
  );
}

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

// Must match the checkout calculation used by the frontend.
function calculateGrossAmountNaira(netAmountNaira) {
  return Math.ceil(
    (netAmountNaira + 100) / (1 - 0.015)
  );
}

function getExpectedAmountKobo(registration) {
  if (
    Number.isSafeInteger(registration.expectedAmountKobo) &&
    registration.expectedAmountKobo > 0
  ) {
    return registration.expectedAmountKobo;
  }

  if (
    Number.isFinite(Number(registration.grossAmount)) &&
    Number(registration.grossAmount) > 0
  ) {
    return Math.round(
      Number(registration.grossAmount) * 100
    );
  }

  const normalizedPlan = normalizePlan(
    registration.subscriptionPlan
  );

  if (!normalizedPlan) {
    return null;
  }

  const netAmount = PAYMENT_PLANS[normalizedPlan];

  return calculateGrossAmountNaira(netAmount) * 100;
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

// Parse supported Firestore timestamp and date values.
function dateFromStoredValue(value) {
  if (!value) {
    return null;
  }

  if (typeof value.toDate === 'function') {
    return value.toDate();
  }

  if (
    typeof value === 'object' &&
    typeof value.seconds === 'number'
  ) {
    return new Date(value.seconds * 1000);
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed;
}

// Add calendar months without rolling dates into the wrong month.
// Example: January 31 + one month becomes the last day of February.
function addCalendarMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getDate();

  result.setDate(1);
  result.setMonth(result.getMonth() + months);

  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();

  result.setDate(Math.min(originalDay, lastDay));

  return result;
}

// ======================================================
// 5. HEALTH CHECK
// ======================================================

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Flexi Lessons Payment API',
    status: 'running',
    version: '1.1.0'
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
// 6. VERIFY ORIGINAL REGISTRATION PAYMENT
// ======================================================
//
// This endpoint is retained for the existing registration
// payment process. The renewal flow has its own endpoint below.
//
// Existing flow:
// page2.html -> page3.html -> Paystack -> page4.html
//
// Do not use this endpoint to apply subscription renewals.

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

    if (!registrationId || !reference) {
      return res.status(400).json({
        success: false,
        error:
          'Registration ID and transaction reference are required.'
      });
    }

    if (
      registrationId.length > 150 ||
      reference.length > 200
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid registration ID or transaction reference.'
      });
    }

    const registrationRef = db
      .collection('registrations')
      .doc(registrationId);

    const registrationSnapshot = await registrationRef.get();

    if (!registrationSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: 'Registration record was not found.'
      });
    }

    const registration = registrationSnapshot.data();

    const savedReference = safeString(
      registration.paystackReference
    );

    const storedRegistrationId = safeString(
      registration.registrationId
    );

    const referenceMatches =
      reference === registrationId ||
      reference === storedRegistrationId ||
      reference === savedReference;

    if (!referenceMatches) {
      return res.status(403).json({
        success: false,
        error:
          'The transaction reference does not match this registration.'
      });
    }

    // Preserve the existing initial-payment idempotency behaviour.
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
        message:
          'This registration already has a confirmed payment.'
      });
    }

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

    if (transaction.status !== 'success') {
      return res.status(200).json({
        success: true,
        verified: false,
        registrationId,
        paymentStatus: 'unconfirmed',
        transactionStatus: transaction.status || 'unknown',
        message:
          'The transaction has not been confirmed as successful.'
      });
    }

    if (transaction.reference !== reference) {
      return res.status(400).json({
        success: false,
        verified: false,
        error:
          'The transaction reference returned by Paystack does not match.'
      });
    }

    if (transaction.currency !== 'NGN') {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The transaction currency does not match NGN.'
      });
    }

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
        error:
          'The expected payment amount is missing or invalid.'
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
        error:
          'The verified payment amount does not match the expected amount.'
      });
    }

    if (
      registration.registrationId &&
      registration.registrationId !== registrationId
    ) {
      return res.status(400).json({
        success: false,
        error:
          'The registration ID does not match the stored record.'
      });
    }

    const confirmedAt =
      admin.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async firestoreTransaction => {
      const freshSnapshot =
        await firestoreTransaction.get(registrationRef);

      if (!freshSnapshot.exists) {
        throw new Error(
          'Registration disappeared during verification.'
        );
      }

      const freshData = freshSnapshot.data();

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
        error:
          'Paystack verification timed out. Please try again later.'
      });
    }

    return res.status(500).json({
      success: false,
      error:
        'An internal error occurred while verifying the payment.'
    });
  }
});

// ======================================================
// 7. VERIFY SUBSCRIPTION RENEWAL
// ======================================================
//
// Endpoint:
// POST /api/verify-renewal
//
// Request body:
// {
//   "registrationId": "EXISTING_REGISTRATION_ID",
//   "renewalId": "FLEXIRENEW_...",
//   "reference": "PAYSTACK_TRANSACTION_REFERENCE"
// }
//
// Renewal process:
// 1. Find the existing registration.
// 2. Check the pending renewal details.
// 3. Verify the transaction directly with Paystack.
// 4. Validate the reference, status, currency and amount.
// 5. Atomically record the transaction and extend the existing
//    student's subscription.
// 6. Prevent the same reference from extending a subscription twice.

app.post('/api/verify-renewal', async (req, res) => {
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

    const renewalId = safeString(
      req.body.renewalId
    );

    if (
      !registrationId ||
      !reference ||
      !renewalId ||
      registrationId.length > 150 ||
      reference.length > 200 ||
      renewalId.length > 200
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        error:
          'Registration ID, renewal ID and transaction reference are required.'
      });
    }

    // --------------------------------------------------
    // A. LOAD THE EXISTING STUDENT REGISTRATION
    // --------------------------------------------------

    const registrationRef = db
      .collection('registrations')
      .doc(registrationId);

    const initialSnapshot = await registrationRef.get();

    if (!initialSnapshot.exists) {
      return res.status(404).json({
        success: false,
        verified: false,
        error: 'Student registration was not found.'
      });
    }

    const initialData = initialSnapshot.data() || {};
    const pending = initialData.pendingRenewal || {};

    // --------------------------------------------------
    // B. MATCH THE REFERENCE TO THE PENDING RENEWAL
    // --------------------------------------------------

    const allowedReferences = [
      safeString(pending.expectedPaystackReference),
      safeString(pending.paystackReference)
    ].filter(Boolean);

    if (
      pending.renewalId !== renewalId ||
      !allowedReferences.includes(reference)
    ) {
      return res.status(403).json({
        success: false,
        verified: false,
        error:
          'The transaction does not match the pending renewal.'
      });
    }

    // The same renewal has already been applied.
    // Return success without extending the expiry again.
    if (
      pending.status === 'paid' &&
      pending.verifiedReference === reference
    ) {
      return res.status(200).json({
        success: true,
        verified: true,
        alreadyProcessed: true,
        registrationId,
        renewalId,
        reference,
        message:
          'This renewal payment was already processed.'
      });
    }

    // --------------------------------------------------
    // C. VALIDATE THE PACKAGE AND EXPECTED AMOUNT
    // --------------------------------------------------

    const normalizedPlan = normalizePlan(
      pending.planKey
    );

    const months = normalizedPlan
      ? PLAN_MONTHS[normalizedPlan]
      : 0;

    const netAmount = normalizedPlan
      ? PAYMENT_PLANS[normalizedPlan]
      : 0;

    const expectedGrossNaira = netAmount
      ? calculateGrossAmountNaira(netAmount)
      : 0;

    const expectedAmountKobo =
      expectedGrossNaira * 100;

    if (
      !months ||
      Number(pending.subscriptionMonths) !== months ||
      Number(pending.amountPaid) !== netAmount ||
      Number(pending.grossAmountPaid) !== expectedGrossNaira ||
      Number(pending.expectedAmountKobo) !== expectedAmountKobo ||
      pending.currency !== 'NGN'
    ) {
      return res.status(409).json({
        success: false,
        verified: false,
        error:
          'The pending renewal package or expected amount is invalid. Please contact support.'
      });
    }

    // --------------------------------------------------
    // D. VERIFY THE TRANSACTION DIRECTLY WITH PAYSTACK
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
        verified: false,
        error: 'Paystack returned an invalid response.'
      });
    }

    if (
      !paystackResponse.ok ||
      paystackResult.status !== true ||
      !paystackResult.data
    ) {
      return res.status(502).json({
        success: false,
        verified: false,
        error:
          'Paystack could not verify this renewal transaction.'
      });
    }

    const transaction = paystackResult.data;

    // --------------------------------------------------
    // E. CHECK THE ACTUAL TRANSACTION STATUS
    // --------------------------------------------------

    if (transaction.status !== 'success') {
      return res.status(200).json({
        success: true,
        verified: false,
        registrationId,
        renewalId,
        transactionStatus: transaction.status || 'unknown',
        message:
          'The transaction has not been confirmed as successful.'
      });
    }

    // --------------------------------------------------
    // F. CHECK THE TRANSACTION REFERENCE
    // --------------------------------------------------

    if (transaction.reference !== reference) {
      return res.status(400).json({
        success: false,
        verified: false,
        error:
          'Paystack returned a different transaction reference.'
      });
    }

    // --------------------------------------------------
    // G. CHECK THE TRANSACTION CURRENCY
    // --------------------------------------------------

    if (transaction.currency !== 'NGN') {
      return res.status(400).json({
        success: false,
        verified: false,
        error:
          'The transaction currency does not match NGN.'
      });
    }

    // --------------------------------------------------
    // H. CHECK THE EXACT PAYMENT AMOUNT
    // --------------------------------------------------

    if (transaction.amount !== expectedAmountKobo) {
      console.error('Renewal amount mismatch:', {
        registrationId,
        renewalId,
        expectedAmountKobo,
        actualAmountKobo: transaction.amount
      });

      return res.status(400).json({
        success: false,
        verified: false,
        error:
          'The verified payment amount does not match the selected renewal package.'
      });
    }

    // --------------------------------------------------
    // I. ATOMICALLY RECORD PAYMENT AND EXTEND SUBSCRIPTION
    // --------------------------------------------------

    const transactionRef = db
      .collection('paystackTransactions')
      .doc(reference);

    const verifiedAt =
      admin.firestore.FieldValue.serverTimestamp();

    let renewalResult = null;

    await db.runTransaction(async firestoreTransaction => {
      // Complete all reads before writing any documents.
      const [freshSnapshot, transactionSnapshot] =
        await Promise.all([
          firestoreTransaction.get(registrationRef),
          firestoreTransaction.get(transactionRef)
        ]);

      if (!freshSnapshot.exists) {
        throw new Error(
          'Student registration was not found during final verification.'
        );
      }

      const freshData = freshSnapshot.data() || {};
      const freshPending = freshData.pendingRenewal || {};

      // Another request may have completed this exact renewal.
      if (
        freshPending.status === 'paid' &&
        freshPending.verifiedReference === reference
      ) {
        renewalResult = {
          alreadyProcessed: true
        };

        return;
      }

      // Ensure the pending renewal has not changed since verification.
      const freshAllowedReferences = [
        safeString(freshPending.expectedPaystackReference),
        safeString(freshPending.paystackReference)
      ].filter(Boolean);

      if (
        freshPending.renewalId !== renewalId ||
        !freshAllowedReferences.includes(reference)
      ) {
        throw new Error(
          'The pending renewal changed during verification.'
        );
      }

      // A Paystack reference can be used only once.
      if (transactionSnapshot.exists) {
        const existingTransaction =
          transactionSnapshot.data() || {};

        if (
          existingTransaction.registrationId !== registrationId ||
          existingTransaction.renewalId !== renewalId
        ) {
          throw new Error(
            'This Paystack transaction reference has already been used.'
          );
        }

        renewalResult = {
          alreadyProcessed: true
        };

        return;
      }

      // ------------------------------------------------
      // CALCULATE THE AUTHORITATIVE SUBSCRIPTION EXPIRY
      // ------------------------------------------------

      const now = new Date();

      const currentExpiry =
        dateFromStoredValue(
          freshData.subscriptionExpiryDate
        ) ||
        dateFromStoredValue(
          freshData.expiryDate
        ) ||
        dateFromStoredValue(
          freshData.expiresAt
        ) ||
        dateFromStoredValue(
          freshData.subscriptionEndDate
        );

      // If the subscription is active, extend from its existing
      // expiry. Otherwise, start the renewed period now.
      const startDate =
        currentExpiry && currentExpiry > now
          ? currentExpiry
          : now;

      const expiryDate = addCalendarMonths(
        startDate,
        months
      );

      const startTimestamp =
        admin.firestore.Timestamp.fromDate(startDate);

      const expiryTimestamp =
        admin.firestore.Timestamp.fromDate(expiryDate);

      // ------------------------------------------------
      // RECORD THE UNIQUE PAYSTACK TRANSACTION
      // ------------------------------------------------

      firestoreTransaction.set(transactionRef, {
        registrationId,
        renewalId,
        reference,

        transactionId: String(
          transaction.id || ''
        ),

        amountKobo: transaction.amount,
        amountNaira: transaction.amount / 100,
        currency: transaction.currency,

        status: 'success',
        type: 'subscription_renewal',

        channel: transaction.channel || null,

        processedAt: verifiedAt
      });

      // ------------------------------------------------
      // UPDATE THE EXISTING STUDENT REGISTRATION
      // ------------------------------------------------

      firestoreTransaction.set(
        registrationRef,
        {
          // Preserve the existing registration/account.
          registrationId,

          subscriptionPlan: normalizedPlan,
          subscriptionLabel: PLAN_LABELS[normalizedPlan],
          subscriptionMonths: months,

          subscriptionStartDate: startTimestamp,
          subscriptionExpiryDate: expiryTimestamp,

          // Maintain compatibility with existing frontend fields.
          expiryDate: expiryTimestamp,
          subscriptionEndDate: expiryTimestamp,

          amountPaid: netAmount,
          grossAmountPaid: expectedGrossNaira,

          paymentStatus: true,
          paymentVerified: true,
          paymentVerificationPending: false,

          lastRenewalId: renewalId,
          lastRenewalReference: reference,

          lastRenewalAmountKobo: transaction.amount,
          lastRenewalAmountNaira: transaction.amount / 100,

          lastRenewalPaymentMethod: 'Paystack',
          lastRenewalCurrency: transaction.currency,

          lastRenewalTransactionId: String(
            transaction.id || ''
          ),

          lastRenewalChannel: transaction.channel || null,
          lastRenewalVerifiedAt: verifiedAt,

          pendingRenewal: {
            ...freshPending,

            status: 'paid',
            verifiedReference: reference,

            verifiedTransactionId: String(
              transaction.id || ''
            ),

            verifiedAt: new Date().toISOString(),

            appliedStartDate: startDate.toISOString(),
            appliedExpiryDate: expiryDate.toISOString()
          },

          updatedAt: verifiedAt
        },
        { merge: true }
      );

      renewalResult = {
        alreadyProcessed: false,
        expiryDate: expiryDate.toISOString()
      };
    });

    // --------------------------------------------------
    // J. SUCCESS RESPONSE
    // --------------------------------------------------

    return res.status(200).json({
      success: true,
      verified: true,

      alreadyProcessed: Boolean(
        renewalResult &&
        renewalResult.alreadyProcessed
      ),

      registrationId,
      renewalId,
      reference,

      amount: transaction.amount / 100,
      currency: transaction.currency,

      expiryDate:
        renewalResult &&
        renewalResult.expiryDate
          ? renewalResult.expiryDate
          : null,

      message:
        renewalResult && renewalResult.alreadyProcessed
          ? 'This renewal payment was already processed.'
          : 'Renewal payment verified and subscription extended.'
    });

  } catch (error) {
    console.error(
      'Renewal verification error:',
      error.message
    );

    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError'
    ) {
      return res.status(504).json({
        success: false,
        verified: false,
        error:
          'Paystack verification timed out. Check the transaction status before trying again.'
      });
    }

    if (
      /already been used|pending renewal changed|not found during final verification/i
        .test(error.message)
    ) {
      return res.status(409).json({
        success: false,
        verified: false,
        error: error.message
      });
    }

    return res.status(500).json({
      success: false,
      verified: false,
      error:
        'An internal error occurred while verifying the renewal. Do not pay again until the transaction is checked.'
    });
  }
});

// ======================================================
// 8. UNKNOWN ROUTES
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found.'
  });
});

// ======================================================
// 9. ERROR HANDLER
// ======================================================

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.message === 'Origin not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error:
        'This website is not permitted to access the API.'
    });
  }

  console.error(
    'Unhandled API error:',
    error.message
  );

  return res.status(500).json({
    success: false,
    error: 'Internal server error.'
  });
});

// ======================================================
// 10. EXPORT FOR VERCEL
// ======================================================

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `Flexi Lessons Payment API running on port ${PORT}`
    );
  });
}
