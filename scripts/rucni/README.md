# Ruční pomocné skripty

Nic z toho není součást aplikace ani testů — **žádný z těchto souborů
nikdo neimportuje**. Jsou to jednorázové pomůcky z vývoje, které ležely
v kořeni repozitáře a mátly tím, že vypadaly jako část nástroje.

| soubor | k čemu byl |
|---|---|
| `create-test-db.js` | založení testovací databáze pro skener databází |
| `test-db-connector.js` | ruční zkouška konektoru; bezpečnostní logika `db-connector.js` je pokrytá v `tests/utils.test.js` |
| `test-slack.js` | ruční odeslání zprávy do Slacku (od teď má notifier vlastní test: `tests/slack-notifier.test.js`) |
| `verify-app.js` | ruční kontrola běžící aplikace |
| `verify-smart-monkey.js` | ruční kontrola agentního režimu |

Nejsou udržované a nikdo je nespouští v CI. Jestli se ukáže, že je
nepotřebuješ, smaž celý adresář — v gitu zůstanou.
