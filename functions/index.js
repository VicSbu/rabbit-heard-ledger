const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { scheduler } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const https = require('https');
const path = require('path');

admin.initializeApp();
const db = admin.firestore();

const CURRENCIES = ['USD','EUR','GBP','ZAR','SZL','KES','NGN','GHS','INR','AUD','CAD','BWP','ZMW'];
const ROLES = ['viewer', 'worker', 'supervisor', 'farm_manager'];
const TASK_FREQUENCIES = ['daily', 'weekly', 'monthly'];

function sendJavaScript(res, relativePath) {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.sendFile(path.join(__dirname, relativePath));
}

exports.app = onRequest((req, res) => sendJavaScript(res, 'runtime/app.js'));
exports.firebaseConfig = onRequest((req, res) => sendJavaScript(res, 'runtime/firebase-config.js'));

function generatePin() {
  return Math.random().toString().slice(2, 8).padStart(6, '0');
}

async function ensureUserDoc(uid, mustChangePassword) {
  const userRef = db.collection('users').doc(uid);
  await userRef.set({mustChangePassword: mustChangePassword === true, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
}

async function maybeSendSetupEmail(email, tempPin) {
  if (!email || !tempPin) return false;
  const sendGridApiKey = process.env.SENDGRID_API_KEY;
  if (!sendGridApiKey) {
    console.warn('SendGrid not configured; skipping setup email.');
    return false;
  }
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email }] }],
    from: { email: process.env.SENDGRID_FROM_EMAIL || 'no-reply@example.com' },
    subject: 'Your Warren account details',
    content: [{ type: 'text/plain', value: `Welcome to Warren.\n\nYour temporary login PIN is: ${tempPin}\n\nPlease sign in with your email address and this PIN, then set a new password.\n` }]
  });
  return await new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sendGridApiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      if (res.statusCode >= 400) {
        console.warn('SendGrid setup email failed:', res.statusCode);
        resolve(false);
        return;
      }
      resolve(true);
    });
    req.on('error', (err) => {
      console.warn('SendGrid setup email error:', err);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
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

async function assertFarmManager(farmId, uid) {
  const memberSnap = await db.collection('farms').doc(farmId).collection('members').doc(uid).get();
  if (!memberSnap.exists || memberSnap.data().role !== 'farm_manager') {
    throw new HttpsError('permission-denied', 'Only a farm manager can perform this action');
  }
}

async function assertFarmRole(farmId, uid, minRole) {
  const minRank = ROLES.indexOf(minRole);
  const memberSnap = await db.collection('farms').doc(farmId).collection('members').doc(uid).get();
  if (!memberSnap.exists) {
    throw new HttpsError('permission-denied', 'You do not have access to this farm');
  }
  const currentRank = ROLES.indexOf(memberSnap.data().role);
  if (currentRank < minRank) {
    throw new HttpsError('permission-denied', `Only a ${minRole.replace('_', ' ')} or higher can perform this action`);
  }
}

function normalizeCurrency(currency) {
  return CURRENCIES.includes(currency) ? currency : 'SZL';
}

function trimString(value) {
  return String(value || '').trim();
}

function optionalTrimmed(value) {
  const trimmed = trimString(value);
  return trimmed || null;
}

function parseNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a valid number`);
  }
  return parsed;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireDateString(value, fieldName) {
  const date = trimString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a valid date`);
  }
  return date;
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextDueForFrequency(dateStr, frequency) {
  if (frequency === 'daily') return addDays(dateStr, 1);
  if (frequency === 'weekly') return addDays(dateStr, 7);
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function todayUtcString() {
  return new Date().toISOString().slice(0, 10);
}

function taskPayloadFromData(data) {
  const name = trimString(data.name);
  const frequency = trimString(data.frequency).toLowerCase();
  if (!name) throw new HttpsError('invalid-argument', 'Task name is required');
  if (!TASK_FREQUENCIES.includes(frequency)) {
    throw new HttpsError('invalid-argument', 'Task frequency must be daily, weekly, or monthly');
  }
  return {
    name,
    frequency,
    nextDue: data.nextDue ? requireDateString(data.nextDue, 'Task next due date') : null,
    notes: trimString(data.notes),
  };
}

function feedPayloadFromData(data) {
  const name = trimString(data.name);
  const unit = trimString(data.unit);
  if (!name) throw new HttpsError('invalid-argument', 'Feed item name is required');
  if (!unit) throw new HttpsError('invalid-argument', 'Feed item unit is required');
  const quantity = parseNumber(data.quantity, 'Feed quantity');
  const reorderLevel = parseNumber(data.reorderLevel, 'Feed reorder level');
  if (quantity < 0 || reorderLevel < 0) {
    throw new HttpsError('invalid-argument', 'Feed quantity and reorder level cannot be negative');
  }
  return {
    name,
    quantity,
    unit,
    reorderLevel,
    notes: trimString(data.notes),
  };
}

function ledgerPayloadFromData(data) {
  const date = requireDateString(data.date, 'Ledger date');
  const type = trimString(data.type);
  const category = trimString(data.category);
  if (!type) throw new HttpsError('invalid-argument', 'Ledger type is required');
  if (!category) throw new HttpsError('invalid-argument', 'Ledger category is required');
  return {
    date,
    type,
    category,
    amount: parseNumber(data.amount, 'Ledger amount'),
    rabbitId: optionalTrimmed(data.rabbitId),
    notes: trimString(data.notes),
  };
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

  await assertFarmManager(farmId, request.auth.uid);

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
    batch.set(metaRef, {mustChangePassword:true, tempPin: userRecord.tempPin, createdAt: admin.firestore.FieldValue.serverTimestamp()}, {merge:true});
  }
  await batch.commit();
  let emailSent = false;
  if (userRecord.tempPin) {
    emailSent = await maybeSendSetupEmail(userRecord.email, userRecord.tempPin);
  }

  return {
    uid: userRecord.uid,
    email: userRecord.email,
    name: userRecord.displayName || '',
    role,
    newAccount: !!userRecord.tempPin,
    tempPin: userRecord.tempPin || null,
    emailSent
  };
});

exports.updateFarmSettings = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, name, currency } = request.data || {};
  if (!farmId || !name || !String(name).trim()) {
    throw new HttpsError('invalid-argument', 'farmId and a farm name are required');
  }

  await assertFarmManager(farmId, request.auth.uid);
  const farmRef = db.collection('farms').doc(farmId);
  const farmSnap = await farmRef.get();
  if (!farmSnap.exists) throw new HttpsError('not-found', 'Farm not found');

  const trimmedName = String(name).trim();
  const cur = normalizeCurrency(currency);
  const batch = db.batch();
  batch.update(farmRef, { name: trimmedName, currency: cur });

  const membersSnap = await farmRef.collection('members').get();
  membersSnap.docs.forEach((memberDoc) => {
    batch.update(db.collection('memberships').doc(`${memberDoc.id}_${farmId}`), { farmName: trimmedName, currency: cur });
  });

  await batch.commit();
  return { id: farmId, name: trimmedName, currency: cur };
});

exports.updateMemberRole = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, uid, role } = request.data || {};
  if (!farmId || !uid || !ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'farmId, uid, and a valid role are required');
  }

  await assertFarmManager(farmId, request.auth.uid);
  const memberRef = db.collection('farms').doc(farmId).collection('members').doc(uid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new HttpsError('not-found', 'Member not found');

  const memberData = memberSnap.data();
  const managersSnap = await db.collection('farms').doc(farmId).collection('members').where('role', '==', 'farm_manager').get();
  const isLastManager = memberData.role === 'farm_manager' && managersSnap.size <= 1 && role !== 'farm_manager';
  if (isLastManager) {
    throw new HttpsError('failed-precondition', 'At least one farm manager must remain');
  }

  const batch = db.batch();
  batch.update(memberRef, { role });
  batch.update(db.collection('memberships').doc(`${uid}_${farmId}`), { role });
  await batch.commit();

  return { uid, role };
});

exports.removeFarmMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, uid } = request.data || {};
  if (!farmId || !uid) {
    throw new HttpsError('invalid-argument', 'farmId and uid are required');
  }

  await assertFarmManager(farmId, request.auth.uid);
  const memberRef = db.collection('farms').doc(farmId).collection('members').doc(uid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new HttpsError('not-found', 'Member not found');

  const memberData = memberSnap.data();
  const managersSnap = await db.collection('farms').doc(farmId).collection('members').where('role', '==', 'farm_manager').get();
  const isLastManager = memberData.role === 'farm_manager' && managersSnap.size <= 1;
  if (isLastManager) {
    throw new HttpsError('failed-precondition', 'At least one farm manager must remain');
  }

  const batch = db.batch();
  batch.delete(memberRef);
  batch.delete(db.collection('memberships').doc(`${uid}_${farmId}`));
  await batch.commit();

  return { uid, removed: true };
});

exports.resendSetupEmail = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, uid, email } = request.data || {};
  if (!farmId || (!uid && !email)) {
    throw new HttpsError('invalid-argument', 'farmId and a member uid or email are required');
  }

  await assertFarmManager(farmId, request.auth.uid);

  const membersSnap = await db.collection('farms').doc(farmId).collection('members').get();
  const memberDoc = membersSnap.docs.find((doc) => {
    if (uid && doc.id === uid) return true;
    if (email && String(doc.data().email || '').toLowerCase() === String(email).toLowerCase().trim()) return true;
    return false;
  });
  if (!memberDoc) throw new HttpsError('not-found', 'Member not found');

  const memberEmail = String(memberDoc.data().email || email || '').trim().toLowerCase();
  const userRef = db.collection('users').doc(memberDoc.id);
  const userSnap = await userRef.get();
  const existingPin = userSnap.exists && userSnap.data().tempPin ? String(userSnap.data().tempPin) : null;
  const tempPin = existingPin || generatePin();
  await userRef.set({mustChangePassword:true, tempPin, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge:true});
  const emailSent = await maybeSendSetupEmail(memberEmail, tempPin);

  return {email: memberEmail, tempPin, emailSent};
});

exports.saveTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, taskId, task } = request.data || {};
  if (!farmId || !task) throw new HttpsError('invalid-argument', 'farmId and task are required');

  await assertFarmRole(farmId, request.auth.uid, 'worker');
  const payload = taskPayloadFromData(task);
  const tasksRef = db.collection('farms').doc(farmId).collection('tasks');

  if (taskId) {
    const taskRef = tasksRef.doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found');
    await taskRef.update(payload);
    return { id: taskId, ...payload };
  }

  const taskRef = tasksRef.doc();
  await taskRef.set({ ...payload, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { id: taskRef.id, ...payload };
});

exports.deleteTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, taskId } = request.data || {};
  if (!farmId || !taskId) throw new HttpsError('invalid-argument', 'farmId and taskId are required');

  await assertFarmRole(farmId, request.auth.uid, 'supervisor');
  const taskRef = db.collection('farms').doc(farmId).collection('tasks').doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found');
  await taskRef.delete();
  return { id: taskId, deleted: true };
});

exports.completeTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, taskId } = request.data || {};
  if (!farmId || !taskId) throw new HttpsError('invalid-argument', 'farmId and taskId are required');

  await assertFarmRole(farmId, request.auth.uid, 'worker');
  const farmRef = db.collection('farms').doc(farmId);
  const taskRef = farmRef.collection('tasks').doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found');

  const task = taskSnap.data();
  const completedAt = todayUtcString();
  const nextDue = nextDueForFrequency(completedAt, task.frequency);
  const completedBy = trimString(request.auth.token.name || request.auth.token.email || '');
  const logRef = farmRef.collection('taskLogs').doc();
  const batch = db.batch();
  batch.update(taskRef, { nextDue });
  batch.set(logRef, {
    taskId,
    taskName: task.name,
    frequency: task.frequency,
    completedAt,
    completedBy,
    notes: 'Completed via Tasks',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { id: taskId, nextDue, completedAt, completedBy };
});

exports.saveFeedItem = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, itemId, item } = request.data || {};
  if (!farmId || !item) throw new HttpsError('invalid-argument', 'farmId and item are required');

  await assertFarmRole(farmId, request.auth.uid, 'worker');
  const payload = feedPayloadFromData(item);
  const itemsRef = db.collection('farms').doc(farmId).collection('feedStock');

  if (itemId) {
    const itemRef = itemsRef.doc(itemId);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) throw new HttpsError('not-found', 'Feed item not found');
    await itemRef.update(payload);
    return { id: itemId, ...payload };
  }

  const itemRef = itemsRef.doc();
  await itemRef.set({ ...payload, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { id: itemRef.id, ...payload };
});

exports.deleteFeedItem = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, itemId } = request.data || {};
  if (!farmId || !itemId) throw new HttpsError('invalid-argument', 'farmId and itemId are required');

  await assertFarmRole(farmId, request.auth.uid, 'supervisor');
  const itemRef = db.collection('farms').doc(farmId).collection('feedStock').doc(itemId);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new HttpsError('not-found', 'Feed item not found');
  await itemRef.delete();
  return { id: itemId, deleted: true };
});

exports.adjustFeedStock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, itemId, kind, date, amount, notes, cost } = request.data || {};
  if (!farmId || !itemId || !kind) {
    throw new HttpsError('invalid-argument', 'farmId, itemId, and kind are required');
  }
  if (kind !== 'restock' && kind !== 'use') {
    throw new HttpsError('invalid-argument', 'kind must be restock or use');
  }

  await assertFarmRole(farmId, request.auth.uid, 'worker');
  const dateStr = requireDateString(date, 'Feed transaction date');
  const amountNumber = parseNumber(amount, 'Feed amount');
  if (amountNumber <= 0) throw new HttpsError('invalid-argument', 'Feed amount must be greater than zero');
  const costNumber = cost === null || cost === undefined || cost === '' ? 0 : parseNumber(cost, 'Feed cost');

  const farmRef = db.collection('farms').doc(farmId);
  const itemRef = farmRef.collection('feedStock').doc(itemId);
  const txRef = farmRef.collection('feedTx').doc();
  const ledgerRef = kind === 'restock' && costNumber > 0 ? farmRef.collection('ledger').doc() : null;

  let updatedItem;
  await db.runTransaction(async (transaction) => {
    const itemSnap = await transaction.get(itemRef);
    if (!itemSnap.exists) throw new HttpsError('not-found', 'Feed item not found');
    const item = itemSnap.data();
    const currentQuantity = Number(item.quantity) || 0;
    const newQuantity = kind === 'restock' ? currentQuantity + amountNumber : currentQuantity - amountNumber;
    if (newQuantity < 0) {
      throw new HttpsError('failed-precondition', 'Feed stock cannot go below zero');
    }

    transaction.update(itemRef, { quantity: newQuantity });
    transaction.set(txRef, {
      itemId,
      kind,
      date: dateStr,
      amount: amountNumber,
      notes: trimString(notes),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (ledgerRef) {
      transaction.set(ledgerRef, {
        date: dateStr,
        type: 'Feed',
        category: `${item.name} restock`,
        amount: costNumber,
        notes: trimString(notes),
        rabbitId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    updatedItem = { id: itemId, ...item, quantity: newQuantity };
  });

  return { item: updatedItem, ledgerId: ledgerRef ? ledgerRef.id : null };
});

exports.createLedgerEntry = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be logged in');
  const { farmId, entry } = request.data || {};
  if (!farmId || !entry) throw new HttpsError('invalid-argument', 'farmId and entry are required');

  await assertFarmRole(farmId, request.auth.uid, 'worker');
  const payload = ledgerPayloadFromData(entry);
  const entryRef = db.collection('farms').doc(farmId).collection('ledger').doc();
  await entryRef.set({ ...payload, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { id: entryRef.id, ...payload };
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
