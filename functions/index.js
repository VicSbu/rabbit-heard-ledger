const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const CURRENCIES = ['USD','EUR','GBP','ZAR','SZL','KES','NGN','GHS','INR','AUD','CAD','BWP','ZMW'];
const ROLES = ['viewer', 'worker', 'supervisor', 'farm_manager'];

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
  const cur = CURRENCIES.includes(currency) ? currency : 'USD';

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
  try {
    userRecord = await admin.auth().getUserByEmail(String(email).toLowerCase().trim());
  } catch (e) {
    throw new HttpsError('not-found', 'No Warren account found for that email. Ask them to register first.');
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
  await batch.commit();

  return { uid: userRecord.uid, email: userRecord.email, name: userRecord.displayName || '', role };
});
