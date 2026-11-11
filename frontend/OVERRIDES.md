# Proč jsou ve `frontend/package.json` overrides

Stejný vzor jako v kořenovém `package.json`: verze problémových tranzitivních
balíčků se drží přes `overrides`, protože je jejich rodiče samy nezvednou.

## `@grpc/grpc-js`: `^1.14.7`

[GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) — high,
zranitelné `<1.13.6`: `getAuthContext` může za jistých konfigurací vrátit
neověřené certifikáty jako ověřené.

`@firebase/firestore` deklaruje `~1.9.0` a **žádná verze firebase to nemění** —
ověřeno u 12.19.0, 13.0.0 i 13.2.0, všechny pořád `~1.9.0`. Upgrade firebase
tedy nepomůže, zvednout to jde jen tímhle override.

Override proto vystupuje z deklarovaného rozsahu o čtyři minory. Že je to
bezpečné, stojí na měření, ne na odhadu:

- **`@grpc/grpc-js` v sestaveném bundlu vůbec není.** Grep přes všech šest
  chunků v `dist/assets/` vrací nulu. Firestore má zvlášť vstup pro Node
  (`dist/index.node.cjs.js`) a pro prohlížeč (`dist/index.esm.js`); vite
  bere ten druhý a ten jede přes WebChannel, ne přes gRPC.
- Build po zavedení override dává **bajtově shodné výstupy** — stejné hashe
  chunků jako předtím.
- Celá sada frontendových testů prochází beze změny.

Jinými slovy: ten balíček se v téhle aplikaci nikdy nenačte. Override je tu
proto, aby `npm audit` nehlásil nález, se kterým nejde nic jiného udělat —
ne proto, že by se opravovala živá díra v tom, co se servíruje.

## `brace-expansion`: `^1.1.22` a `js-yaml`: `^4.3.2`

Obojí jen vývojové, přes `eslint-plugin-jsx-a11y` → `eslint` → `@eslint/eslintrc`.
Opravy jsou uvnitř téhož majoru (zranitelné `<1.1.21`, resp. `>=4.0.0 <4.3.2`),
takže nejde o skok přes major jako v kořeni, kde je `brace-expansion` na 2.x.

CI je audituje s `--omit=dev`, takže tyhle dva job neblokují. Jsou tu proto,
že oprava nic nestála a `npm audit` ve `frontend/` je díky nim čistý i bez
přepínačů.
