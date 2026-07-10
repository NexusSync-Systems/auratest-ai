import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const __dirname = path.resolve();
const credentialsPath = path.join(__dirname, 'firebase-credentials.json');

let firebaseApp;
if (existsSync(credentialsPath)) {
  const serviceAccount = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  firebaseApp = initializeApp({
    credential: cert(serviceAccount)
  });
} else {
  // Fallback to Application Default Credentials
  firebaseApp = initializeApp();
}

const firestore = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

export { firestore, auth };

// --- PROJECTS ---
export async function getProjects(userId) {
  const snapshot = await firestore.collection('projects').where('userId', '==', userId).get();
  const list = [];
  snapshot.forEach(doc => {
    list.push({ id: doc.id, ...doc.data() });
  });
  return list;
}

export async function createProject(userId, name, allowedOrigins = []) {
  const docRef = firestore.collection('projects').doc('proj_' + Math.random().toString(36).substring(2, 10));
  const newProject = {
    userId,
    name,
    allowedOrigins,
    active: true,
    createdAt: new Date().toISOString()
  };
  await docRef.set(newProject);
  return { id: docRef.id, ...newProject };
}

export async function getProjectByKey(projectKey) {
  const doc = await firestore.collection('projects').doc(projectKey).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function deleteProject(projectKey) {
  await firestore.collection('projects').doc(projectKey).delete();
  return true;
}

// --- MONITORS ---
export async function getMonitors(userId) {
  const snapshot = await firestore.collection('monitors').where('userId', '==', userId).get();
  const list = [];
  snapshot.forEach(doc => {
    list.push({ id: doc.id, ...doc.data() });
  });
  return list;
}

export async function getAllActiveMonitors() {
  const snapshot = await firestore.collection('monitors').where('active', '==', true).get();
  const list = [];
  snapshot.forEach(doc => {
    list.push({ id: doc.id, ...doc.data() });
  });
  return list;
}

export async function createMonitor(userId, monitorData) {
  const docRef = firestore.collection('monitors').doc();
  const newMonitor = {
    ...monitorData,
    userId,
    active: true,
    lastRunTime: 0,
    lastRunStatus: 'none',
    lastRunBugsCount: 0
  };
  await docRef.set(newMonitor);
  return { id: docRef.id, ...newMonitor };
}

export async function updateMonitor(monitorId, updateData) {
  const docRef = firestore.collection('monitors').doc(monitorId);
  await docRef.update(updateData);
  const updated = await docRef.get();
  return { id: updated.id, ...updated.data() };
}

export async function deleteMonitor(monitorId) {
  await firestore.collection('monitors').doc(monitorId).delete();
  return true;
}

export async function getMonitorById(monitorId) {
  const doc = await firestore.collection('monitors').doc(monitorId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// --- AURAGUARD EVENTS ---
export async function getAuraGuardEvents(userId) {
  // Hledáme všechny projekty uživatele
  const projects = await getProjects(userId);
  const projectKeys = projects.map(p => p.id);
  if (projectKeys.length === 0) return [];

  // Firestore where-in limit je 30 položek, což v našem rozsahu stačí
  const snapshot = await firestore.collection('auraguard_events')
    .where('project', 'in', projectKeys.slice(0, 30))
    .get();

  const list = [];
  snapshot.forEach(doc => {
    list.push({ id: doc.id, ...doc.data() });
  });
  
  // Řazení časově sestupně na straně serveru
  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 500);
}

export async function createAuraGuardEvent(eventData) {
  const docRef = firestore.collection('auraguard_events').doc();
  const newEvent = {
    ...eventData,
    timestamp: eventData.timestamp || new Date().toISOString()
  };
  await docRef.set(newEvent);
  return { id: docRef.id, ...newEvent };
}

// --- SESSIONS ---
export async function getSessions(userId) {
  const snapshot = await firestore.collection('sessions')
    .where('userId', '==', userId)
    .get();
  const list = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    list.push({
      id: doc.id,
      url: data.url,
      goal: data.goal,
      status: data.status,
      stepCount: data.steps ? data.steps.length : 0,
      bugsCount: data.bugs ? data.bugs.length : 0,
      summary: data.summary,
      timestamp: data.timestamp
    });
  });
  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function getSession(sessionId) {
  const doc = await firestore.collection('sessions').doc(sessionId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function saveSession(sessionId, sessionData) {
  await firestore.collection('sessions').doc(sessionId).set(sessionData, { merge: true });
  return true;
}
