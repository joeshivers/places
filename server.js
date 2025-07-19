const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Trust proxy for nginx
app.set('trust proxy', 1);

// Serve static files with PWA-optimized headers
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Places API server running in production',
        environment: process.env.NODE_ENV || 'production',
        timestamp: new Date().toISOString(),
        database: 'SQLite connected'
    });
});

// Get all restaurants with filtering
app.get('/api/restaurants', (req, res) => {
    const { 
        search, 
        cuisines, 
        types, 
        tags,
        neighborhoods, 
        boroughs, 
        status, 
        liked,
        limit = 10000,
        offset = 0 
    } = req.query;
    
    let query = `
        SELECT DISTINCT
            r.*,
            GROUP_CONCAT(DISTINCT c.name) as cuisines,
            GROUP_CONCAT(DISTINCT t.name) as types,
            GROUP_CONCAT(DISTINCT n.name) as neighborhoods,
            GROUP_CONCAT(DISTINCT tg.name || ':' || tg.color) as tags
        FROM restaurants r
        LEFT JOIN restaurant_cuisines rc ON r.id = rc.restaurant_id
        LEFT JOIN cuisines c ON rc.cuisine_id = c.id
        LEFT JOIN restaurant_types rt ON r.id = rt.restaurant_id
        LEFT JOIN types t ON rt.type_id = t.id
        LEFT JOIN restaurant_neighborhoods rn ON r.id = rn.restaurant_id
        LEFT JOIN neighborhoods n ON rn.neighborhood_id = n.id
        LEFT JOIN restaurant_tags rtag ON r.id = rtag.restaurant_id
        LEFT JOIN tags tg ON rtag.tag_id = tg.id
        WHERE 1=1
    `;
    
    const params = [];
    
    // Search filter - we'll handle this in HAVING clause to include aggregated fields
    let searchTerm = null;
    if (search) {
        searchTerm = `%${search}%`;
    }
    
    // Borough filter
    if (boroughs) {
        query += ` AND r.borough = ?`;
        params.push(boroughs);
    }
    
    // Neighborhood filter - now handled with HAVING clause since it's aggregated
    // We'll add this after the GROUP BY clause
    
    // Status filter
    if (status) {
        query += ` AND r.status = ?`;
        params.push(status);
    }
    
    // Liked filter
    if (liked !== undefined) {
        query += ` AND r.liked = ?`;
        params.push(liked === 'true' ? 1 : 0);
    }
    
    // Add GROUP BY before filtering by cuisines/types to avoid issues
    query += ` GROUP BY r.id`;
    
    // Cuisine filter - using HAVING instead of WHERE for aggregated data
    if (cuisines) {
        const cuisineList = cuisines.split(',').map(c => c.trim()).filter(c => c);
        if (cuisineList.length > 0) {
            const cuisineConditions = cuisineList.map(() => `GROUP_CONCAT(DISTINCT c.name) LIKE ?`).join(' OR ');
            query += ` HAVING (${cuisineConditions})`;
            cuisineList.forEach(cuisine => params.push(`%${cuisine}%`));
        }
    }
    
    // Neighborhood filter - using HAVING for aggregated data
    if (neighborhoods && !cuisines) {
        const neighborhoodList = neighborhoods.split(',').map(n => n.trim()).filter(n => n);
        if (neighborhoodList.length > 0) {
            const neighborhoodConditions = neighborhoodList.map(() => `GROUP_CONCAT(DISTINCT n.name) LIKE ?`).join(' OR ');
            query += ` HAVING (${neighborhoodConditions})`;
            neighborhoodList.forEach(neighborhood => params.push(`%${neighborhood}%`));
        }
    } else if (neighborhoods && cuisines) {
        const neighborhoodList = neighborhoods.split(',').map(n => n.trim()).filter(n => n);
        if (neighborhoodList.length > 0) {
            const neighborhoodConditions = neighborhoodList.map(() => `GROUP_CONCAT(DISTINCT n.name) LIKE ?`).join(' OR ');
            query += ` AND (${neighborhoodConditions})`;
            neighborhoodList.forEach(neighborhood => params.push(`%${neighborhood}%`));
        }
    }
    
    // Type filter - using HAVING for aggregated data
    if (types && !cuisines && !neighborhoods) {
        // Only add HAVING if we didn't already add it for cuisines/neighborhoods
        const typeList = types.split(',').map(t => t.trim()).filter(t => t);
        if (typeList.length > 0) {
            const typeConditions = typeList.map(() => `GROUP_CONCAT(DISTINCT t.name) LIKE ?`).join(' OR ');
            query += ` HAVING (${typeConditions})`;
            typeList.forEach(type => params.push(`%${type}%`));
        }
    } else if (types && (cuisines || neighborhoods)) {
        // If we already have HAVING for cuisines/neighborhoods, add types with AND
        const typeList = types.split(',').map(t => t.trim()).filter(t => t);
        if (typeList.length > 0) {
            const typeConditions = typeList.map(() => `GROUP_CONCAT(DISTINCT t.name) LIKE ?`).join(' OR ');
            query += ` AND (${typeConditions})`;
            typeList.forEach(type => params.push(`%${type}%`));
        }
    }
    
    // Tags filter
    if (tags && (cuisines || types || neighborhoods)) {
        // If we already have HAVING for cuisines/types/neighborhoods, add tags with AND
        const tagList = tags.split(',').map(t => t.trim()).filter(t => t);
        if (tagList.length > 0) {
            const tagConditions = tagList.map(() => `GROUP_CONCAT(DISTINCT tg.name) LIKE ?`).join(' OR ');
            query += ` AND (${tagConditions})`;
            tagList.forEach(tag => params.push(`%${tag}%`));
        }
    } else if (tags && !cuisines && !types && !neighborhoods) {
        // If no previous HAVING clause, start with tags
        const tagList = tags.split(',').map(t => t.trim()).filter(t => t);
        if (tagList.length > 0) {
            const tagConditions = tagList.map(() => `GROUP_CONCAT(DISTINCT tg.name) LIKE ?`).join(' OR ');
            query += ` HAVING (${tagConditions})`;
            tagList.forEach(tag => params.push(`%${tag}%`));
        }
    }
    
    // Add search for both basic and aggregated fields
    if (searchTerm) {
        const allSearchConditions = [
            // Basic fields
            `r.name LIKE ?`,
            `r.notes LIKE ?`,
            `r.what_to_order LIKE ?`,
            `r.borough LIKE ?`,
            // Aggregated fields
            `GROUP_CONCAT(DISTINCT c.name) LIKE ?`,
            `GROUP_CONCAT(DISTINCT t.name) LIKE ?`,
            `GROUP_CONCAT(DISTINCT n.name) LIKE ?`,
            `GROUP_CONCAT(DISTINCT tg.name) LIKE ?`
        ];
        
        // Check if we already have a HAVING clause
        const hasHavingClause = query.includes(' HAVING ');
        
        if (hasHavingClause) {
            // Add to existing HAVING with OR
            query += ` OR (${allSearchConditions.join(' OR ')})`;
        } else {
            // Add new HAVING clause
            query += ` HAVING (${allSearchConditions.join(' OR ')})`;
        }
        
        // Add search parameters for each field (8 total)
        for (let i = 0; i < 8; i++) {
            params.push(searchTerm);
        }
    }
    
    query += ` ORDER BY r.name LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    
    console.log('Final query:', query);
    console.log('Final params:', params);
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        
        // Parse the concatenated fields for each restaurant
        const restaurants = rows.map(row => ({
            ...row,
            liked: Boolean(row.liked),
            cuisines: row.cuisines ? row.cuisines.split(',') : [],
            types: row.types ? row.types.split(',') : [],
            neighborhoods: row.neighborhoods ? row.neighborhoods.split(',') : [],
            tags: row.tags ? row.tags.split(',').map(tag => {
                const [name, color] = tag.split(':');
                return { name, color: color || '#6B7280' };
            }) : []
        }));
        
        res.json(restaurants);
    });
});

// Get single restaurant by ID
app.get('/api/restaurants/:id', (req, res) => {
    const restaurantId = req.params.id;
    
    const query = `
        SELECT DISTINCT
            r.*,
            GROUP_CONCAT(DISTINCT c.name) as cuisines,
            GROUP_CONCAT(DISTINCT t.name) as types,
            GROUP_CONCAT(DISTINCT n.name) as neighborhoods,
            GROUP_CONCAT(DISTINCT tg.name || ':' || tg.color) as tags
        FROM restaurants r
        LEFT JOIN restaurant_cuisines rc ON r.id = rc.restaurant_id
        LEFT JOIN cuisines c ON rc.cuisine_id = c.id
        LEFT JOIN restaurant_types rt ON r.id = rt.restaurant_id
        LEFT JOIN types t ON rt.type_id = t.id
        LEFT JOIN restaurant_neighborhoods rn ON r.id = rn.restaurant_id
        LEFT JOIN neighborhoods n ON rn.neighborhood_id = n.id
        LEFT JOIN restaurant_tags rtag ON r.id = rtag.restaurant_id
        LEFT JOIN tags tg ON rtag.tag_id = tg.id
        WHERE r.id = ?
        GROUP BY r.id
    `;
    
    db.get(query, [restaurantId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }
        
        // Parse the concatenated fields
        const restaurant = {
            ...row,
            liked: Boolean(row.liked),
            cuisines: row.cuisines ? row.cuisines.split(',') : [],
            types: row.types ? row.types.split(',') : [],
            neighborhoods: row.neighborhoods ? row.neighborhoods.split(',') : [],
            tags: row.tags ? row.tags.split(',').map(tag => {
                const [name, color] = tag.split(':');
                return { name, color: color || '#6B7280' };
            }) : []
        };
        
        res.json(restaurant);
    });
});

// Update restaurant (expanded for full editing)
app.put('/api/restaurants/:id', (req, res) => {
    const restaurantId = req.params.id;
    const { 
        name, neighborhood, borough, status, liked, 
        happy_hour, happy_hour_start_time, happy_hour_end_time, happy_hour_data, has_happy_hour, notes, what_to_order, website_link,
        latitude, longitude, cuisines = [], types = [], neighborhoods = [], tags = []
    } = req.body;
    
    // Start a transaction to update restaurant and its relationships
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        // Update main restaurant data
        let updates = [];
        let params = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name.trim());
        }
        if (neighborhood !== undefined) {
            updates.push('neighborhood = ?');
            params.push(neighborhood);
        }
        if (borough !== undefined) {
            updates.push('borough = ?');
            params.push(borough);
        }
        if (status !== undefined) {
            updates.push('status = ?');
            params.push(status);
        }
        if (liked !== undefined) {
            updates.push('liked = ?');
            params.push(liked ? 1 : 0);
        }
        if (happy_hour !== undefined) {
            updates.push('happy_hour = ?');
            params.push(happy_hour);
        }
        if (happy_hour_start_time !== undefined) {
            updates.push('happy_hour_start_time = ?');
            params.push(happy_hour_start_time);
        }
        if (happy_hour_end_time !== undefined) {
            updates.push('happy_hour_end_time = ?');
            params.push(happy_hour_end_time);
        }
        if (happy_hour_data !== undefined) {
            updates.push('happy_hour_data = ?');
            params.push(typeof happy_hour_data === 'string' ? happy_hour_data : JSON.stringify(happy_hour_data));
        }
        if (has_happy_hour !== undefined) {
            updates.push('has_happy_hour = ?');
            params.push(has_happy_hour ? 1 : 0);
        }
        if (notes !== undefined) {
            updates.push('notes = ?');
            params.push(notes);
        }
        if (what_to_order !== undefined) {
            updates.push('what_to_order = ?');
            params.push(what_to_order);
        }
        if (website_link !== undefined) {
            updates.push('website_link = ?');
            params.push(website_link);
        }
        if (latitude !== undefined) {
            updates.push('latitude = ?');
            params.push(latitude);
        }
        if (longitude !== undefined) {
            updates.push('longitude = ?');
            params.push(longitude);
        }
        
        if (updates.length === 0 && cuisines.length === 0 && types.length === 0 && neighborhoods.length === 0 && tags.length === 0) {
            db.run('ROLLBACK');
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        
        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            params.push(restaurantId);
            
            const query = `UPDATE restaurants SET ${updates.join(', ')} WHERE id = ?`;
            
            db.run(query, params, function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                if (this.changes === 0) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Restaurant not found' });
                }
                
                // Continue with cuisines, types, neighborhoods, and tags updates...
                updateCuisinesTypesNeighborhoodsAndTags();
            });
        } else {
            updateCuisinesTypesNeighborhoodsAndTags();
        }
        
        function updateCuisinesTypesNeighborhoodsAndTags() {
            // Update cuisines if provided
            if (cuisines.length >= 0) {
                // Remove existing cuisine associations
                db.run('DELETE FROM restaurant_cuisines WHERE restaurant_id = ?', [restaurantId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Add new cuisine associations
                    if (cuisines.length > 0) {
                        const cuisineQueries = cuisines.map(cuisine => {
                            return new Promise((resolve, reject) => {
                                // First, ensure cuisine exists
                                db.run('INSERT OR IGNORE INTO cuisines (name) VALUES (?)', [cuisine.trim()], function() {
                                    // Then link it to restaurant
                                    db.run(`
                                        INSERT INTO restaurant_cuisines (restaurant_id, cuisine_id)
                                        SELECT ?, id FROM cuisines WHERE name = ?
                                    `, [restaurantId, cuisine.trim()], (err) => {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                                });
                            });
                        });
                        
                        Promise.all(cuisineQueries).then(() => {
                            updateTypes();
                        }).catch(err => {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        });
                    } else {
                        updateTypes();
                    }
                });
            } else {
                updateTypes();
            }
        }
        
        function updateTypes() {
            // Update types if provided
            if (types.length >= 0) {
                // Remove existing type associations
                db.run('DELETE FROM restaurant_types WHERE restaurant_id = ?', [restaurantId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Add new type associations
                    if (types.length > 0) {
                        const typeQueries = types.map(type => {
                            return new Promise((resolve, reject) => {
                                // First, ensure type exists
                                db.run('INSERT OR IGNORE INTO types (name) VALUES (?)', [type.trim()], function() {
                                    // Then link it to restaurant
                                    db.run(`
                                        INSERT INTO restaurant_types (restaurant_id, type_id)
                                        SELECT ?, id FROM types WHERE name = ?
                                    `, [restaurantId, type.trim()], (err) => {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                                });
                            });
                        });
                        
                        Promise.all(typeQueries).then(() => {
                            updateNeighborhoods();
                        }).catch(err => {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        });
                    } else {
                        updateNeighborhoods();
                    }
                });
            } else {
                updateNeighborhoods();
            }
        }
        
        function updateNeighborhoods() {
            // Update neighborhoods if provided
            if (neighborhoods.length >= 0) {
                // Remove existing neighborhood associations
                db.run('DELETE FROM restaurant_neighborhoods WHERE restaurant_id = ?', [restaurantId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Add new neighborhood associations
                    if (neighborhoods.length > 0) {
                        const neighborhoodQueries = neighborhoods.map(neighborhood => {
                            return new Promise((resolve, reject) => {
                                // First, ensure neighborhood exists
                                db.run('INSERT OR IGNORE INTO neighborhoods (name) VALUES (?)', [neighborhood.trim()], function() {
                                    // Then link it to restaurant
                                    db.run(`
                                        INSERT INTO restaurant_neighborhoods (restaurant_id, neighborhood_id)
                                        SELECT ?, id FROM neighborhoods WHERE name = ?
                                    `, [restaurantId, neighborhood.trim()], (err) => {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                                });
                            });
                        });
                        
                        Promise.all(neighborhoodQueries).then(() => {
                            updateTags();
                        }).catch(err => {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        });
                    } else {
                        updateTags();
                    }
                });
            } else {
                updateTags();
            }
        }
        
        function updateTags() {
            // Update tags if provided
            if (tags.length >= 0) {
                // Remove existing tag associations
                db.run('DELETE FROM restaurant_tags WHERE restaurant_id = ?', [restaurantId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Add new tag associations
                    if (tags.length > 0) {
                        const tagQueries = tags.map(tag => {
                            return new Promise((resolve, reject) => {
                                // First, ensure tag exists
                                db.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tag.trim()], function() {
                                    // Then link it to restaurant
                                    db.run(`
                                        INSERT INTO restaurant_tags (restaurant_id, tag_id)
                                        SELECT ?, id FROM tags WHERE name = ?
                                    `, [restaurantId, tag.trim()], (err) => {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                                });
                            });
                        });
                        
                        Promise.all(tagQueries).then(() => {
                            commitTransaction();
                        }).catch(err => {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        });
                    } else {
                        commitTransaction();
                    }
                });
            } else {
                commitTransaction();
            }
        }
        
        function commitTransaction() {
            db.run('COMMIT', (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: 'Restaurant updated successfully' });
            });
        }
    });
});

// Delete restaurant
app.delete('/api/restaurants/:id', (req, res) => {
    const restaurantId = req.params.id;
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        // Delete related records first
        db.run('DELETE FROM restaurant_cuisines WHERE restaurant_id = ?', [restaurantId]);
        db.run('DELETE FROM restaurant_types WHERE restaurant_id = ?', [restaurantId]);
        db.run('DELETE FROM restaurant_tags WHERE restaurant_id = ?', [restaurantId]);
        
        // Delete the restaurant
        db.run('DELETE FROM restaurants WHERE id = ?', [restaurantId], function(err) {
            if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                db.run('ROLLBACK');
                return res.status(404).json({ error: 'Restaurant not found' });
            }
            
            db.run('COMMIT', (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: 'Restaurant deleted successfully' });
            });
        });
    });
});

// Get all cuisines
app.get('/api/cuisines', (req, res) => {
    db.all('SELECT * FROM cuisines ORDER BY name', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Get all types
app.get('/api/types', (req, res) => {
    db.all('SELECT * FROM types ORDER BY name', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Get all tags
app.get('/api/tags', (req, res) => {
    db.all('SELECT * FROM tags ORDER BY name', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Get all neighborhoods
app.get('/api/neighborhoods', (req, res) => {
    db.all('SELECT * FROM neighborhoods ORDER BY name', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(row => row.name));
    });
});

// Get all boroughs
app.get('/api/boroughs', (req, res) => {
    db.all('SELECT DISTINCT borough FROM restaurants WHERE borough IS NOT NULL ORDER BY borough', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(row => row.borough));
    });
});

// Statistics endpoint
app.get('/api/stats', (req, res) => {
    const stats = {};
    
    const queries = [
        { key: 'total_restaurants', query: 'SELECT COUNT(*) as count FROM restaurants' },
        { key: 'visited_restaurants', query: 'SELECT COUNT(*) as count FROM restaurants WHERE status = "Visited"' },
        { key: 'liked_restaurants', query: 'SELECT COUNT(*) as count FROM restaurants WHERE liked = 1' },
        { key: 'total_cuisines', query: 'SELECT COUNT(*) as count FROM cuisines' },
        { key: 'total_types', query: 'SELECT COUNT(*) as count FROM types' },
        { key: 'total_tags', query: 'SELECT COUNT(*) as count FROM tags' }
    ];
    
    let completed = 0;
    
    queries.forEach(({ key, query }) => {
        db.get(query, [], (err, row) => {
            if (!err) {
                stats[key] = row.count;
            }
            
            completed++;
            if (completed === queries.length) {
                res.json(stats);
            }
        });
    });
});

// Add new restaurant
app.post('/api/restaurants', (req, res) => {
    const {
        name, neighborhood, borough, status = 'Unvisited', liked = false,
        happy_hour, happy_hour_start_time, happy_hour_end_time, happy_hour_data, has_happy_hour = false, notes, what_to_order, website_link,
        latitude, longitude, cuisines = [], types = [], neighborhoods = [], tags = []
    } = req.body;
    
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Restaurant name is required' });
    }
    
    // Start a transaction to handle restaurant and its relationships
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        // Insert restaurant
        const insertRestaurant = `
            INSERT INTO restaurants 
            (name, neighborhood, borough, status, liked, happy_hour, happy_hour_start_time, happy_hour_end_time, happy_hour_data, has_happy_hour, notes, 
             what_to_order, website_link, latitude, longitude)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        db.run(insertRestaurant, [
            name.trim(), neighborhood, borough, status, liked ? 1 : 0,
            happy_hour, happy_hour_start_time, happy_hour_end_time, 
            happy_hour_data ? (typeof happy_hour_data === 'string' ? happy_hour_data : JSON.stringify(happy_hour_data)) : null,
            has_happy_hour ? 1 : 0,
            notes, what_to_order, website_link, latitude, longitude
        ], function(err) {
            if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
            }
            
            const restaurantId = this.lastID;
            
            // Handle cuisines, types, neighborhoods, and tags
            handleRestaurantRelationships(restaurantId, cuisines, types, neighborhoods, tags, res);
        });
    });
    
    function handleRestaurantRelationships(restaurantId, cuisines, types, neighborhoods, tags, res) {
        // Handle cuisines
        const cuisinePromises = cuisines.map(cuisine => {
            return new Promise((resolve, reject) => {
                db.run('INSERT OR IGNORE INTO cuisines (name) VALUES (?)', [cuisine.trim()], function() {
                    db.run(`
                        INSERT INTO restaurant_cuisines (restaurant_id, cuisine_id)
                        SELECT ?, id FROM cuisines WHERE name = ?
                    `, [restaurantId, cuisine.trim()], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        });
        
        // Handle types
        const typePromises = types.map(type => {
            return new Promise((resolve, reject) => {
                db.run('INSERT OR IGNORE INTO types (name) VALUES (?)', [type.trim()], function() {
                    db.run(`
                        INSERT INTO restaurant_types (restaurant_id, type_id)
                        SELECT ?, id FROM types WHERE name = ?
                    `, [restaurantId, type.trim()], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        });
        
        // Handle neighborhoods
        const neighborhoodPromises = neighborhoods.map(neighborhood => {
            return new Promise((resolve, reject) => {
                db.run('INSERT OR IGNORE INTO neighborhoods (name) VALUES (?)', [neighborhood.trim()], function() {
                    db.run(`
                        INSERT INTO restaurant_neighborhoods (restaurant_id, neighborhood_id)
                        SELECT ?, id FROM neighborhoods WHERE name = ?
                    `, [restaurantId, neighborhood.trim()], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        });
        
        // Handle tags
        const tagPromises = tags.map(tag => {
            return new Promise((resolve, reject) => {
                db.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tag.trim()], function() {
                    db.run(`
                        INSERT INTO restaurant_tags (restaurant_id, tag_id)
                        SELECT ?, id FROM tags WHERE name = ?
                    `, [restaurantId, tag.trim()], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        });
        
        // Execute all promises
        Promise.all([...cuisinePromises, ...typePromises, ...neighborhoodPromises, ...tagPromises])
            .then(() => {
                db.run('COMMIT', (err) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    res.json({ id: restaurantId, message: 'Restaurant created successfully' });
                });
            })
            .catch(err => {
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
            });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});

// Get scratchpad content
app.get('/api/scratchpad', (req, res) => {
    db.get('SELECT content FROM scratchpad WHERE id = 1', (err, row) => {
        if (err) {
            console.error('Error getting scratchpad:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ content: row ? row.content : '' });
    });
});

// Update scratchpad content
app.post('/api/scratchpad', (req, res) => {
    const { content } = req.body;
    
    db.run(
        'INSERT OR REPLACE INTO scratchpad (id, content, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)',
        [content],
        function(err) {
            if (err) {
                console.error('Error updating scratchpad:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ success: true });
        }
    );
});

// Migration endpoint to move old neighborhood data to new structure
app.post('/api/migrate-neighborhoods', (req, res) => {
    console.log('Starting neighborhood migration...');
    
    // Get all restaurants with neighborhoods in the old column
    db.all('SELECT id, neighborhood FROM restaurants WHERE neighborhood IS NOT NULL AND neighborhood != ""', [], (err, restaurants) => {
        if (err) {
            console.error('Error fetching restaurants for migration:', err);
            return res.status(500).json({ error: err.message });
        }
        
        console.log(`Found ${restaurants.length} restaurants with neighborhoods to migrate`);
        
        if (restaurants.length === 0) {
            return res.json({ message: 'No neighborhoods to migrate' });
        }
        
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            
            let completed = 0;
            const errors = [];
            
            restaurants.forEach(restaurant => {
                const neighborhoods = restaurant.neighborhood.split(',').map(n => n.trim()).filter(n => n);
                
                neighborhoods.forEach(neighborhoodName => {
                    // First, ensure neighborhood exists in neighborhoods table
                    db.run('INSERT OR IGNORE INTO neighborhoods (name) VALUES (?)', [neighborhoodName], function(err) {
                        if (err) {
                            errors.push(`Error inserting neighborhood ${neighborhoodName}: ${err.message}`);
                        }
                        
                        // Then link it to restaurant
                        db.run(`
                            INSERT OR IGNORE INTO restaurant_neighborhoods (restaurant_id, neighborhood_id)
                            SELECT ?, id FROM neighborhoods WHERE name = ?
                        `, [restaurant.id, neighborhoodName], (err) => {
                            if (err) {
                                errors.push(`Error linking restaurant ${restaurant.id} to neighborhood ${neighborhoodName}: ${err.message}`);
                            }
                            
                            completed++;
                            
                            // Check if we've processed all neighborhood-restaurant combinations
                            const totalCombinations = restaurants.reduce((sum, r) => {
                                return sum + r.neighborhood.split(',').map(n => n.trim()).filter(n => n).length;
                            }, 0);
                            
                            if (completed === totalCombinations) {
                                if (errors.length > 0) {
                                    console.error('Migration completed with errors:', errors);
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: 'Migration failed', errors });
                                }
                                
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        console.error('Error committing migration:', err);
                                        return res.status(500).json({ error: err.message });
                                    }
                                    
                                    console.log(`Migration completed successfully. Processed ${restaurants.length} restaurants.`);
                                    res.json({ 
                                        message: 'Migration completed successfully',
                                        migratedRestaurants: restaurants.length,
                                        totalNeighborhoods: totalCombinations
                                    });
                                });
                            }
                        });
                    });
                });
            });
        });
    });
});

// Get list of images from /images folder for header
app.get('/api/images', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    const imagesDir = path.join(__dirname, 'images');
    
    fs.readdir(imagesDir, (err, files) => {
        if (err) {
            console.error('Error reading images directory:', err);
            return res.status(500).json({ error: 'Could not read images directory' });
        }
        
        // Filter for image files only
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
        });
        
        // Return full paths relative to web root
        const imagePaths = imageFiles.map(file => `images/${file}`);
        
        res.json(imagePaths);
    });
});

// Convert existing happy hour data to JSON format
app.post('/api/migrate-happy-hour-json', (req, res) => {
    console.log('Starting happy hour JSON migration...');
    
    // Get all restaurants with happy hour data
    db.all(`SELECT id, happy_hour, happy_hour_start_time, happy_hour_end_time FROM restaurants 
            WHERE happy_hour IS NOT NULL AND happy_hour != "" 
            AND (happy_hour_data IS NULL OR happy_hour_data = "")`, [], (err, restaurants) => {
        if (err) {
            console.error('Error fetching restaurants for migration:', err);
            return res.status(500).json({ error: err.message });
        }
        
        console.log(`Found ${restaurants.length} restaurants to migrate`);
        
        if (restaurants.length === 0) {
            return res.json({ message: 'No restaurants to migrate' });
        }
        
        let completed = 0;
        const errors = [];
        
        restaurants.forEach(restaurant => {
            // Parse existing happy hour data
            const happyHourData = parseExistingHappyHour(
                restaurant.happy_hour, 
                restaurant.happy_hour_start_time, 
                restaurant.happy_hour_end_time
            );
            
            // Update with JSON data
            db.run('UPDATE restaurants SET happy_hour_data = ? WHERE id = ?', 
                [JSON.stringify(happyHourData), restaurant.id], (err) => {
                if (err) {
                    errors.push(`Error updating restaurant ${restaurant.id}: ${err.message}`);
                }
                
                completed++;
                
                if (completed === restaurants.length) {
                    if (errors.length > 0) {
                        console.error('Migration completed with errors:', errors);
                        return res.status(500).json({ error: 'Migration failed', errors });
                    }
                    
                    console.log(`Migration completed successfully. Processed ${restaurants.length} restaurants.`);
                    res.json({ 
                        message: 'Migration completed successfully',
                        migratedRestaurants: restaurants.length
                    });
                }
            });
        });
    });
});

// Helper function to convert old format to new JSON structure
function parseExistingHappyHour(happyHourText, startTime, endTime) {
    const result = {
        schedules: []
    };
    
    if (!happyHourText) return result;
    
    // Simple day parsing (can be enhanced)
    const text = happyHourText.toLowerCase();
    let days = [];
    
    if (text.includes('monday') || text.includes('mon')) days.push('monday');
    if (text.includes('tuesday') || text.includes('tue')) days.push('tuesday');
    if (text.includes('wednesday') || text.includes('wed')) days.push('wednesday');
    if (text.includes('thursday') || text.includes('thu')) days.push('thursday');
    if (text.includes('friday') || text.includes('fri')) days.push('friday');
    if (text.includes('saturday') || text.includes('sat')) days.push('saturday');
    if (text.includes('sunday') || text.includes('sun')) days.push('sunday');
    
    // Handle common patterns
    if (text.includes('mon-fri') || text.includes('monday-friday') || text.includes('weekday')) {
        days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    }
    if (text.includes('weekend')) {
        days = ['saturday', 'sunday'];
    }
    if (text.includes('daily') || text.includes('every day')) {
        days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    }
    
    // If no days found, default to unknown
    if (days.length === 0) {
        days = ['unknown'];
    }
    
    // Create schedule entry
    const schedule = {
        days: days,
        startTime: startTime || null,
        endTime: endTime || null,
        offers: {
            drinks: [],
            food: [],
            notes: happyHourText
        }
    };
    
    result.schedules.push(schedule);
    return result;
}

// Graceful shutdown handling
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
    console.log(`📊 Connected to SQLite database`);
});
