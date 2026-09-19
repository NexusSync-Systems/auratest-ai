import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { zapisPokudExistuje } from './firestore-errors.js';
import { teloRezervace, poleProUvolneniZamku } from './monitor-slot.js';

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

/**
 * Zápis do monitoru, který uživatel mezitím mohl smazat.
 *
 * Vrací `null`, když monitor už neexistuje — to je legitimní stav, ne
 * chyba. `updateMonitor` na smazaném dokumentu vyhodí, a protože se volal
 * v plovoucím `(async () => {})()` bez `.catch()`, skončilo smazání
 * monitoru za běhu jako unhandledRejection → `process.exit(1)`. Jeden
 * uživatel tím zabil rozdělané běhy všech ostatních.
 *
 * `set(..., {merge:true})` by nevyhodil, ale smazaný monitor by vzkřísil —
 * proto se chybějící dokument pozná a NEzapisuje se.
 *
 * Skutečné chyby (nedostupná databáze, odepřené oprávnění) se vyhazují
 * dál. Spolknout je by znamenalo, že zápisy tiše mizí.
 */
export async function updateMonitorIfExists(monitorId, updateData) {
  return zapisPokudExistuje(() => updateMonitor(monitorId, updateData));
}

/**
 * Atomická rezervace slotu pro běh monitoru.
 *
 * Nahrazuje původní `updateMonitorIfExists(id, { lastRunTime: now })`,
 * které bylo read-then-write: plánovač si přečetl snímek, chvíli s ním
 * pracoval a pak zapsal bez ohledu na to, co v dokumentu mezitím je.
 * Napříč instancemi to není atomické — dva procesy si oba mysleli, že
 * slot mají.
 *
 * Transakce dokument přečte ZNOVU a rozhodnutí předá `posudRezervaci`.
 * Žádná podmínka tady není schválně: kdyby byla, existovalo by rozhodování
 * na dvou místech a jedno z nich by se při příští opravě přehlédlo.
 *
 * Firestore transakci při souběhu sám opakuje, takže z ní vyjde právě
 * jeden vítěz.
 *
 * Volby jsou pojmenované, ne poziční: `(id, 1234, 5678, 9012, 'session_x')`
 * je řada čísel, u které se záměna dvou z nich nikde neprojeví jako chyba,
 * jen jako špatně naplánovaný běh.
 *
 * @param {string} monitorId
 * @param {object} volby
 * @param {number} volby.ocekavanyLastRun hodnota ze snímku, podle které se
 *   plánovač rozhodl monitor spustit
 * @param {number} volby.novyCas čas, který se zapíše při úspěchu
 * @param {number} volby.zamekDo do kdy platí zámek běhu (0 = bez zámku)
 * @param {string|null} volby.zamekSession identifikátor běhu, podle kterého
 *   se pozná mezera v měření
 * @returns {Promise<{stav: string, duvod: string, mezera?: object|null}>}
 *   viz `STAV_SLOTU`
 */
export async function rezervujSlotMonitoru(monitorId, volby = {}) {
  const docRef = firestore.collection('monitors').doc(monitorId);
  return firestore.runTransaction(
    (t) => teloRezervace(t, docRef, { ...volby, ted: Date.now() })
  );
}

/**
 * Uvolnění zámku po doběhnutí monitoru.
 *
 * Bez něj by monitor čekal na vypršení celé platnosti zámku, i kdyby běh
 * trval deset sekund. Zámek je pojistka pro pád procesu, ne plánovací
 * nástroj.
 */
export async function uvolniZamekMonitoru(monitorId) {
  // Pole se berou z `monitor-slot.js`, ne se píšou tady: tenhle soubor
  // se v testech celý podvrhuje, takže by na vynechání `bezimSession`
  // žádný test nesáhl — a právě to je z chyb v téhle změně ta nejhorší.
  return updateMonitorIfExists(monitorId, poleProUvolneniZamku());
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
      // Předpisový sken nese verdikt v `checks`, ne v `bugs`.
      //
      // `buildScanSession` mu `bugs: []` nastavuje schválně (spis to pole
      // čte u každého běhu), takže seznam v UI u NĚJ hlásil „bez nálezu"
      // bez ohledu na to, co sken zjistil. Bez `kind` a `verdict` to
      // frontend nemá jak poznat.
      kind: data.kind || null,
      verdict: data.verdict === undefined ? null : data.verdict,
      summary: data.summary,
      timestamp: data.timestamp
    });
  });
  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Běhy včetně nálezů a varování.
 *
 * `getSessions()` vrací jen souhrn (počty), což stačí do seznamu v UI, ale
 * ne do spisu — kontrolor potřebuje vidět konkrétní nálezy. Načítat je
 * jedním dotazem na session je stovky dotazů navíc.
 */
export async function getSessionsDetailed(userId) {
  const snapshot = await firestore.collection('sessions')
    .where('userId', '==', userId)
    .get();
  const list = [];
  snapshot.forEach((doc) => list.push({ id: doc.id, ...doc.data() }));
  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function getSession(sessionId) {
  const doc = await firestore.collection('sessions').doc(sessionId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Všechny běhy ve stavu `running`, napříč uživateli.
 *
 * Hlídač zaseknutých běhů nemá kontext přihlášení — běží na pozadí a
 * uklízí po procesu, ne po člověku. Vrací jen pole, která rozhodnutí
 * potřebuje; obsah běhů do něj netahá.
 *
 * Bez indexu na `status` to Firestore zvládne, dokud je rozdělaných
 * běhů málo — což je celý smysl věci. Kdyby jich byly tisíce, je to
 * samo o sobě nález.
 */
export async function getRunningSessions() {
  const snapshot = await firestore.collection('sessions')
    .where('status', '==', 'running')
    .get();
  const list = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    list.push({
      id: doc.id,
      userId: data.userId,
      url: data.url,
      status: data.status,
      timestamp: data.timestamp,
      heartbeatAt: data.heartbeatAt,
      runErrors: data.runErrors,
      instanceId: data.instanceId,
    });
  });
  return list;
}

export async function saveSession(sessionId, sessionData) {
  await firestore.collection('sessions').doc(sessionId).set(sessionData, { merge: true });
  return true;
}
