const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const WA_TOKEN = defineSecret("WA_TOKEN");
const WA_PHONE_NUMBER_ID = defineSecret("WA_PHONE_NUMBER_ID");
const WA_GRAPH_VERSION = defineString("WA_GRAPH_VERSION", { default: "v23.0" });
const WA_TEMPLATE_NAME = defineString("WA_TEMPLATE_NAME", { default: "missed_checkin_reminder" });
const WA_TEMPLATE_LANGUAGE = defineString("WA_TEMPLATE_LANGUAGE", { default: "en" });

const OWNER_EMAIL = "lokeshraj001100@gmail.com";
const PLAN_DAYS = { monthly: 30, quarterly: 90, yearly: 365 };

function requireMember(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  if ((request.auth.token.email || "").toLowerCase() === OWNER_EMAIL) {
    throw new HttpsError("permission-denied", "This action is for member accounts.");
  }
  return request.auth.uid;
}
function requireOwner(request) {
  if (!request.auth ||
      (request.auth.token.email || "").toLowerCase() !== OWNER_EMAIL ||
      request.auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Verified owner account required.");
  }
}
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return "";
}
function vectorOkay(v) {
  return Array.isArray(v) && v.length === 128 &&
    v.every(n => typeof n === "number" && Number.isFinite(n));
}
function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
function istDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}
function expiresMillis(m) {
  return m && m.expires && typeof m.expires.toMillis === "function" ? m.expires.toMillis() : 0;
}

/**
 * Enrollment is a prototype-only biometric enrollment route.
 * IMPORTANT: a browser-supplied descriptor is not trustworthy proof of a live face.
 * For production, replace this with a trusted liveness/biometric provider and
 * never accept enrollment solely because a client sends a vector.
 */
exports.enrollFacePrototype = onCall({ region: "asia-south1" }, async (request) => {
  const uid = requireMember(request);
  const { descriptor, consent } = request.data || {};
  if (consent !== true) throw new HttpsError("failed-precondition", "Biometric consent is required.");
  if (!vectorOkay(descriptor)) throw new HttpsError("invalid-argument", "Invalid face descriptor.");

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("failed-precondition", "Member profile not found.");

  await db.doc(`faceProfiles/${uid}`).set({
    descriptor,
    enrolledAt: FieldValue.serverTimestamp(),
    consentVersion: "face-consent-v1",
    verificationMode: "prototype-browser-descriptor"
  });
  await userRef.set({
    faceConsent: true,
    faceConsentAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { ok: true, mode: "prototype-browser-descriptor" };
});

/**
 * Attendance is written only here, not from the browser.
 * A matching descriptor is a prototype check, not liveness detection.
 */
exports.verifyFaceAndCheckInPrototype = onCall({ region: "asia-south1" }, async (request) => {
  const uid = requireMember(request);
  const { descriptor } = request.data || {};
  if (!vectorOkay(descriptor)) throw new HttpsError("invalid-argument", "Invalid face descriptor.");

  const [membershipSnap, profileSnap] = await Promise.all([
    db.doc(`memberships/${uid}`).get(),
    db.doc(`faceProfiles/${uid}`).get()
  ]);
  if (!membershipSnap.exists || expiresMillis(membershipSnap.data()) <= Date.now()) {
    throw new HttpsError("failed-precondition", "An active membership is required.");
  }
  if (!profileSnap.exists || profileSnap.data().consentVersion !== "face-consent-v1") {
    throw new HttpsError("failed-precondition", "Enroll your face and consent first.");
  }

  const enrolled = profileSnap.data().descriptor;
  if (!vectorOkay(enrolled)) throw new HttpsError("failed-precondition", "Face profile is invalid.");
  const distance = euclideanDistance(enrolled, descriptor);
  const threshold = 0.48; // tune with real testing; not a security guarantee
  if (distance > threshold) throw new HttpsError("permission-denied", "Face match not strong enough. Try again or ask staff for manual verification.");

  const day = istDateKey();
  const id = `${uid}_${day}`;
  const ref = db.doc(`attendance/${id}`);
  let alreadyCheckedIn = false;
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      alreadyCheckedIn = true;
      return;
    }
    tx.create(ref, {
      uid, day,
      ts: FieldValue.serverTimestamp(),
      method: "face-prototype",
      faceMatchDistance: distance
    });
  });

  return { ok: true, day, alreadyCheckedIn };
});

/**
 * Owner-only callable test to confirm WhatsApp configuration.
 * It sends only to the owner's own phone supplied in the request, never to a member.
 * Template must be approved by Meta.
 */
exports.testWhatsAppConfig = onCall({
  region: "asia-south1",
  secrets: [WA_TOKEN, WA_PHONE_NUMBER_ID]
}, async (request) => {
  requireOwner(request);
  const to = normalizePhone(request.data && request.data.to);
  if (!to) throw new HttpsError("invalid-argument", "Supply a phone number with country code.");
  const result = await sendTemplate(to, "Fitness Hub test", "Test");
  return { ok: true, result };
});

async function sendTemplate(to, memberName, gymName) {
  const version = WA_GRAPH_VERSION.value();
  const phoneId = WA_PHONE_NUMBER_ID.value();
  const token = WA_TOKEN.value();
  if (!phoneId || !token) throw new Error("WhatsApp secrets are not configured.");

  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WA_TEMPLATE_NAME.value(),
        language: { code: WA_TEMPLATE_LANGUAGE.value() },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: String(memberName || "there").slice(0, 60) },
            { type: "text", text: String(gymName || "Fitness Hub").slice(0, 60) }
          ]
        }]
      }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`WhatsApp API returned ${response.status}`);
    err.details = body;
    throw err;
  }
  return body;
}

/**
 * Runs daily at 7:30 PM India time. Sends one template reminder to each
 * active, opted-in member without an attendance record for the India date.
 */
exports.sendAbsenceWhatsAppReminders = onSchedule({
  schedule: "30 19 * * *",
  timeZone: "Asia/Kolkata",
  region: "asia-south1",
  secrets: [WA_TOKEN, WA_PHONE_NUMBER_ID],
  retryCount: 1
}, async () => {
  const day = istDateKey();
  const now = Date.now();

  const [memberships, users, attendance] = await Promise.all([
    db.collection("memberships").get(),
    db.collection("users").get(),
    db.collection("attendance").where("day", "==", day).get()
  ]);

  const active = new Map();
  memberships.forEach(doc => {
    if (expiresMillis(doc.data()) > now) active.set(doc.id, doc.data());
  });
  const present = new Set(attendance.docs.map(d => d.data().uid));
  let sent = 0, skipped = 0, failed = 0;

  for (const userDoc of users.docs) {
    const uid = userDoc.id;
    const u = userDoc.data();
    if (!active.has(uid) || present.has(uid)) { skipped++; continue; }
    if (u.whatsappAbsenceOptIn !== true) { skipped++; continue; }

    const to = normalizePhone(u.phone);
    if (!to) { skipped++; continue; }

    const notificationId = `${uid}_${day}`;
    const noticeRef = db.doc(`absenceNotifications/${notificationId}`);
    // Claim the day's notification transactionally so overlapping scheduler runs
    // cannot both send the same member's reminder.
    let claimed = false;
    await db.runTransaction(async tx => {
      const existing = await tx.get(noticeRef);
      const status = existing.exists ? existing.data().status : null;
      if (["sending", "accepted", "sent", "delivered"].includes(status)) return;
      tx.set(noticeRef, {
        uid, day, channel: "whatsapp", status: "sending",
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
      claimed = true;
    });
    if (!claimed) { skipped++; continue; }

    try {
      const result = await sendTemplate(to, u.name || "there", "Fitness Hub");
      await noticeRef.set({
        status: "accepted",
        providerMessageId: result.messages && result.messages[0] && result.messages[0].id || null,
        acceptedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      sent++;
    } catch (err) {
      logger.error("WhatsApp absence reminder failed", { uid, day, message: err.message, details: err.details || null });
      await noticeRef.set({
        status: "failed",
        error: String(err.message || "Send failed").slice(0, 250),
        failedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      failed++;
    }
  }

  logger.info("Absence reminders finished", { day, sent, skipped, failed });
});
