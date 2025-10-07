const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.raw({ type: 'application/json' }));

// Database setup
const db = new sqlite3.Database('./asistant.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        stripe_customer_id TEXT,
        subscription_status TEXT DEFAULT 'trial',
        subscription_id TEXT,
        trial_start_date TEXT,
        trial_extended INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        property_address TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_email TEXT,
        transaction_type TEXT NOT NULL,
        contract_date TEXT NOT NULL,
        closing_date TEXT NOT NULL,
        list_price REAL,
        option_period_end TEXT,
        inspection_date TEXT,
        appraisal_date TEXT,
        financing_deadline TEXT,
        notes TEXT,
        modified_deadlines TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    console.log('Database tables initialized');
}

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// Check subscription status
function checkSubscription(req, res, next) {
    const userId = req.user.userId;

    db.get('SELECT subscription_status, trial_start_date, trial_extended FROM users WHERE id = ?', 
        [userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Calculate trial days remaining
        const trialStart = new Date(user.trial_start_date);
        const now = new Date();
        const daysSinceStart = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
        const trialDays = user.trial_extended ? 22 : 15; // 15 days + 7 if extended
        const trialExpired = daysSinceStart >= trialDays;

        if (user.subscription_status === 'active' || !trialExpired) {
            next();
        } else {
            res.status(403).json({ error: 'Subscription expired', trialExpired: true });
        }
    });
}

// ==================== AUTH ENDPOINTS ====================

// Register new user
app.post('/api/register', async (req, res) => {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const trialStartDate = new Date().toISOString();

        // Create Stripe customer
        const customer = await stripe.customers.create({
            email: email,
            name: full_name,
            metadata: { app: 'asistant_pro' }
        });

        db.run(
            `INSERT INTO users (email, password_hash, full_name, stripe_customer_id, trial_start_date) 
             VALUES (?, ?, ?, ?, ?)`,
            [email, passwordHash, full_name, customer.id, trialStartDate],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(400).json({ error: 'Email already registered' });
                    }
                    return res.status(500).json({ error: 'Registration failed' });
                }

                const token = jwt.sign({ userId: this.lastID, email }, JWT_SECRET, { expiresIn: '30d' });

                res.json({
                    token,
                    user: {
                        id: this.lastID,
                        email,
                        full_name,
                        subscription_status: 'trial',
                        trial_start_date: trialStartDate
                    }
                });
            }
        );
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                subscription_status: user.subscription_status,
                trial_start_date: user.trial_start_date,
                trial_extended: user.trial_extended
            }
        });
    });
});

// Get current user
app.get('/api/user', authenticateToken, (req, res) => {
    db.get('SELECT id, email, full_name, subscription_status, trial_start_date, trial_extended FROM users WHERE id = ?', 
        [req.user.userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    });
});

// ==================== STRIPE ENDPOINTS ====================

// Create checkout session
app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT stripe_customer_id, email FROM users WHERE id = ?', 
                [req.user.userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        const session = await stripe.checkout.sessions.create({
            customer: user.stripe_customer_id,
            payment_method_types: ['card'],
            line_items: [{
                price: process.env.STRIPE_PRICE_ID,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/cancel.html`,
            metadata: {
                user_id: req.user.userId.toString()
            }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Stripe webhook handler
app.post('/api/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            const userId = session.metadata.user_id;
            
            db.run(
                `UPDATE users SET subscription_status = 'active', subscription_id = ? WHERE id = ?`,
                [session.subscription, userId]
            );
            break;

        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
            const subscription = event.data.object;
            const status = subscription.status === 'active' ? 'active' : 'inactive';
            
            db.run(
                `UPDATE users SET subscription_status = ? WHERE subscription_id = ?`,
                [status, subscription.id]
            );
            break;
    }

    res.json({ received: true });
});

// Extend trial (after survey)
app.post('/api/extend-trial', authenticateToken, (req, res) => {
    db.run(
        'UPDATE users SET trial_extended = 1 WHERE id = ?',
        [req.user.userId],
        (err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to extend trial' });
            }
            res.json({ success: true, message: 'Trial extended by 7 days' });
        }
    );
});

// ==================== TRANSACTION ENDPOINTS ====================

// Get all transactions for user
app.get('/api/transactions', authenticateToken, checkSubscription, (req, res) => {
    db.all(
        'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC',
        [req.user.userId],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch transactions' });
            }
            
            // Parse JSON fields
            const transactions = rows.map(row => ({
                ...row,
                modified_deadlines: row.modified_deadlines ? JSON.parse(row.modified_deadlines) : {}
            }));
            
            res.json(transactions);
        }
    );
});

// Create transaction
app.post('/api/transactions', authenticateToken, checkSubscription, (req, res) => {
    const {
        property_address, client_name, client_email, transaction_type,
        contract_date, closing_date, list_price, option_period_end,
        inspection_date, appraisal_date, financing_deadline, notes
    } = req.body;

    db.run(
        `INSERT INTO transactions (
            user_id, property_address, client_name, client_email, transaction_type,
            contract_date, closing_date, list_price, option_period_end,
            inspection_date, appraisal_date, financing_deadline, notes, modified_deadlines
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            req.user.userId, property_address, client_name, client_email, transaction_type,
            contract_date, closing_date, list_price || 0, option_period_end,
            inspection_date, appraisal_date, financing_deadline, notes || '', '{}'
        ],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to create transaction' });
            }
            res.json({ id: this.lastID, success: true });
        }
    );
});

// Update transaction
app.put('/api/transactions/:id', authenticateToken, checkSubscription, (req, res) => {
    const { id } = req.params;
    const updateFields = req.body;
    
    // Build dynamic update query
    const fields = Object.keys(updateFields);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const values = fields.map(field => {
        if (field === 'modified_deadlines') {
            return JSON.stringify(updateFields[field]);
        }
        return updateFields[field];
    });
    
    db.run(
        `UPDATE transactions SET ${setClause} WHERE id = ? AND user_id = ?`,
        [...values, id, req.user.userId],
        (err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to update transaction' });
            }
            res.json({ success: true });
        }
    );
});

// Delete transaction
app.delete('/api/transactions/:id', authenticateToken, checkSubscription, (req, res) => {
    const { id } = req.params;
    
    db.run(
        'DELETE FROM transactions WHERE id = ? AND user_id = ?',
        [id, req.user.userId],
        (err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to delete transaction' });
            }
            res.json({ success: true });
        }
    );
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
});
