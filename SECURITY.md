# Sécurité d’Alchimie

Ce document décrit le modèle de menace, les protections déjà appliquées et les
mesures opérationnelles nécessaires. Il ne constitue pas une promesse
d’invulnérabilité : la sécurité dépend aussi du VPS, du DNS, du fournisseur SMTP,
des sauvegardes, des comptes du personnel et de la rapidité d’installation des
correctifs.

## 1. Données et frontières de confiance

- Données publiques : profils, topics, messages, sondages, statistiques et
  historique public de modération.
- Données confidentielles : adresses e-mail, messages privés, cookies de session,
  secrets applicatifs, sauvegardes et signaux techniques de sécurité.
- Données hautement sensibles : comptes développeur/administrateur, mot de passe
  du centre de contrôle et clés présentes dans `/etc/avebar/avebar.env`.
- Frontières : navigateur ↔ Nginx ↔ application Node ↔ SQLite / stockage local ;
  application ↔ serveur SMTP ; navigateur ↔ YouTube, TikTok, Imgur ou hôtes
  d’avatars choisis par les membres.

## 2. Menaces répertoriées et état des protections

| Menace | Impact principal | Protection appliquée |
|---|---|---|
| Vol, fixation ou réutilisation de session | Prise de compte | Identifiant régénéré après connexion et déverrouillage staff, cookie `HttpOnly`, `Secure` en production, `SameSite=Lax`, préfixe `__Host-`, expiration d’inactivité, durée absolue de 7 jours et invalidation globale après changement de mot de passe |
| CSRF | Publication, suppression ou sanction à l’insu d’un membre connecté | Jeton aléatoire lié à la session sur toutes les écritures, vérification `Origin`/`Referer` et rejet de `Sec-Fetch-Site` non fiable |
| XSS stockée/réfléchie | Vol de session, actions au nom de la victime | Échappement EJS, liste blanche `sanitize-html`, URL et balises limitées, CSP, scripts uniquement locaux, iframes isolées |
| Injection SQL | Lecture ou altération de la BDD | Requêtes préparées ; seules quelques constructions internes utilisent des fragments issus de listes fermées |
| Pollution de paramètres / clés d’injection | Contournement de validation, erreurs serveur | Garde global refusant tableaux, objets, doublons ambigus, clés `$...` et clés de pollution de prototype ; textes libres conservés |
| IDOR / accès aux MP | Lecture d’une conversation d’autrui | Vérification serveur de l’appartenance avant chaque page, fragment, flux, upload et envoi ; réponse 404 uniforme |
| Pixel de pistage dans un MP | Divulgation de l’IP d’un destinataire | Les médias externes restent de simples liens dans les MP ; seules les images servies localement par `/media` sont intégrées |
| Escalade de privilèges | Contrôle de la modération | Contrôles serveur par rôle, hiérarchie des rôles, second verrou, durée courte, journalisation des changements |
| Force brute / credential stuffing | Prise de compte | Limites par source et par identifiant, bcrypt coût 12, réponse générique, journal d’alertes, limite Nginx et Fail2ban recommandés |
| Compte factice | Spam et abus | Validation e-mail avec jeton aléatoire haché, usage unique et expiration 24 h |
| Upload malveillant ou saturation disque | XSS, déni de service, remplissage du VPS | Décodage réel par Sharp, formats raster en liste blanche, réencodage WebP sans métadonnées ni contenu ajouté, extension générée, `nosniff`, CSP restrictive, limites pixels/images animées/5 Mo, concurrence bornée, quotas atomiques membre et capacité globale |
| Scanner automatisé / reconnaissance | Recherche de secrets, composants obsolètes ou consoles | Bot Shield progressif : 404 silencieuse aux premières sondes, empreinte pseudonymisée, blocage temporaire après cinq motifs fiables, journal persistant et déblocage staff sans IP brute |
| Épuisement par SSE / requêtes | Déni de service | Nombre de flux limité, expiration automatique des flux, fréquence de frappe limitée, limite globale Express, flood Bot Shield à seuil élevé et exemptions pour les flux légitimes |
| Fuite d’une copie SQLite | Exposition des e-mails et MP | Chiffrement AES-256-GCM des e-mails et messages privés en production ; index e-mail par HMAC ; mots de passe hachés et salés |
| Vol du VPS ou des secrets | Compromission complète | Processus non-root, code en lecture seule via systemd, permissions `0600/0700`, pare-feu, SSH par clés, secrets hors dépôt et sauvegardes chiffrées |
| Dépendance compromise | Exécution de code / faille connue | Dépendances inutiles retirées, lockfile, audit npm sans vulnérabilité connue, installation par `npm ci`, contrôle périodique |
| Fuite par journaux | Données personnelles exposées | Adresse IP remplacée par une empreinte HMAC courte, valeurs nettoyées et tronquées, rétention 90 jours, aucun mot de passe ou corps de MP journalisé |
| SSRF / lecture de fichiers | Accès au réseau ou au disque par le serveur | L’application n’effectue aucune récupération serveur des URL de profil/média ; Nodemailer interdit les accès fichier/URL dans les messages |
| Clickjacking / MIME sniffing | Actions trompeuses, exécution inattendue | `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `object-src 'none'` |

## 3. Risques résiduels importants

1. Une compromission root du VPS ou du compte système `avebar` permet de lire la
   clé de chiffrement en mémoire ou dans l’environnement. Le chiffrement protège
   surtout une BDD ou une sauvegarde copiée isolément.
2. Un DDoS volumétrique doit être absorbé en amont par l’hébergeur ou un service
   anti-DDoS/CDN. L’application et Nginx ne peuvent pas protéger la bande passante
   du VPS.
3. Le second mot de passe du centre de contrôle est partagé entre les membres du
   staff. Pour une sécurité maximale, ajouter ensuite un second facteur TOTP ou
   WebAuthn individuel aux comptes administrateur et développeur.
4. Les avatars externes, Imgur, YouTube et TikTok révèlent l’adresse IP du visiteur
   à ces services lors de leur chargement. Le lecteur musical ne se charge qu’après
   action, mais les images externes restent un compromis fonctionnel.
5. SQLite convient à un unique VPS et à une charge modérée. Une forte montée en
   charge nécessitera une base gérée, des sessions partagées et un bus temps réel
   externe.

## 4. Règles de mise en production

- Utiliser Node.js 24 LTS, Nginx, le service systemd fourni et un utilisateur
  système sans shell ni droits sudo.
- Ne jamais publier `.env`, la BDD, les sessions, les uploads ou les sauvegardes.
- Générer trois secrets distincts : `SESSION_SECRET`, `SECURITY_LOG_KEY` et
  `DATA_ENCRYPTION_KEY`. Stocker une copie hors ligne de la clé de chiffrement.
- Activer HTTPS avant de lancer l’application en mode production.
- Autoriser uniquement `22/tcp` (si possible limité à une IP d’administration),
  `80/tcp` et `443/tcp`. Le port Node reste lié à `127.0.0.1`.
- Désactiver SSH par mot de passe et la connexion root ; utiliser des clés avec
  phrase secrète. Activer les mises à jour de sécurité automatiques et Fail2ban.
- Faire des sauvegardes SQLite cohérentes avec `npm run backup`, puis sauvegarder
  aussi les uploads avec Restic/Borg vers un stockage distant chiffré. Tester une
  restauration chaque mois.
- Exécuter `npm run security:check` et `npm audit --omit=dev` avant chaque mise en
  ligne et après chaque mise à jour.

## 5. Veille et réponse à incident

- Hebdomadaire : dépendances, alertes Node.js, Express, Helmet, SQLite et système.
- Quotidien : signaux critiques et Bot Shield dans `/admin/securite`, erreurs Nginx,
  utilisation disque, tentatives de connexion et disponibilité des sauvegardes.
- Mensuel : restauration de sauvegarde, revue des comptes staff, rotation des
  accès devenus inutiles, contrôle TLS et permissions.
- Incident suspecté : passer en maintenance, préserver les journaux, révoquer les
  sessions en incrémentant `session_version`, changer tous les secrets concernés,
  corriger la cause, restaurer depuis une sauvegarde vérifiée puis notifier les
  personnes et autorités compétentes lorsque la loi l’exige.

Les failles doivent être transmises en privé à l’adresse de contact configurée,
avec étapes de reproduction, impact supposé et sans consulter davantage de
données que nécessaire.
