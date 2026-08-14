# Alchimie

Forum web léger et auto-hébergé : Node.js + Express + EJS + SQLite (aucune base de
données externe à installer, tout tient dans un fichier `forum.sqlite3`).

Fonctionnalités : comptes SQLite validés par e-mail, profils personnalisés,
rôles membre/modérateur/administrateur/développeur, sanctions temporaires ou
définitives, journal public de modération, statistiques par période, sondages
attachés aux messages, sujets épinglés et consoles d'administration sécurisées.

## 1. Tester en local

Prérequis : Node.js 22+ ; Node.js 24 LTS est recommandé en production.

```bash
cd forum
npm install
cp .env.example .env
# édite .env : mets un SESSION_SECRET aléatoire et un mot de passe admin
npm run seed      # crée quelques catégories/forums de démo (une seule fois)
npm start
```

Le forum écoute sur http://localhost:3000. Un compte admin est créé
automatiquement au tout premier démarrage avec le pseudo/mot de passe définis
dans `.env` (`ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`) - connecte-toi puis va sur
`/compte` pour changer le mot de passe si besoin. Le centre de contrôle demande
également le second mot de passe `MODERATION_PASSWORD` (initialement `1234` en
local). Le mode production refuse de démarrer tant que cette valeur initiale ou
un secret faible est encore utilisé.

## 2. Déploiement sur un VPS (Ubuntu/Debian)

Ces étapes utilisent Nginx, HTTPS et une unité systemd fortement cloisonnée.
Lis aussi [SECURITY.md](SECURITY.md) et le
[dossier d'audit](SECURITY-AUDIT.md) avant toute ouverture publique.

### 2.1 Préparer le serveur

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git certbot python3-certbot-nginx fail2ban unattended-upgrades

# Installer Node.js 24 LTS depuis une source de paquets de confiance
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo adduser --system --group --home /var/lib/avebar --shell /usr/sbin/nologin avebar
sudo install -d -o avebar -g avebar -m 0700 /var/lib/avebar /var/lib/avebar/uploads /var/lib/avebar/backups
sudo install -d -o root -g avebar -m 0750 /etc/avebar
```

### 2.2 Déployer le code

```bash
sudo install -d -o root -g root -m 0755 /opt/avebar
# Copie le projet dans /opt/avebar, puis :
cd /opt/avebar
sudo npm ci --omit=dev
sudo cp .env.example /etc/avebar/avebar.env
sudo chown root:avebar /etc/avebar/avebar.env
sudo chmod 0640 /etc/avebar/avebar.env
sudo nano /etc/avebar/avebar.env
```

Dans ce fichier, utilise `NODE_ENV=production`, `HOST=127.0.0.1`,
`SITE_URL=https://votre-domaine.fr`, `COOKIE_SECURE=true`, ainsi que :

```dotenv
DB_PATH=/var/lib/avebar/forum.sqlite3
SESSION_DB_PATH=/var/lib/avebar/sessions.sqlite3
UPLOAD_DIR=/var/lib/avebar/uploads
BACKUP_DIR=/var/lib/avebar/backups
```

Génère séparément `SESSION_SECRET`, `SECURITY_LOG_KEY` et
`DATA_ENCRYPTION_KEY`. Ne réutilise jamais un mot de passe pour une clé.
Renseigne aussi un SMTP réel, `ADMIN_EMAIL` et toutes les mentions légales.

### 2.3 Lancer avec systemd

```bash
sudo cp deploy/avebar.service /etc/systemd/system/avebar.service
sudo systemctl daemon-reload
sudo systemctl enable --now avebar
sudo systemctl status avebar
```

Les journaux se consultent avec `journalctl -u avebar`. Le service exécute Node
sans privilège, rend le code en lecture seule et n’autorise les écritures que
dans `/var/lib/avebar`.

### 2.4 Nginx en reverse proxy + HTTPS

Obtiens d’abord le certificat, adapte les domaines dans les fichiers fournis,
puis installe la configuration renforcée :

```bash
sudo certbot certonly --nginx -d votre-domaine.fr -d www.votre-domaine.fr
sudo cp deploy/avebar-proxy.conf /etc/nginx/snippets/avebar-proxy.conf
sudo cp deploy/nginx-avebar.conf /etc/nginx/sites-available/avebar
sudo ln -s /etc/nginx/sites-available/avebar /etc/nginx/sites-enabled/avebar
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo cp deploy/avebar-auth-filter.conf /etc/fail2ban/filter.d/avebar-auth.conf
sudo cp deploy/fail2ban-avebar.conf /etc/fail2ban/jail.d/avebar.conf
sudo fail2ban-client reload
sudo fail2ban-client status avebar-auth
```

La configuration limite les requêtes et connexions, isole les flux temps réel,
refuse les corps supérieurs à 6 Mo et n’expose jamais directement Node.

### 2.5 Pare-feu

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status verbose
```

Le port 3000 (Node) n'a pas besoin d'être ouvert au public : seul Nginx doit
y accéder en local. Désactive aussi l’authentification SSH par mot de passe et
la connexion root après avoir vérifié ton accès par clé.

## 3. Sauvegardes

Ne copie jamais directement une base SQLite active. Le script utilise l’API de
sauvegarde SQLite et génère une somme SHA-256 :

```bash
cd /opt/avebar
sudo -u avebar env DOTENV_CONFIG_PATH=/etc/avebar/avebar.env \
  node -r dotenv/config scripts/backup.js
```

Sauvegarde également les uploads avec Restic ou Borg vers un stockage distant
chiffré, et conserve séparément `DATA_ENCRYPTION_KEY`. Une sauvegarde sans cette
clé ne permet pas de récupérer les e-mails et les messages privés.

## 4. Contrôle avant ouverture

```bash
cd /opt/avebar
sudo -u avebar env DOTENV_CONFIG_PATH=/etc/avebar/avebar.env \
  node -r dotenv/config scripts/security-check.js
sudo -u avebar env DOTENV_CONFIG_PATH=/etc/avebar/avebar.env \
  node -r dotenv/config scripts/performance-check.js
AUDIT_BASE_URL=https://votre-domaine.fr npm run audit:http
```

Ces contrôles vérifient la configuration de production, les permissions,
l’intégrité et les clés étrangères SQLite, les index, les dépendances, le
durcissement Nginx/systemd, les en-têtes HTTP réellement servis et les budgets
de temps de réponse. Ils doivent réussir avant chaque mise en production. Le
serveur refuse aussi de démarrer avec `1234`, avec un secret d’exemple, sans
chiffrement, sans SMTP ou avec un compte staff non validé.

## 5. Administration

- Le premier compte créé via `.env` (ADMIN_USERNAME/ADMIN_PASSWORD) a le
  rôle développeur.
- `/admin` adapte ses fonctions au rôle connecté. Les modérateurs sanctionnent
  les membres ; les administrateurs gèrent aussi la structure et les
  nominations de modérateurs ; les développeurs peuvent nommer tous les rôles.
- `/developpeur` affiche l'état du VPS, du processus et l'activité récente dans
  un moniteur en lecture seule. Aucun shell arbitraire n'est exposé au web.
- `/moderation` et `/statistiques` sont publiques.

## 6. Structure du projet

```
forum/
├── server.js           point d'entrée Express
├── db/
│   ├── database.js      connexion SQLite + création du schéma
│   └── seed.js          catégories/forums de démo (optionnel)
├── middleware/auth.js   session, rôles
├── routes/               auth.js, forum.js, account.js, admin.js
├── views/                templates EJS
├── public/css/style.css  thème sombre façon forum "à l'ancienne"
└── .env.example
```

## 7. Profils et médias

Les avatars acceptent des URL HTTPS PNG/JPG/GIF. Le fond de profil doit être
hébergé sur Imgur. La musique utilise un lien YouTube et est intégrée avec le
domaine respectueux de la vie privée `youtube-nocookie.com`. La biographie
accepte uniquement les balises documentées dans la page des paramètres.
