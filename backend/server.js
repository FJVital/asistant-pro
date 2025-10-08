const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}));
app.use(express.json());

// Database setup
const db = new sqlite3.Database('./asistant.db');

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        stripe_customer_id TEXT,
        subscription_status TEXT DEFAULT 'trial',
        subscription_id TEXT,
        trial_start_date TEXT DEFAULT (datetime('now')),
        trial_extended INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
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
        option_period_end TEXT NOT NULL,
        inspection_date TEXT NOT NULL,
        appraisal_date TEXT NOT NULL,
        financing_deadline TEXT NOT NULL,
        notes TEXT,
        modified_deadlines TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
});

console.log('Server running on port', PORT);
console.log('Environment:', process.env.NODE_ENV);
console.log('Connected to SQLite database');
console.log('Database tables initialized');

// Auth middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.userId = user.id;
        next();
    });
};

// Check trial status
const checkTrialStatus = (req, res, next) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err || !user) {
            return res.status(500).json({ error: 'User not found' });
        }
        
        if (user.subscription_status === 'active') {
            return next();
        }
        
        const trialStart = new Date(user.trial_start_date);
        const now = new Date();
        const daysSinceStart = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
        const trialDays = user.trial_extended ? 22 : 15;
        
        if (daysSinceStart >= trialDays) {
            return res.status(403).json({ 
                error: 'Trial expired',
                trialExpired: true
            });
        }
        
        next();
    });
};

// Routes
app.get('/', (req, res) => {
    res.json({ message: 'API is running' });
});

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const customer = await stripe.customers.create({
            email: email,
            name: full_name,
            metadata: { source: 'asistant.pro' }
        });
        
        db.run(
            'INSERT INTO users (email, password_hash, full_name, stripe_customer_id) VALUES (?, ?, ?, ?)',
            [email, hashedPassword, full_name, customer.id],
            function(err) {
                if (err) {
                    console.error('Registration error:', err);
                    return res.status(400).json({ error: 'Email already registered' });
                }
                
                const token = jwt.sign({ id: this.lastID }, process.env.JWT_SECRET, { expiresIn: '30d' });
                
                res.json({
                    token,
                    user: {
                        id: this.lastID,
                        email,
                        full_name,
                        subscription_status: 'trial',
                        trial_start_date: new Date().toISOString(),
                        trial_extended: 0
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
        
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        
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
    db.get('SELECT * FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            subscription_status: user.subscription_status,
            trial_start_date: user.trial_start_date,
            trial_extended: user.trial_extended
        });
    });
});

// Get transactions
app.get('/api/transactions', authenticateToken, checkTrialStatus, (req, res) => {
    db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC', [req.userId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

// Create transaction
app.post('/api/transactions', authenticateToken, checkTrialStatus, (req, res) => {
    const transaction = req.body;
    
    db.run(
        `INSERT INTO transactions (user_id, property_address, client_name, client_email, transaction_type, 
         contract_date, closing_date, list_price, option_period_end, inspection_date, appraisal_date, 
         financing_deadline, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.userId, transaction.property_address, transaction.client_name, transaction.client_email,
         transaction.transaction_type, transaction.contract_date, transaction.closing_date, 
         transaction.list_price, transaction.option_period_end, transaction.inspection_date,
         transaction.appraisal_date, transaction.financing_deadline, transaction.notes],
        function(err) {
            if (err) {
                console.error('Error creating transaction:', err);
                return res.status(500).json({ error: 'Failed to create transaction' });
            }
            res.json({ id: this.lastID, ...transaction });
        }
    );
});

// Update transaction
app.put('/api/transactions/:id', authenticateToken, checkTrialStatus, (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    
    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), req.userId, id];
    
    db.run(
        `UPDATE transactions SET ${fields} WHERE user_id = ? AND id = ?`,
        values,
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Update failed' });
            }
            res.json({ success: true });
        }
    );
});

// Delete transaction
app.delete('/api/transactions/:id', authenticateToken, checkTrialStatus, (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM transactions WHERE id = ? AND user_id = ?', [id, req.userId], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Delete failed' });
        }
        res.json({ success: true });
    });
});

// Create Stripe checkout session
app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [req.userId], (err, row) => {
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
                user_id: user.id
            }
        });
        
        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Extend trial
app.post('/api/extend-trial', authenticateToken, (req, res) => {
    db.run('UPDATE users SET trial_extended = 1 WHERE id = ?', [req.userId], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to extend trial' });
        }
        res.json({ success: true });
    });
});

// Stripe webhook
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.metadata.user_id;
            
            db.run(
                'UPDATE users SET subscription_status = ?, subscription_id = ? WHERE id = ?',
                ['active', session.subscription, userId]
            );
        }
        
        res.json({received: true});
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
