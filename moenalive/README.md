# MoenaLive

Worker di pubblicazione della PWA **MoenaLive** su un'origine distinta da
PozzaLive. Il frontend continua a essere mantenuto in
`andreavio00/meteo-fassa`; questo Worker inoltra solamente i file pubblici di
GitHub Pages e presenta `moena.html` come pagina iniziale.

Questa separazione evita che Chrome consideri Moena una pagina interna della
PWA PozzaLive già installata. Non vengono interrogate nuove fonti meteo e non
sono necessari binding, variabili o secret.

## Indirizzo previsto

```text
https://moenalive.andrea-vio.workers.dev/
```

## Configurazione Cloudflare

- repository: `andreavio00/meteo-fassa-workers`
- production branch: `main`
- root directory: `moenalive`
- build command: nessuno
- deploy command: `npx wrangler deploy`
- version command: `npx wrangler versions upload`
- variabili, secret e binding: nessuno

## Percorsi speciali

- `/` e `/index.html` espongono `moena.html`;
- `/manifest.webmanifest` espone `moena.webmanifest`;
- le icone generiche vengono sostituite con quelle verdi di MoenaLive;
- gli altri file vengono letti dallo stesso sito GitHub Pages.

## Test

```bash
npm test
```
