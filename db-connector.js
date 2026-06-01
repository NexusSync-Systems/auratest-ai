import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

/**
 * Fetches translations from various sources (API, Postgres, MySQL, SQLite, or Custom Script)
 * Returns a key-value flat object: { "key1": "value1", "key2": "value2" }
 */
export async function fetchTranslations(config) {
  const { type } = config;

  if (!type) {
    throw new Error('Chybí typ zdroje překladů (type).');
  }

  switch (type) {
    case 'api':
      return await fetchFromApi(config);
    case 'postgres':
      return await fetchFromPostgres(config);
    case 'mysql':
      return await fetchFromMysql(config);
    case 'sqlite':
      return await fetchFromSqlite(config);
    case 'script':
      return await fetchFromScript(config);
    default:
      throw new Error(`Nepodporovaný typ zdroje: ${type}`);
  }
}

async function fetchFromApi(config) {
  const { apiUrl, apiHeaders } = config;
  if (!apiUrl) {
    throw new Error('Chybí URL adresa API (apiUrl).');
  }

  const headers = {};
  if (apiHeaders) {
    try {
      const parsedHeaders = typeof apiHeaders === 'string' ? JSON.parse(apiHeaders) : apiHeaders;
      Object.assign(headers, parsedHeaders);
    } catch (e) {
      throw new Error('Neplatný formát HTTP hlaviček. Musí být platný JSON.');
    }
  }

  const response = await fetch(apiUrl, { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`API vrátilo chybu: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return flattenObject(data);
}

async function fetchFromPostgres(config) {
  const { dbHost, dbPort, dbUser, dbPassword, dbName, dbQuery } = config;
  if (!dbQuery) throw new Error('Chybí SQL dotaz (dbQuery).');

  // Dynamický import pg balíčku
  const pg = await import('pg');
  const { Client } = pg.default || pg;

  const client = new Client({
    host: dbHost || 'localhost',
    port: parseInt(dbPort) || 5432,
    user: dbUser,
    password: dbPassword,
    database: dbName,
  });

  await client.connect();
  try {
    const res = await client.query(dbQuery);
    return mapDbRowsToDict(res.rows);
  } finally {
    await client.end();
  }
}

async function fetchFromMysql(config) {
  const { dbHost, dbPort, dbUser, dbPassword, dbName, dbQuery } = config;
  if (!dbQuery) throw new Error('Chybí SQL dotaz (dbQuery).');

  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: dbHost || 'localhost',
    port: parseInt(dbPort) || 3306,
    user: dbUser,
    password: dbPassword,
    database: dbName,
  });

  try {
    const [rows] = await connection.execute(dbQuery);
    return mapDbRowsToDict(rows);
  } finally {
    await connection.end();
  }
}

async function fetchFromSqlite(config) {
  const { sqlitePath, dbQuery } = config;
  if (!sqlitePath) throw new Error('Chybí cesta k SQLite databázi (sqlitePath).');
  if (!dbQuery) throw new Error('Chybí SQL dotaz (dbQuery).');

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Soubor databáze neexistuje na cestě: ${sqlitePath}`);
  }

  const sqlite3 = await import('sqlite3');
  const { Database } = sqlite3.default || sqlite3;

  return new Promise((resolve, reject) => {
    const db = new Database(sqlitePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(new Error(`Nepodařilo se otevřít SQLite: ${err.message}`));
    });

    db.all(dbQuery, [], (err, rows) => {
      db.close();
      if (err) return reject(new Error(`Chyba SQL dotazu: ${err.message}`));
      try {
        const dict = mapDbRowsToDict(rows);
        resolve(dict);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function fetchFromScript(config) {
  const { scriptCommand, cwd } = config;
  if (!scriptCommand) throw new Error('Chybí příkaz pro spuštění skriptu (scriptCommand).');

  try {
    const { stdout, stderr } = await execAsync(scriptCommand, { cwd: cwd || process.cwd() });
    if (stderr && stderr.trim().length > 0) {
      console.warn('Varování skriptu (stderr):', stderr);
    }
    const data = JSON.parse(stdout);
    return flattenObject(data);
  } catch (e) {
    throw new Error(`Skript selhal nebo vrátil neplatný JSON: ${e.message}`);
  }
}

/**
 * Maps database rows to a translation flat object.
 * Expects rows to contain columns like (key, value) or (translation_key, translation_value).
 * If there are only 2 columns, it uses the first as key and the second as value.
 */
function mapDbRowsToDict(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {};
  }

  const dict = {};
  const sample = rows[0];
  const keys = Object.keys(sample);

  if (keys.length < 2) {
    throw new Error('SQL dotaz musí vracet alespoň dva sloupce (klíč a hodnotu překladu).');
  }

  // Find standard column names, or default to first and second columns
  let keyCol = keys[0];
  let valCol = keys[1];

  for (const k of keys) {
    if (['key', 'translation_key', 'code', 'name'].includes(k.toLowerCase())) keyCol = k;
    if (['value', 'translation_value', 'text', 'translation'].includes(k.toLowerCase())) valCol = k;
  }

  for (const row of rows) {
    const k = String(row[keyCol]);
    const v = String(row[valCol]);
    dict[k] = v;
  }

  return dict;
}

/**
 * Flattens a nested JSON object into dot-notation keys.
 * Example: { "home": { "title": "Ahoj" } } -> { "home.title": "Ahoj" }
 */
export function flattenObject(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') {
    return {};
  }

  const result = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenObject(val, newKey));
    } else {
      result[newKey] = String(val);
    }
  }
  return result;
}
