import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./locales.sqlite', (err) => {
  if (err) {
    console.error('Chyba při otevírání SQLite databáze:', err);
    process.exit(1);
  }
  console.log('SQLite databáze vytvořena.');
});

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS translations (id INTEGER PRIMARY KEY, key_name TEXT, translation_value TEXT)");
  
  // Clear any existing keys
  db.run("DELETE FROM translations");
  
  const stmt = db.prepare("INSERT INTO translations (key_name, translation_value) VALUES (?, ?)");
  
  // Mock data for Hacker News test
  stmt.run("hn.title", "Hacker News");
  stmt.run("hn.new", "new");
  stmt.run("hn.past", "past");
  stmt.run("hn.comments", "comments");
  stmt.run("hn.ask", "ask");
  stmt.run("hn.show", "show");
  stmt.run("hn.jobs", "jobs");
  stmt.run("hn.submit", "submit");
  
  // Mock data for our prod/preview pages
  stmt.run("app.title", "Moje Produkční Aplikace");
  stmt.run("app.welcome", "Vítejte v naší produkční verzi systému. Tato stránka obsahuje oficiální texty a stabilní rozhraní.");
  stmt.run("app.submit", "Odeslat data");
  
  stmt.finalize();

  console.log('Vzorky překladů úspěšně vloženy do tabulky "translations".');
});

db.close();
