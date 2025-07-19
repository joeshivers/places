# Places - Restaurant Tracker PWA

A Progressive Web App for tracking restaurants and happy hours in NYC.

## 🌟 Features

- 🍽️ **Restaurant Database** - Track your favorite spots with notes and ratings
- 🍹 **Happy Hour Tracker** - Find deals by day, time, and location  
- 📱 **Progressive Web App** - Install on mobile/desktop, works offline
- 📍 **Interactive Map** - View restaurant locations with clustering
- 🔄 **Offline Support** - Cached data works without internet
- 📊 **Timeline View** - See happy hours by time of day
- ❤️ **Favorites & Status** - Mark liked/visited restaurants
- 🎯 **Smart Filtering** - Filter by cuisine, neighborhood, borough, type

## 🚀 Live App

**Production**: [places.horse-rentals.org](https://places.horse-rentals.org)

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Node.js, Express  
- **Database**: SQLite3
- **Maps**: Leaflet.js with OpenStreetMap
- **PWA**: Service Workers, Web App Manifest
- **Deployment**: PM2, Nginx, Let's Encrypt SSL

## 📱 PWA Features

- ✅ **Installable** - Add to home screen
- ✅ **Offline Mode** - Works without internet  
- ✅ **Background Sync** - Updates when online
- ✅ **Fast Loading** - Cached resources
- ✅ **Mobile Optimized** - Responsive design

## 🏗️ Installation

### Development
```bash
git clone https://github.com/yourusername/places.git
cd places
npm install
npm start
```

Visit `http://localhost:3000`

### Production (VPS)
```bash
# Install Node.js & PM2
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# Deploy app
git clone https://github.com/yourusername/places.git /var/www/places
cd /var/www/places
npm install --production
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

## 🔧 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/restaurants` | GET | List restaurants with filtering |
| `/api/restaurants/:id` | GET | Get single restaurant |
| `/api/restaurants/:id` | PUT | Update restaurant |
| `/api/restaurants` | POST | Create restaurant |
| `/api/cuisines` | GET | List all cuisines |
| `/api/neighborhoods` | GET | List all neighborhoods |
| `/api/health` | GET | Health check |

## 📊 Database Schema

Main tables: `restaurants`, `cuisines`, `neighborhoods`, `types`, `tags`

Key fields:
- Restaurant info (name, address, borough)
- Categorization (cuisines, types, neighborhoods, tags)  
- User data (liked, status, notes, what_to_order)
- Happy hour data (structured JSON + text)

## 🎯 Usage Examples

### Filter Restaurants
- **By cuisine**: Click cuisine filter or use dropdown
- **By neighborhood**: Click neighborhood tags  
- **By status**: Filter visited/unvisited
- **By favorites**: Show only liked restaurants

### Happy Hour Features
- **Timeline view**: See happy hours by time
- **Day filters**: Filter by day of week
- **Location filters**: Find deals near you

### Offline Usage
1. Install PWA to home screen
2. Use normally - data cached automatically
3. Works offline after first visit
4. Syncs when connection restored

## 🚀 Deployment Notes

**Domain**: places.horse-rentals.org  
**Server**: RackNerd VPS (104.168.59.118)  
**SSL**: Let's Encrypt via Certbot  
**Process Manager**: PM2 with auto-restart  
**Reverse Proxy**: Nginx  

## 📄 License

MIT License