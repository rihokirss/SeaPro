// pm2 seadistus. .cjs laiend on kohustuslik — juurpakett on "type": "module",
// seega .js fail loetaks ESM-ina ja pm2 ei oskaks seda lugeda.
//
// Kasutus:
//   npm run build && pm2 start ecosystem.config.cjs
//   pm2 logs seapro
//   pm2 restart seapro

module.exports = {
  apps: [
    {
      name: 'seapro',
      script: 'server/dist/index.js',
      cwd: __dirname,

      // .env otsitakse cwd suhtes. Vahemälu ja web/dist leiab server ise
      // import.meta.url kaudu, seega cwd neid ei mõjuta.
      node_args: '--env-file-if-exists=.env',
      env: { NODE_ENV: 'production' },

      // Üks protsess, mitte cluster: taustatööd (AIS-ühendus, jaamade
      // pollimine) ei tohi mitmes koopias korraga käia.
      instances: 1,
      exec_mode: 'fork',

      // Vahemälu kettale kirjutamine käib SIGINT/SIGTERM pealt — anna aega.
      kill_timeout: 10_000,
      autorestart: true,
      restart_delay: 5_000,
      // Kui mõni väline allikas on pikalt maas, ei tohi see teenust surnuks lugeda.
      max_restarts: 50,
      min_uptime: 30_000,

      // Vahemälu hoitakse mälus; 22 MB cache.json + prognoosid mahuvad hõlpsalt.
      max_memory_restart: '1G',

      merge_logs: true,
      time: true,
    },
  ],
};
