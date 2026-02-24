# Deployment Guide — RSS Sports Ticker

This guide explains how to deploy the RSS Sports Ticker app so it runs 24/7 and your NovaStar player can reach it at a public URL.

---

## Quick Answer: Can This Run on SiteGround Shared Hosting?

**No.** SiteGround shared hosting (the most common plan) runs PHP websites. It does **not** support running a Node.js server that stays on 24/7, which is what this app requires.

You have three options:

| Option | Difficulty | Monthly Cost | Best For |
|---|---|---|---|
| **A) Render.com** | Easiest | Free tier available | Just get it running fast |
| **B) SiteGround Cloud** | Medium | ~$100/mo (you may already have it) | Keep everything on SiteGround |
| **C) DigitalOcean / VPS** | Medium | ~$6/mo | Cheapest long-term |

---

## OPTION A — Deploy on Render.com (Easiest, Recommended)

This is the fastest way to get a public URL. No server management needed.

### Step 1: Put the project on GitHub

If the project is not already on GitHub:

1. Go to https://github.com and sign in (or create a free account)
2. Click the **+** button in the top right, then **New repository**
3. Name it `rss-sports-feed`, set it to **Private**, click **Create repository**
4. Follow the instructions on screen to upload the project files
   - Or if someone sends you a `.zip` file, extract it, then drag all files into the GitHub page

### Step 2: Create a Render account

1. Go to https://render.com
2. Click **Get Started for Free**
3. Sign up with your GitHub account (this makes Step 3 easier)

### Step 3: Create a new Web Service

1. From the Render dashboard, click **New +** then **Web Service**
2. Connect your GitHub account if prompted
3. Select the `rss-sports-feed` repository
4. Fill in these settings:

```
Name:           rss-sports-feed
Region:         (pick the closest to your LED sign location)
Branch:         main
Runtime:        Node
Build Command:  npm install
Start Command:  npm start
Instance Type:  Free (or Starter at $7/mo for always-on)
```

5. Click **Create Web Service**

### Step 4: Wait for it to build

Render will install everything and start the app. This takes 2-3 minutes.
You will see logs scrolling. When you see `Server running at...` it's ready.

### Step 5: Get your public URL

Render gives you a URL like:

```
https://rss-sports-feed.onrender.com
```

Your RSS feed is at:

```
https://rss-sports-feed.onrender.com/rss.xml
```

You can verify it works by opening that URL in your browser. You should see XML with game data.

### Step 6: Point your NovaStar player to the RSS feed

In your NovaStar software, set the RSS source to:

```
https://rss-sports-feed.onrender.com/rss.xml
```

### Important note about Render Free tier

The free tier sleeps after 15 minutes of no traffic. This means the first request after sleep takes ~30 seconds. For a production LED sign, upgrade to the **Starter plan ($7/month)** which stays on 24/7.

---

## OPTION B — Deploy on SiteGround Cloud Hosting

This only works if you have **SiteGround Cloud** (not shared hosting). Cloud plans start around $100/month and give you a virtual server with root access.

### How to check which plan you have

1. Log in to https://my.siteground.com
2. Look at your dashboard — if it says **Cloud** you have cloud hosting
3. If it says **StartUp**, **GrowBig**, or **GoGeek** — that is shared hosting and this will NOT work

### If you have SiteGround Cloud, follow these steps:

#### Step 1: Enable SSH Access

1. Log in to https://my.siteground.com
2. Go to **Websites** > pick your site > **Site Tools**
3. Go to **Devs** > **SSH Keys Manager**
4. Click **Generate New Key**
5. Download the private key file and save it somewhere safe
6. Note your SSH connection details shown on that page:
   - Hostname (something like `ssh.yourdomain.com`)
   - Port (usually `18765`)
   - Username

#### Step 2: Connect via SSH

Open **Terminal** (Mac) or **Command Prompt** (Windows):

```bash
ssh your-username@ssh.yourdomain.com -p 18765
```

It will ask for your password or use your SSH key.

#### Step 3: Check if Node.js is installed

```bash
node --version
```

If you see a version number like `v18.x.x` or higher, skip to Step 4.

If not, install Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
```

Verify:

```bash
node --version
npm --version
```

#### Step 4: Upload the project

Still in SSH, create a folder and upload the project:

```bash
mkdir -p ~/rss-sports-feed
cd ~/rss-sports-feed
```

**To upload files**, use one of these methods:

**Method A — Git (if project is on GitHub):**
```bash
git clone https://github.com/YOUR-USERNAME/rss-sports-feed.git .
```

**Method B — SFTP upload:**
Use an FTP program like FileZilla. Connect using your SSH credentials and upload all project files to the `~/rss-sports-feed` folder.

#### Step 5: Install dependencies

```bash
cd ~/rss-sports-feed
npm install
```

#### Step 6: Test that it works

```bash
npm start
```

You should see:
```
Server running at http://localhost:3000
```

Press `Ctrl+C` to stop it (we'll set it up properly next).

#### Step 7: Install PM2 (keeps the app running 24/7)

```bash
npm install -g pm2
```

Start the app with PM2:

```bash
cd ~/rss-sports-feed
BASE_URL=https://feed.yourdomain.com pm2 start npm --name "sports-feed" -- start
```

Make it restart automatically if the server reboots:

```bash
pm2 save
pm2 startup
```

(If `pm2 startup` prints a command, copy and run that command.)

#### Step 8: Set up a subdomain

1. Go to **Site Tools** > **Domain** > **Subdomains**
2. Create a subdomain: `feed` (this creates `feed.yourdomain.com`)

#### Step 9: Set up reverse proxy

The app runs on port 3000, but websites use port 80/443. We need to route traffic.

In **Site Tools** > **Devs** > **Nginx Configuration**, add:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

If SiteGround doesn't give you Nginx access, contact their support and ask them to set up a reverse proxy from `feed.yourdomain.com` to `localhost:3000`.

#### Step 10: Test it

Open your browser and go to:

```
https://feed.yourdomain.com/rss.xml
```

You should see the RSS feed XML. If yes — it's working!

#### Useful PM2 commands

```bash
pm2 status              # check if app is running
pm2 logs sports-feed    # see app logs
pm2 restart sports-feed # restart the app
pm2 stop sports-feed    # stop the app
```

---

## OPTION C — Deploy on DigitalOcean ($6/month)

This is the cheapest option for a server that stays on 24/7.

### Step 1: Create a Droplet

1. Go to https://www.digitalocean.com and create an account
2. Click **Create** > **Droplets**
3. Choose:
   - **Image:** Ubuntu 22.04
   - **Plan:** Basic, $6/month (1 GB RAM)
   - **Region:** closest to your LED sign
4. Set a root password
5. Click **Create Droplet**

### Step 2: Connect to your server

You'll get an IP address (like `167.99.100.50`). Open Terminal and run:

```bash
ssh root@167.99.100.50
```

### Step 3: Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Step 4: Upload and run the project

```bash
git clone https://github.com/YOUR-USERNAME/rss-sports-feed.git
cd rss-sports-feed
npm install
```

### Step 5: Set up PM2

```bash
npm install -g pm2
BASE_URL=http://167.99.100.50:3000 pm2 start npm --name "sports-feed" -- start
pm2 save
pm2 startup
```

### Step 6: Open the firewall

```bash
ufw allow 3000
```

### Step 7: Test

Open in browser:

```
http://167.99.100.50:3000/rss.xml
```

Point your NovaStar player to this URL.

(Optional: Set up a domain name and HTTPS later for a cleaner URL.)

---

## After Deployment — How to Update

Whenever the app code changes, you need to update the server:

### On Render.com
Updates happen automatically when you push to GitHub. No action needed.

### On SiteGround Cloud or DigitalOcean
SSH into the server and run:

```bash
cd ~/rss-sports-feed
git pull
npm install
pm2 restart sports-feed
```

---

## Summary

| What | URL |
|---|---|
| RSS Feed | `https://feed.yourdomain.com/rss.xml` |
| Preview page | `https://feed.yourdomain.com/preview` |
| Health check | `https://feed.yourdomain.com/health` |
| Single image | `https://feed.yourdomain.com/images/nba-phi-chi-20260224.png` |

---

Once deployed, your RSS link will be:

**https://feed.yourdomain.com/rss.xml**

Point your NovaStar player to this URL and the ticker images will appear on your LED screen.
