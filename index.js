
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400
}));

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
  console.error('Firebase initialization failed:', error.message);
}

// ======================================================
// 3. PAYMENT PLAN CONFIGURATION
// ======================================================

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
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePaymentStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isPaymentConfirmed(registration) {
  return (
    registration.paymentStatus === true ||
    normalizePaymentStatus(registration.paymentStatus) === 'paid'
  );
}

function normalizePlan(value) {
  if (!value) return null;

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

function calculateGrossAmountNaira(netAmountNaira) {
  return Math.ceil((netAmountNaira + 100) / (1 - 0.015));
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
    return Math.round(Number(registration.grossAmount) * 100);
  }

  const plan = normalizePlan(registration.subscriptionPlan);
  if (!plan) return null;

  return calculateGrossAmountNaira(PAYMENT_PLANS[plan]) * 100;
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

function dateFromStoredValue(value) {
  if (!value) return null;

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

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

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

function normalizeMasterclassEmail(value) {
  return safeString(value).toLowerCase();
}

function normalizeMasterclassPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0') && digits.length === 11) {
    digits = '234' + digits.slice(1);
  } else if (digits.length === 10) {
    digits = '234' + digits;
  }

  return digits;
}

function getRegistrationPhoneNumbers(registration) {
  return [
    registration.studentPhone,
    registration.whatsappNumber,
    registration.whatsapp,
    registration.phone
  ]
    .map(normalizeMasterclassPhone)
    .filter(Boolean);
}

function getMasterclassSubscriptionExpiry(registration) {
  const directExpiryFields = [
    registration.subscriptionExpiryDate,
    registration.expiryDate,
    registration.expiresAt,
    registration.subscriptionEndDate,
    registration.subscriptionExpiryDate
  ];

  for (const value of directExpiryFields) {
    const date = dateFromStoredValue(value);
    if (date) return date;
  }

  // Fallback for older registration records.
  // Never calculate an expiry for an unverified payment.
  if (
    registration.paymentStatus !== true ||
    registration.paymentVerified !== true
  ) {
    return null;
  }

  const months = Number(registration.subscriptionMonths);

  if (![1, 2, 3].includes(months)) {
    return null;
  }

  const startDate =
    dateFromStoredValue(registration.subscriptionStartDate) ||
    dateFromStoredValue(registration.paymentVerifiedAt) ||
    dateFromStoredValue(registration.paidAt) ||
    dateFromStoredValue(registration.createdAt);

  if (!startDate) return null;

  return addCalendarMonths(startDate, months);
}

async function verifyPaystackTransaction(reference) {
  const response = await fetch(
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

  let result;

  try {
    result = await response.json();
  } catch {
    const error = new Error('Paystack returned an invalid response.');
    error.statusCode = 502;
    throw error;
  }

  if (!response.ok || result.status !== true || !result.data) {
    const error = new Error('Paystack could not verify this transaction.');
    error.statusCode = 502;
    throw error;
  }

  return result.data;
}

// ======================================================
// 5. HEALTH CHECKS
// ======================================================

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Flexi Lessons Payment API',
    status: 'running',
    version: '1.2.0'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Flexi Lessons Payment API',
    status: 'running',
    firebaseReady: Boolean(db),
    paystackConfigured: Boolean(PAYSTACK_SECRET_KEY),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
  });
});

// ======================================================
// 6. VERIFY ORIGINAL REGISTRATION PAYMENT
// ======================================================

app.post('/api/verify-payment', async (req, res) => {
  if (!requireConfiguration(res)) return;

  try {
    const registrationId = safeString(req.body.registrationId);
    const reference = safeString(req.body.reference);

    if (
      !registrationId ||
      !reference ||
      registrationId.length > 150 ||
      reference.length > 200
    ) {
      return res.status(400).json({
        success: false,
        error: 'Registration ID and transaction reference are required.'
      });
    }

    const registrationRef = db
      .collection('registrations')
      .doc(registrationId);

    const snapshot = await registrationRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        error: 'Registration record was not found.'
      });
    }

    const registration = snapshot.data() || {};
    const savedReference = safeString(registration.paystackReference);
    const storedRegistrationId = safeString(registration.registrationId);

    const referenceMatches =
      reference === registrationId ||
      reference === storedRegistrationId ||
      reference === savedReference;

    if (!referenceMatches) {
      return res.status(403).json({
        success: false,
        error: 'The transaction reference does not match this registration.'
      });
    }

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

    const transaction = await verifyPaystackTransaction(reference);

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

    if (transaction.reference !== reference) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The transaction reference returned by Paystack does not match.'
      });
    }

    if (transaction.currency !== 'NGN') {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The transaction currency does not match NGN.'
      });
    }

    const expectedAmountKobo = getExpectedAmountKobo(registration);

    if (
      !Number.isSafeInteger(expectedAmountKobo) ||
      expectedAmountKobo <= 0
    ) {
      return res.status(409).json({
        success: false,
        verified: false,
        error: 'The expected payment amount is missing or invalid.'
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

    if (
      registration.registrationId &&
      registration.registrationId !== registrationId
    ) {
      return res.status(400).json({
        success: false,
        error: 'The registration ID does not match the stored record.'
      });
    }

    const confirmedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async transactionWriter => {
      const freshSnapshot = await transactionWriter.get(registrationRef);

      if (!freshSnapshot.exists) {
        throw new Error('Registration disappeared during verification.');
      }

      const freshData = freshSnapshot.data() || {};
      const freshReference = safeString(freshData.paystackReference);

      if (freshReference && freshReference !== reference) {
        throw new Error('The stored payment reference changed during verification.');
      }

      transactionWriter.set(registrationRef, {
        registrationId,
        paystackReference: reference,
        paymentStatus: true,
        paymentVerificationPending: false,
        paymentVerified: true,
        paymentMethod: 'Paystack',
        paymentCurrency: transaction.currency,
        paymentAmountKobo: transaction.amount,
        paymentAmountNaira: transaction.amount / 100,
        paystackTransactionId: String(transaction.id || ''),
        paymentChannel: transaction.channel || null,
        paymentVerifiedAt: confirmedAt,
        paymentUpdatedAt: confirmedAt
      }, { merge: true });
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
    console.error('Payment verification error:', error.message);

    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError'
    ) {
      return res.status(504).json({
        success: false,
        error: 'Paystack verification timed out. Please try again later.'
      });
    }

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode
        ? error.message
        : 'An internal error occurred while verifying the payment.'
    });
  }
});

// ======================================================
// 7. VERIFY SUBSCRIPTION RENEWAL
// ======================================================

app.post('/api/verify-renewal', async (req, res) => {
  if (!requireConfiguration(res)) return;

  try {
    const registrationId = safeString(req.body.registrationId);
    const reference = safeString(req.body.reference);
    const renewalId = safeString(req.body.renewalId);

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
        error: 'Registration ID, renewal ID and transaction reference are required.'
      });
    }

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
        error: 'The transaction does not match the pending renewal.'
      });
    }

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
        message: 'This renewal payment was already processed.'
      });
    }

    const normalizedPlan = normalizePlan(pending.planKey);
    const months = normalizedPlan ? PLAN_MONTHS[normalizedPlan] : 0;
    const netAmount = normalizedPlan ? PAYMENT_PLANS[normalizedPlan] : 0;
    const expectedGrossNaira = netAmount
      ? calculateGrossAmountNaira(netAmount)
      : 0;
    const expectedAmountKobo = expectedGrossNaira * 100;

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
        error: 'The pending renewal package or expected amount is invalid. Please contact support.'
      });
    }

    const transaction = await verifyPaystackTransaction(reference);

    if (transaction.status !== 'success') {
      return res.status(200).json({
        success: true,
        verified: false,
        registrationId,
        renewalId,
        transactionStatus: transaction.status || 'unknown',
        message: 'The transaction has not been confirmed as successful.'
      });
    }

    if (transaction.reference !== reference) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'Paystack returned a different transaction reference.'
      });
    }

    if (transaction.currency !== 'NGN') {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'The transaction currency does not match NGN.'
      });
    }

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
        error: 'The verified payment amount does not match the selected renewal package.'
      });
    }

    const transactionRef = db
      .collection('paystackTransactions')
      .doc(reference);

    const verifiedAt = admin.firestore.FieldValue.serverTimestamp();
    let renewalResult = null;

    await db.runTransaction(async transactionWriter => {
      const [freshSnapshot, transactionSnapshot] = await Promise.all([
        transactionWriter.get(registrationRef),
        transactionWriter.get(transactionRef)
      ]);

      if (!freshSnapshot.exists) {
        throw new Error('Student registration was not found during final verification.');
      }

      const freshData = freshSnapshot.data() || {};
      const freshPending = freshData.pendingRenewal || {};

      if (
        freshPending.status === 'paid' &&
        freshPending.verifiedReference === reference
      ) {
        renewalResult = { alreadyProcessed: true };
        return;
      }

      const freshAllowedReferences = [
        safeString(freshPending.expectedPaystackReference),
        safeString(freshPending.paystackReference)
      ].filter(Boolean);

      if (
        freshPending.renewalId !== renewalId ||
        !freshAllowedReferences.includes(reference)
      ) {
        throw new Error('The pending renewal changed during verification.');
      }

      if (transactionSnapshot.exists) {
        const existing = transactionSnapshot.data() || {};

        if (
          existing.registrationId !== registrationId ||
          existing.renewalId !== renewalId
        ) {
          throw new Error('This Paystack transaction reference has already been used.');
        }

        renewalResult = { alreadyProcessed: true };
        return;
      }

      const now = new Date();

      const currentExpiry =
        dateFromStoredValue(freshData.subscriptionExpiryDate) ||
        dateFromStoredValue(freshData.expiryDate) ||
        dateFromStoredValue(freshData.expiresAt) ||
        dateFromStoredValue(freshData.subscriptionEndDate);

      const startDate =
        currentExpiry && currentExpiry > now
          ? currentExpiry
          : now;

      const expiryDate = addCalendarMonths(startDate, months);

      const startTimestamp =
        admin.firestore.Timestamp.fromDate(startDate);

      const expiryTimestamp =
        admin.firestore.Timestamp.fromDate(expiryDate);

      transactionWriter.set(transactionRef, {
        registrationId,
        renewalId,
        reference,
        transactionId: String(transaction.id || ''),
        amountKobo: transaction.amount,
        amountNaira: transaction.amount / 100,
        currency: transaction.currency,
        status: 'success',
        type: 'subscription_renewal',
        channel: transaction.channel || null,
        processedAt: verifiedAt
      });

      transactionWriter.set(registrationRef, {
        registrationId,
        subscriptionPlan: normalizedPlan,
        subscriptionLabel: PLAN_LABELS[normalizedPlan],
        subscriptionMonths: months,
        subscriptionStartDate: startTimestamp,
        subscriptionExpiryDate: expiryTimestamp,
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
        lastRenewalTransactionId: String(transaction.id || ''),
        lastRenewalChannel: transaction.channel || null,
        lastRenewalVerifiedAt: verifiedAt,
        pendingRenewal: {
          ...freshPending,
          status: 'paid',
          verifiedReference: reference,
          verifiedTransactionId: String(transaction.id || ''),
          verifiedAt: new Date().toISOString(),
          appliedStartDate: startDate.toISOString(),
          appliedExpiryDate: expiryDate.toISOString()
        },
        updatedAt: verifiedAt
      }, { merge: true });

      renewalResult = {
        alreadyProcessed: false,
        expiryDate: expiryDate.toISOString()
      };
    });

    return res.status(200).json({
      success: true,
      verified: true,
      alreadyProcessed: Boolean(
        renewalResult && renewalResult.alreadyProcessed
      ),
      registrationId,
      renewalId,
      reference,
      amount: transaction.amount / 100,
      currency: transaction.currency,
      expiryDate: renewalResult && renewalResult.expiryDate
        ? renewalResult.expiryDate
        : null,
      message: renewalResult && renewalResult.alreadyProcessed
        ? 'This renewal payment was already processed.'
        : 'Renewal payment verified and subscription extended.'
    });

  } catch (error) {
    console.error('Renewal verification error:', error.message);

    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError'
    ) {
      return res.status(504).json({
        success: false,
        verified: false,
        error: 'Paystack verification timed out. Check the transaction status before trying again.'
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
      error: 'An internal error occurred while verifying the renewal. Do not pay again until the transaction is checked.'
    });
  }
});

// ======================================================
// 8. VERIFY FLEXI MASTERCLASS ACCOUNT FOR JARVIS
// ======================================================
//
// POST /api/verify-masterclass
//
// Authorization: Bearer <Supabase access token>
//
// Body:
// {
//   "whatsappNumber": "+2348012345678"
// }
//
// The authenticated Supabase user's email is used.
// The client cannot choose another student's email or
// registration ID to claim a Masterclass subscription.
//
// Eligibility requires:
// - A valid authenticated Supabase user.
// - A confirmed Supabase email.
// - A matching existing Flexi Lessons registration.
// - A matching WhatsApp number.
// - paymentStatus === true.
// - paymentVerified === true.
// - An active, unexpired subscription.
//
// This endpoint does not create a new Flexi Lessons
// registration or independently grant a JARVIS plan.

app.post('/api/verify-masterclass', async (req, res) => {
  if (firebaseInitializationError || !db) {
    return res.status(503).json({
      success: false,
      eligible: false,
      error: 'The registration database is not ready.'
    });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({
      success: false,
      eligible: false,
      error: 'Masterclass verification is not configured.'
    });
  }

  try {
    const authorization = safeString(req.headers.authorization);
    const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);

    if (!tokenMatch) {
      return res.status(401).json({
        success: false,
        eligible: false,
        error: 'A valid JARVIS sign-in session is required.'
      });
    }

    const accessToken = tokenMatch[1].trim();

    if (!accessToken || accessToken.length > 10000) {
      return res.status(401).json({
        success: false,
        eligible: false,
        error: 'Invalid authentication token.'
      });
    }

    // Verify the token with Supabase Auth.
    // Never trust an email supplied by the Android client.
    const supabaseResponse = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!supabaseResponse.ok) {
      return res.status(401).json({
        success: false,
        eligible: false,
        error: 'Your JARVIS session is invalid or has expired.'
      });
    }

    const authUser = await supabaseResponse.json();

    if (!authUser || !authUser.id) {
      return res.status(401).json({
        success: false,
        eligible: false,
        error: 'Unable to verify your JARVIS account.'
      });
    }

    const authenticatedEmail = normalizeMasterclassEmail(
      authUser.email
    );

    const emailConfirmed = Boolean(
      authUser.email_confirmed_at ||
      authUser.confirmed_at
    );

    if (!authenticatedEmail || !emailConfirmed) {
      return res.status(403).json({
        success: false,
        eligible: false,
        error: 'Please verify your JARVIS email address before linking Masterclass.'
      });
    }

    const suppliedPhone = normalizeMasterclassPhone(
      req.body && req.body.whatsappNumber
    );

    if (!suppliedPhone || suppliedPhone.length < 10) {
      return res.status(400).json({
        success: false,
        eligible: false,
        error: 'Enter the WhatsApp number used for your Flexi Lessons registration.'
      });
    }

    // Search the existing registrations collection.
    // Both queries use the authenticated Supabase email.
    const registrationsRef = db.collection('registrations');

    const [studentEmailSnapshot, emailSnapshot] = await Promise.all([
      registrationsRef
        .where('studentEmail', '==', authenticatedEmail)
        .get(),
      registrationsRef
        .where('email', '==', authenticatedEmail)
        .get()
    ]);

    const registrationMap = new Map();

    for (const document of [
      ...studentEmailSnapshot.docs,
      ...emailSnapshot.docs
    ]) {
      registrationMap.set(document.id, {
        id: document.id,
        data: document.data() || {}
      });
    }

    const matchingRegistrations = [];

    for (const registration of registrationMap.values()) {
      const phoneNumbers = getRegistrationPhoneNumbers(
        registration.data
      );

      if (phoneNumbers.includes(suppliedPhone)) {
        matchingRegistrations.push(registration);
      }
    }

    if (matchingRegistrations.length === 0) {
      return res.status(404).json({
        success: true,
        eligible: false,
        masterclassActive: false,
        unlimitedAccess: false,
        code: 'REGISTRATION_NOT_FOUND',
        message: 'No matching Flexi Lessons registration was found. Check that you entered the same email and WhatsApp number used during registration.'
      });
    }

    // Evaluate every matching registration. A student may have
    // older registrations as well as a newer paid registration.
    const now = Date.now();

    const evaluated = matchingRegistrations.map(item => {
      const registration = item.data;

      const paymentVerified =
        registration.paymentStatus === true &&
        registration.paymentVerified === true;

      const expiry = paymentVerified
        ? getMasterclassSubscriptionExpiry(registration)
        : null;

      const active = Boolean(
        paymentVerified &&
        expiry &&
        expiry.getTime() > now
      );

      return {
        id: item.id,
        registration,
        paymentVerified,
        expiry,
        active
      };
    });

    const activeRegistrations = evaluated
      .filter(item => item.active)
      .sort((a, b) => b.expiry.getTime() - a.expiry.getTime());

    if (activeRegistrations.length > 0) {
      const selected = activeRegistrations[0];
      const registration = selected.registration;

      return res.status(200).json({
        success: true,
        eligible: true,
        masterclassActive: true,
        unlimitedAccess: true,
        account: {
          registrationId: safeString(
            registration.registrationId
          ) || selected.id,
          firstName: safeString(registration.firstName),
          surname: safeString(registration.surname),
          displayName: [
            safeString(registration.firstName),
            safeString(registration.surname)
          ].filter(Boolean).join(' '),
          email: authenticatedEmail,
          subscriptionPlan: safeString(
            registration.subscriptionPlan
          ),
          subscriptionLabel: safeString(
            registration.subscriptionLabel
          )
        },
        expiresAt: selected.expiry.toISOString(),
        message: 'Your Flexi Masterclass subscription is active. Unlimited JARVIS access is available until your subscription expires.'
      });
    }

    const hasVerifiedPayment = evaluated.some(
      item => item.paymentVerified
    );

    if (hasVerifiedPayment) {
      return res.status(200).json({
        success: true,
        eligible: false,
        masterclassActive: false,
        unlimitedAccess: false,
        code: 'SUBSCRIPTION_EXPIRED',
        message: 'Your Flexi Masterclass subscription has expired. Renew your subscription to restore unlimited JARVIS access.'
      });
    }

    return res.status(200).json({
      success: true,
      eligible: false,
      masterclassActive: false,
      unlimitedAccess: false,
      code: 'PAYMENT_NOT_VERIFIED',
      message: 'The Flexi Lessons registration was found, but its payment has not been verified. Masterclass access cannot be activated.'
    });

  } catch (error) {
    console.error('Masterclass verification error:', error.message);

    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError'
    ) {
      return res.status(504).json({
        success: false,
        eligible: false,
        error: 'Masterclass verification timed out. Please try again.'
      });
    }

    return res.status(500).json({
      success: false,
      eligible: false,
      error: 'An internal error occurred while verifying your Masterclass account.'
    });
  }
});

// ======================================================
// 9. UNKNOWN ROUTES
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found.'
  });
});

// ======================================================
// 10. ERROR HANDLER
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
// 11. EXPORT FOR VERCEL
// ======================================================

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `Flexi Lessons Payment API running on port ${PORT}`
    );
  });
}
