const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

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
    res.json({ status: 'ok', message: 'API server connected to SQLite' });
});

// Get all restaurants with filtering
app.get('/api/restaurants', (req, res) => {
    const { 
        search, 
        cuisines, 
        types, 
        neighborhoods, 
        boroughs, 
        status, 
        liked,
        limit = 100,
        offset = 0 
    } = req.query;
    
    let query = `
        SELECT DISTINCT
            r.*,
            GROUP_CONCAT(DISTINCT c.name) as cuisines,
            GROUP_CONCAT(DISTINCT t.name) as types,
            GROUP_CONCAT(DISTINCT tg.name || ':' || tg.color) as tags
        FROM restaurants r
        LEFT JOIN restaurant_cuisines rc ON r.id = rc.restaurant_id
        LEFT JOIN cuisines c ON rc.cuisine_id = c.id
        LEFT JOIN restaurant_types rt ON r.id = rt.restaurant_id
        LEFT JOIN types t ON rt.type_id = t.id
        LEFT JOIN restaurant_tags rtag ON r.id = rtag.restaurant_id
        LEFT JOIN tags tg ON rtag.tag_id = tg.id
        WHERE 1=1
    `;
    
    const params = [];
    
    // Search filter
    if (search) {
        query += ` AND (r.name LIKE ? OR r.notes LIKE ? OR r.what_to_order LIKE ?)`;
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
    }
    
    // Borough filter
    if (boroughs) {
        query += ` AND r.borough = ?`;
        params.push(boroughs);
    }
    
    // Neighborhood filter
    if (neighborhoods) {
        query += ` AND r.neighborhood LIKE ?`;
        params.push(`%${neighborhoods}%`);
    }
    
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
    
    // Type filter - using HAVING for aggregated data
    if (types && !cuisines) {
        // Only add HAVING if we didn't already add it for cuisines
        const typeList = types.split(',').map(t => t.trim()).filter(t => t);
        if (typeList.length > 0) {
            const typeConditions = typeList.map(() => `GROUP_CONCAT(DISTINCT t.name) LIKE ?`).join(' OR ');
            query += ` HAVING (${typeConditions})`;
            typeList.forEach(type => params.push(`%${type}%`));
        }
    } else if (types && cuisines) {
        // If we already have HAVING for cuisines, add types with AND
        const typeList = types.split(',').map(t => t.trim()).filter(t => t);
        if (typeList.length > 0) {
            const typeConditions = typeList.map(() => `GROUP_CONCAT(DISTINCT t.name) LIKE ?`).join(' OR ');
            query += ` AND (${typeConditions})`;
            typeList.forEach(type => params.push(`%${type}%`));
        }
    }
    
    query += ` ORDER BY r.name LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    
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
            GROUP_CONCAT(DISTINCT tg.name || ':' || tg.color) as tags
        FROM restaurants r
        LEFT JOIN restaurant_cuisines rc ON r.id = rc.restaurant_id
        LEFT JOIN cuisines c ON rc.cuisine_id = c.id
        LEFT JOIN restaurant_types rt ON r.id = rt.restaurant_id
        LEFT JOIN types t ON rt.type_id = t.id
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
        happy_hour, notes, what_to_order, website_link,
        latitude, longitude, cuisines = [], types = []
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
        
        if (updates.length === 0 && cuisines.length === 0 && types.length === 0) {
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
                
                // Continue with cuisines and types updates...
                updateCuisinesAndTypes();
            });
        } else {
            updateCuisinesAndTypes();
        }
        
        function updateCuisinesAndTypes() {
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
    db.all('SELECT DISTINCT neighborhood FROM restaurants WHERE neighborhood IS NOT NULL ORDER BY neighborhood', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(row => row.neighborhood));
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
        happy_hour, notes, what_to_order, website_link,
        latitude, longitude, cuisines = [], types = []
    } = req.body;
    
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Restaurant name is required' });
    }
    
    // Insert restaurant
    const insertRestaurant = `
        INSERT INTO restaurants 
        (name, neighborhood, borough, status, liked, happy_hour, notes, 
         what_to_order, website_link, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(insertRestaurant, [
        name.trim(), neighborhood, borough, status, liked ? 1 : 0,
        happy_hour, notes, what_to_order, website_link, latitude, longitude
    ], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json({ id: this.lastID, message: 'Restaurant created successfully' });
    });
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Restaurant API server running on http://localhost:${PORT}`);
    console.log(`📊 Connected to SQLite database with real data`);
});
