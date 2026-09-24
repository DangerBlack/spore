# CLAUDE.md — Spore

> **Spore** — un "browser dentro il browser" che apre siti statici ospitati su
> torrent e permette di pubblicarne di nuovi con un click.
> Obiettivo: un internet che cresce dentro l'internet, resistente al takedown.
>
> Il nome: una spora è autocontenuta, si diffonde, sopravvive dormiente, e ognuna
> può rigenerare l'intero organismo — cioè esattamente un sito content-addressed,
> pacchetto autoverificante che qualsiasi nodo può rimettere in vita.
> (Esiste un videogioco omonimo; contesto diverso, nessuna collisione reale d'uso.)

## Principio guida

**Semplicità prima di tutto.** L'MVP deve fare due cose e farle bene. Tutto ciò
che non serve a quelle due cose è Fase 2+ e NON va costruito ora, nemmeno se
"tanto è facile". Quando sei in dubbio se aggiungere qualcosa: non aggiungerlo.

## Cosa deve fare l'MVP (Fase 1)

1. **Aprire un sito da un magnet.** L'utente incolla (o clicca un link con) un
   magnet/infohash e vede il sito statico renderizzato, con le sue risorse
   (CSS, immagini, ecc.) caricate dallo swarm.
2. **Pubblicare un sito dalla pagina.** L'utente trascina una cartella
   (con `index.html` in root, path relativi) → viene seedata → ottiene un magnet
   e un link condivisibile. Da quel momento, finché la tab è aperta, la sta anche
   seedando: più utenti la aprono, più è resistente.

Se queste due cose funzionano end-to-end, l'MVP è fatto. Stop.

## Architettura (Fase 1)

Il gate è **una single-page app statica** (un bundle che chiunque può ri-hostare).
Nessun backend applicativo. Serve solo hosting statico su HTTPS.

Flusso di rendering:

- Il magnet sta nel **fragment dell'URL** (`https://gate/#<magnet|infohash>`).
  Il fragment NON viene mai mandato a nessun server: lo legge solo il client.
- Il client **WebTorrent gira nel contesto di pagina** (non nel service worker:
  il SW non può aprire connessioni WebRTC).
- Si usa l'API integrata di WebTorrent: `client.createServer({ controller })`,
  dove `controller` è la registrazione di un service worker. Il SW serve i file
  del torrent come se fosse un server HTTP, a `/webtorrent/<infoHash>/<path>`.
- Il sito viene mostrato in un **`<iframe sandbox>`** che punta a quell'URL.

NON reimplementare il fetch delle risorse a mano (niente tag custom tipo
`<t-img>`): il service worker intercetta TUTTE le richieste della pagina ed è
l'unico chokepoint. Questo è più completo E più sicuro dei tag custom.

## Modello di sicurezza (Fase 1, minimo ma non negoziabile)

- Ogni sito vive in un **iframe sandboxed**, isolato dalla chrome del gate
  (address bar, controlli). Un sito ostile non deve poter toccare l'app.
- **CSP stretta di default**: `script-src 'none'` e egress di rete bloccato
  (tutto deve risolvere dentro il torrent; URL esterni bloccati).
  Motivo: anche senza JS, un `<img>`/`background-image`/form verso un URL esterno
  rivela l'IP dell'utente. La difesa è sull'egress di rete, non solo sugli script.
- **Script opt-in per-sito**: l'utente attiva i `<script>` a mano per un sito.
  Anche da attivati, l'egress di rete resta vincolato.
- **Isolamento tra torrent**: un torrent non deve poter leggere le risorse di un
  altro (CSP + origini separate). Cross-torrent solo via path espliciti.

## Vincoli e bagni di realtà (documentare, non nascondere)

- I web peer si connettono solo ad altri peer WebRTC (tracker `wss://`).
  Il seeding da browser **muore quando la tab si chiude**. L'MVP lo accetta:
  la persistenza always-on è Fase 3.
- **Resistenza alla censura ≠ anonimato.** Nello swarm l'IP è visibile ai peer.
  È una scelta consapevole: proteggiamo i *contenuti* (non abbattibili), non
  l'identità di chi pubblica/legge. Non promettere anonimato da nessuna parte.
- Service worker richiede HTTPS (localhost esente in dev).

## Stack

- **WebTorrent** (versione corrente, con `createServer` + controller SW).
- JS vanilla o framework minimale. **Dipendenze al minimo.**
- Nessun build tool esotico in Fase 1: il bundle deve restare banale da
  ricompilare e da rihostare su qualsiasi static host / mirror.

## Esplicitamente FUORI SCOPE (fasi successive — NON implementare ora)

- **Fase 2 — Aggiornabilità & scoperta**: puntatori mutabili (BEP 46, sito =
  coppia di chiavi), indice dei mirror aperto e firmato, alias leggibili.
  Nota: BEP 46 risolve via DHT (UDP) → i browser non la raggiungono, servirà un
  ponte. Non affrontarlo finché l'MVP non gira.
- **Fase 2 — Build riproducibili**: toolchain/lockfile pinnati, timestamp
  azzerati, attestazioni di rebuild multi-parte. *Nice to have*, non blocca l'MVP.
- **Fase 3 — Gate content-addressed / TOFU**: pinning dell'hash del bundle del
  gate nel SW alla prima visita; `#gate=<hash>` nel link d'ingresso.
- **Fase 3 — Backbone di seeder always-on** per la persistenza reale.
- **Governance della release key** (singola vs multisig): decisione politica,
  rimandata. In Fase 1 la fiducia iniziale resta out-of-band, e va bene così.
- **Anonimato / Tor / .onion**: scartato dal design.

## Come lavorare su questo repo

- Preferisci sempre la soluzione più semplice che chiude uno dei due obiettivi MVP.
- Non introdurre le feature "Fuori scope" senza che venga chiesto esplicitamente.
- Mantieni il gate **statico e mirrorabile**: nessuna dipendenza da un dominio
  o da un backend specifico. Deve funzionare identico da qualsiasi mirror.
- `CONTENT_ISOLATION` (js/config.js) resta `null` nel repository: è un'opzione
  per i mirror con dominio proprio, DNS e certificato wildcard, mai un default.
  Ogni modifica deve tenere verdi entrambe le metà di `tools/e2e.mjs`, quella a
  origin condiviso e quella isolata. Vedi spec/second-origin-isolation.md.
- Path relativi ovunque; un sito pubblicato deve renderizzare uguale a come
  farebbe servito da un server statico qualsiasi.
- Ogni scelta che tocca la sicurezza (CSP, sandbox, egress) va motivata nel PR:
  è il cuore del progetto, non un dettaglio.
- Licenza: MIT.

## Definition of Done (MVP)

- [ ] Apro `https://gate/#<magnet>` e vedo il sito con tutte le sue risorse.
- [ ] Address bar interna: incollo un magnet e navigo senza ricaricare il gate.
- [ ] Trascino una cartella → ottengo magnet + link condivisibile → il sito è
      raggiungibile da un altro browser mentre tengo la tab aperta.
- [ ] Di default niente script e niente egress esterno; script attivabili per-sito.
- [ ] Il gate è un bundle statico che gira identico da un secondo mirror.
