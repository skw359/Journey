# Journey Getting Started

Journey is designed to run on your own Linux server.

You should have:

- sudo/root access on the server
- basic Linux command line familiarity
- enough context to troubleshoot your own deployment

Journey is not a drag-and-drop hosted service. If you are not comfortable with basic Linux system administration, stop here and learn that first.

## Pick a Server OS

Recommended:

- Ubuntu 24.04 LTS (released April 25, 2024)
- Other Ubuntu-based distributions can work, but adapt commands as needed.

## Requirements

- A Linux server (VPS, Raspberry Pi, etc.)
- A domain name pointed at that server
- TLS certificate support (required for full pairing/mobile workflows)
- PostgreSQL (16+)
- Node.js
- npm
- Git
- A reverse proxy (Nginx recommended)
- A process manager (pm2 recommended, but systemd works too)

## 1. Prepare the Server

Update packages and install dependencies:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx postgresql postgresql-contrib curl ca-certificates
```

Install Node.js: https://nodejs.org/en/download

## 2. Create App Directory

The first step in this process is to create the folder where Journey will live and then move ourselves into that newly created folder. Below is an example of how to perform this operation.

```bash
sudo mkdir -p /var/www/journey
sudo chown -R $USER:$USER /var/www/journey
cd /var/www/journey
```

## 3. Download Project Files

If using git:

```bash
git clone <REPO_URL> .
```

Install dependencies:

```bash
npm install
cd client && npm install
cd ..
```

## 4. Configure PostgreSQL

Journey uses PostgreSQL as the primary database, though you can adapt to your needs.

Create a database user and database:

```bash
sudo -u postgres psql
```

Then in `psql`:

```sql
CREATE USER journey_user WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE journey_db OWNER journey_user;
GRANT ALL PRIVILEGES ON DATABASE journey_db TO journey_user;
\q
```

## 5. Configure Environment

Create `.env` in `/var/www/journey`:

```env
DATABASE_URL=postgres://journey_user:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:5432/journey_db
SESSION_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
PUBLIC_URL=https://journey.example.com
PORT=3003
MIN_ROUTE_MILES=0.25
```

Important:

- `PUBLIC_URL` should be your final HTTPS domain (not HTTP, not localhost).
- `SESSION_SECRET` should be a long random value, generated using node.

## 6. Build and Test Manually

Now it's time to put everything together and build the frontend. We use this command in the project directory (output will be in /client/dist/)

```bash
npm run build
```

To start the server:

```bash
npm start
```

Verify locally:

```bash
curl http://127.0.0.1:3003/ping
```

Expected response:

```text
pong
```

Stop the process (Ctrl+C) and continue.

## 7. Run Journey as a Service (systemd)

Create `/etc/systemd/system/journey.service`:

```ini
[Unit]
Description=Journey Web
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/journey
Environment=NODE_ENV=production
EnvironmentFile=/var/www/journey/.env
ExecStart=/usr/bin/node /var/www/journey/server/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Set ownership and start:

```bash
sudo chown -R www-data:www-data /var/www/journey
sudo systemctl daemon-reload
sudo systemctl enable --now journey
sudo systemctl status journey
```

## 8. Configure Nginx Reverse Proxy

Create `/etc/nginx/sites-available/journey`:

```nginx
server {
    listen 80;
    server_name journey.example.com;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable site:

```bash
sudo ln -s /etc/nginx/sites-available/journey /etc/nginx/sites-enabled/journey
sudo nginx -t
sudo systemctl reload nginx
```

## 9. Enable TLS (Let's Encrypt)

Install certbot and issue cert:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d journey.example.com
```

After TLS is enabled, confirm:

- `PUBLIC_URL` in `.env` matches `https://journey.example.com`
- `sudo systemctl restart journey`

## 10. Add the First User

Open your domain in a browser and register the first account.

That first account becomes your initial admin-like account for data ownership and migration flow.

Password requirement:

- minimum 4 characters

This service will store your location data, so please use a stronger password than the minimum.

## 11. Verification Checklist

- `https://journey.example.com/ping` returns `pong`
- You can register and log in
- `/api-docs` page loads
- Pairing page `/pair` loads and displays a QR code
- Uploads and journeys persist after service restart

## Troubleshooting

While not too complex, things can go wrong occasionally. The first step is to check all relevant logs:

- Service logs:

```bash
sudo journalctl -u journey -f
```

- Nginx logs:

```bash
sudo tail -f /var/log/nginx/error.log
```

- Or if using PM2:
```
pm2 logs
```

- In regards to the database:
  - Make sure your `DATABASE_URL` is correct.
  - Ensure PostgreSQL is running: `sudo systemctl status postgresql`
  - Confirm user/db permissions in `psql` (biggest factor usually)
