# Dossier d'audit sécurité et performance d'Alchimie

## Référentiel et périmètre

La cible de vérification est **OWASP ASVS 5.0.0, niveau 2**, complétée par les
recommandations de l'ANSSI sur TLS et la sécurité côté navigateur. Cette matrice
porte sur l'application Express, SQLite, la configuration Nginx et l'unité
systemd fournies dans ce dépôt. Elle ne vaut pas certification : l'infrastructure
réelle, le DNS, le fournisseur VPS, le SMTP et les procédures humaines devront
être contrôlés au moment de la mise en production.

Références figées pour rendre l'audit reproductible :

- [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0)
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- [ANSSI - Recommandations de sécurité relatives à TLS](https://messervices.cyber.gouv.fr/guides/recommandations-de-securite-relatives-tls)

## Matrice de preuves prioritaires

| Contrôle ASVS | Exigence | Preuve dans Alchimie | Vérification |
|---|---|---|---|
| V1.2.4 | Requêtes SQL paramétrées | Requêtes `better-sqlite3` préparées dans `routes/`, `middleware/` et `utils/` | Revue de code |
| V1.3.1 | Nettoyage du HTML non fiable | `utils/sanitize.js`, échappement EJS et liste blanche | Revue + test XSS |
| V2.2.1 / V2.2.2 | Validation côté serveur | Limites dans les routes et `middleware/input-guard.js` contre paramètres ambigus et clés d’injection | Revue + tests négatifs |
| V2.4.1 | Anti-automatisation | Limiteurs globaux, connexion, publication, upload, flux SSE et Bot Shield progressif | Revue + tests 404/403/429 |
| V3.3.1 à V3.3.4 | Cookie de session sûr | `HttpOnly`, `Secure`, `SameSite=Lax`, préfixe `__Host-` en production | `npm run audit:http` en HTTPS |
| V3.4.1 | HSTS | Helmet et `deploy/nginx-avebar.conf` | `npm run security:check` |
| V3.4.3 à V3.4.6 | CSP, `nosniff`, référent et anti-cadrage | Helmet dans `server.js` | `npm run audit:http` |
| V3.5.1 | Protection CSRF | `middleware/csrf.js`, origine et jeton de session | Test d'écriture sans jeton |
| V4.1.4 | Liste blanche des méthodes HTTP | GET, HEAD, POST et OPTIONS uniquement dans `server.js` | Test PUT/DELETE = 405 |
| V5 | Uploads sûrs | Décodage raster et réencodage WebP dans `utils/image-upload.js`, métadonnées supprimées, limites dimensions/frames/5 Mo, concurrence bornée, quotas atomiques et nom généré | Tests HTML, SVG, polyglotte et surdimensionnement |
| V6.2.1 | Politique de mot de passe | Validation et hachage bcrypt coût 12 dans l'authentification | Revue + test d'inscription |

Les protections détaillées, le modèle de menace et les risques résiduels sont
documentés dans `SECURITY.md`.

## Contrôles reproductibles

Depuis une copie de préproduction avec les mêmes variables que le VPS :

```bash
npm ci --omit=dev
npm test
npm run audit:local
AUDIT_BASE_URL=https://votre-domaine.fr npm run audit:http
```

`npm test` couvre notamment les payloads XSS, les sinks EJS bruts, l’absence
d’interpolation SQL depuis une requête, le Bot Shield, la pollution de paramètres
et le réencodage des uploads. `audit:local` vérifie notamment les dépendances connues vulnérables, les droits
des fichiers sensibles, l'intégrité et les clés étrangères SQLite, les index
critiques, le mode WAL, ainsi que le durcissement Nginx/systemd. `audit:http`
vérifie les en-têtes réellement observés et mesure les p50/p95. Les budgets sont
configurables avec `DB_P95_BUDGET_MS` et `HTTP_P95_BUDGET_MS`.

## Budget et protocole de performance

- Mesurer après cinq requêtes de chauffe, avec au moins trente échantillons.
- Conserver un p95 HTTP inférieur à 250 ms sur les pages publiques depuis la
  même région que le VPS ; adapter ce seuil seulement avec une justification.
- Contrôler les requêtes principales par `npm run performance:check` après toute
  migration ou modification des listes de topics/messages.
- Suivre CPU, mémoire, espace disque, latence p95 et taux de réponses 4xx/5xx sur
  le VPS. Un test local rapide ne remplace pas un test de charge réaliste.

## Vérifications externes avant ouverture publique

1. Scanner la configuration TLS du domaine et vérifier la chaîne de certificats.
2. Lancer un DAST authentifié et non authentifié (par exemple OWASP ZAP) sur une
   préproduction ne contenant aucune donnée réelle.
3. Faire vérifier manuellement les accès aux MP, à l'administration et aux
   contenus supprimés avec plusieurs comptes de rôles différents.
4. Tester une restauration complète des bases, sessions nécessaires et uploads.
5. Faire réaliser un test d'intrusion indépendant après stabilisation, puis
   conserver le rapport, les correctifs et les contre-tests comme preuves.
6. Répéter `audit:release` à chaque livraison et l'audit externe après toute
   modification majeure d'authentification, de permissions ou d'architecture.
