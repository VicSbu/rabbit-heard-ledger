const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { scheduler } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const CURRENCIES = ['USD','EUR','GBP','ZAR','SZL','KES','NGN','GHS','INR','AUD','CAD','BWP','ZMW'];
const ROLES = ['viewer', 'worker', 'supervisor', 'farm_manager'];

function generatePin() {
  return Math.random().toString().slice(2, 8).padStart(6, '0');
}

async function ensureUserDoc(uid, mustChangePassword) {
  const userRef = db.collection('users').doc(uid);
  await userRef.set({mustChangePassword: mustChangePassword === true, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
}

async function collectFcmTokensForFarm(farmId) {
  const tokens = new Set();
  const members = await db.collection('farms').doc(farmId).collection('members').get();
  const queries = members.docs.map(async (memberDoc) => {
    const uid = memberDoc.id;
    const tokenSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
    tokenSnap.docs.forEach((tokenDoc) => tokens.add(tokenDoc.id));
  });
  await Promise.all(queries);
  return Array.from(tokens);
}

// Creates a new farm and makes the caller its farm_manager.
// Runs as Admin so it can write both the members subdoc and the
// denormalized `memberships` index doc in one atomic batch — something
// client-side security rules can't safely bootstrap on their own
// (a client write here could otherwise let someone self-promote on a
// farm that already exists).
exports.createFarm = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { name, currency } = request.data || {};
  if (!name || !String(name).trim()) throw new HttpsError('invalid-argument', 'Farm name is required');
  const cur = CURRENCIES.includes(currency) ? currency : 'SZL';

  const uid = request.auth.uid;
  const email = request.auth.token.email || '';
  const displayName = request.auth.token.name || '';

  const farmRef = db.collection('farms').doc();
  const batch = db.batch();

  batch.set(farmRef, {
    name: String(name).trim(),
    currency: cur,
    ownerId: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(farmRef.collection('members').doc(uid), {
    role: 'farm_manager',
    email,
    name: displayName,
    joinedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.collection('memberships').doc(`${uid}_${farmRef.id}`), {
    uid,
    farmId: farmRef.id,
    farmName: String(name).trim(),
    currency: cur,
    role: 'farm_manager'
  });

  await batch.commit();
  return { id: farmRef.id, name: String(name).trim(), currency: cur, role: 'farm_manager' };
});

// Adds an existing Warren user (by email) to a farm with a given role.
// Runs as Admin because looking up another user by email requires the
// Admin Auth API — the client SDK can't do this (by design, for privacy).
exports.addFarmMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, email, role } = request.data || {};
  if (!farmId || !email || !ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'farmId, email, and a valid role are required');
  }

  const callerSnap = await db.collection('farms').doc(farmId).collection('members').doc(request.auth.uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== 'farm_manager') {
    throw new HttpsError('permission-denied', 'Only a farm manager can add members');
  }

  let userRecord;
  const emailNorm = String(email).toLowerCase().trim();
  try {
    userRecord = await admin.auth().getUserByEmail(emailNorm);
  } catch (e) {
    const tempPin = generatePin();
    const displayName = emailNorm.split('@')[0].replace(/[^a-z0-9]/gi, ' ').trim();
    userRecord = await admin.auth().createUser({
      email: emailNorm,
      password: tempPin,
      displayName: displayName || emailNorm,
      emailVerified: false,
    });
    await ensureUserDoc(userRecord.uid, true);
    userRecord.tempPin = tempPin;
  }

  const farmSnap = await db.collection('farms').doc(farmId).get();
  if (!farmSnap.exists) throw new HttpsError('not-found', 'Farm not found');
  const farmData = farmSnap.data();

  const batch = db.batch();
  batch.set(
    db.collection('farms').doc(farmId).collection('members').doc(userRecord.uid),
    {
      role,
      email: userRecord.email,
      name: userRecord.displayName || '',
      joinedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  batch.set(
    db.collection('memberships').doc(`${userRecord.uid}_${farmId}`),
    { uid: userRecord.uid, farmId, farmName: farmData.name, currency: farmData.currency, role }
  );
  if (userRecord.tempPin) {
    const metaRef = db.collection('users').doc(userRecord.uid);
    batch.set(metaRef, {mustChangePassword:true, createdAt: admin.firestore.FieldValue.serverTimestamp()}, {merge:true});
  }
  await batch.commit();

  return {
    uid: userRecord.uid,
    email: userRecord.email,
    name: userRecord.displayName || '',
    role,
    newAccount: !!userRecord.tempPin,
    tempPin: userRecord.tempPin || null
  };
});

exports.sendScheduledTasks = scheduler.onSchedule('every 24 hours', async (event) => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const farmsSnap = await db.collection('farms').get();
  const payloads = [];

  await Promise.all(farmsSnap.docs.map(async (farmDoc) => {
    const farmId = farmDoc.id;
    const tasksSnap = await db.collection('farms').doc(farmId).collection('tasks').get();
    if (tasksSnap.empty) return;

    const tokens = await collectFcmTokensForFarm(farmId);
    if (!tokens.length) return;

    tasksSnap.docs.forEach((taskDoc) => {
      const task = taskDoc.data();
      if (!task.name || !task.frequency) return;
      const dueValue = task.nextDue || task.dueDate;
      if (!dueValue) return;
      const due = (typeof dueValue.toDate === 'function')
        ? dueValue.toDate().toISOString().slice(0, 10)
        : new Date(dueValue).toISOString().slice(0, 10);
      if (due !== today) return;
      tokens.forEach((token) => {
        payloads.push({token: token, notification: {
          title: 'Farm task due',
          body: task.name + ' is scheduled for today.',
        }, data: {
          farmId,
          taskId: taskDoc.id,
          type: 'taskReminder'
        }});
      });
    });
  }));

  if (!payloads.length) return;
  let totalSuccess = 0;
  let totalFailure = 0;
  for (let i = 0; i < payloads.length; i += 500) {
    const batch = payloads.slice(i, i + 500);
    const response = await admin.messaging().sendEachForMulticast(batch);
    totalSuccess += response.successCount;
    totalFailure += response.failureCount;
  }
  console.log('Task reminders sent:', totalSuccess, 'successes,', totalFailure, 'failures');
});
