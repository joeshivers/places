#!/bin/bash

# Places App Deployment Script
# Deploy to: places.horse-rentals.org (104.168.59.118)

echo "📦 Packaging Places app for production deployment..."

# Create deployment directory
mkdir -p deploy-package
cd deploy-package

# Copy essential files
echo "📄 Copying application files..."
cp ../server.js .
cp ../package.json .
cp ../package-lock.json .
cp ../manifest.json .
cp ../index.html .
cp ../sw.js .
cp ../restaurants.db .

# Copy icons directory
cp -r ../icons .

# Create production server.js (without HTTPS, nginx will handle that)
echo "⚙️ Creating production server configuration..."
cat > server-production.js << 'EOF'
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Trust proxy for nginx
app.set('trust proxy', 1);

// Serve static files with proper headers for PWA
app.use(express.static('.', {
    setHeaders: (res, path) => {
        // Service worker should not be cached
        if (path.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Service-Worker-Allowed', '/');
        }
        // Manifest with short cache
        if (path.endsWith('manifest.json')) {
            res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
        }
        // Static assets with longer cache
        if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
        }
    }
}));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Database connection
const db = new sqlite3.Database('./restaurants.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
        process.exit(1);
    }
    console.log('Connected to SQLite database');
});

// Health check endpoint (with environment info)
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Places API server running in production',
        environment: process.env.NODE_ENV || 'production',
        timestamp: new Date().toISOString(),
        database: 'SQLite connected'
    });
});
EOF

# Copy the rest of the API endpoints from original server
echo "📡 Adding API endpoints..."
# Extract API routes from original server.js (skip the server startup part)
grep -A 10000 "// Get all restaurants" ../server.js | grep -B 10000 "// Start.*server" | head -n -5 >> server-production.js

# Add server startup
cat >> server-production.js << 'EOF'

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed');
        process.exit(0);
    });
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 Places app running on http://127.0.0.1:${PORT}`);
    console.log(`🌐 Production domain: places.horse-rentals.org`);
    console.log(`📱 PWA ready with proper SSL via nginx`);
});
EOF

# Create package.json for production
cat > package-production.json << 'EOF'
{
  "name": "places-restaurant-tracker",
  "version": "1.0.0",
  "description": "Restaurant and happy hour tracker PWA",
  "main": "server-production.js",
  "scripts": {
    "start": "node server-production.js",
    "dev": "NODE_ENV=development node server-production.js",
    "prod": "NODE_ENV=production node server-production.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "sqlite3": "^5.1.6",
    "cors": "^2.8.5"
  },
  "engines": {
    "node": ">=16.0.0"
  }
}
EOF

# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'places-app',
    script: 'server-production.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOF

# Create logs directory
mkdir -p logs

# Create deployment instructions
cat > DEPLOY.md << 'EOF'
# Places App Deployment Instructions

## Server Setup (on VPS):

1. Install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2. Install PM2:
```bash
sudo npm install -g pm2
```

3. Install nginx:
```bash
sudo apt update
sudo apt install nginx
```

4. Create app directory:
```bash
sudo mkdir -p /var/www/places
sudo chown $USER:$USER /var/www/places
```

## Deploy App:

1. Upload all files to `/var/www/places/`
2. Install dependencies:
```bash
cd /var/www/places
npm install
```

3. Start with PM2:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Nginx Configuration:

Create `/etc/nginx/sites-available/places`:
```nginx
server {
    listen 80;
    server_name places.horse-rentals.org;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name places.horse-rentals.org;

    ssl_certificate /etc/letsencrypt/live/places.horse-rentals.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/places.horse-rentals.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/places /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## SSL Certificate:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d places.horse-rentals.org
```

## DNS Configuration:

Add A record:
- Name: places
- Type: A
- Value: 104.168.59.118
- TTL: 300
EOF

echo "✅ Deployment package created in deploy-package/"
echo "📋 Next steps:"
echo "1. Configure DNS: places.horse-rentals.org → 104.168.59.118"
echo "2. Upload deploy-package/* to VPS"
echo "3. Follow instructions in DEPLOY.md"
echo "4. Set up SSL with Let's Encrypt"

cd ..