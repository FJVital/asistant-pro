const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}));
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
const initDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                stripe_customer_id TEXT,
                subscription_status TEXT DEFAULT 'trial',
                subscription_id TEXT,
                trial_start_date TIMESTAMP DEFAULT NOW(),
                trial_extended INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
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
                created_at TIMESTAMP DEFAULT NOW(),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);
        
        console.log('✅ Connected to PostgreSQL database');
        console.log('✅ Database tables initialized');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
};

initDatabase();

console.log('Server running on port', PORT);
console.log('Environment:', process.env.NODE_ENV);

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
const checkTrialStatus = async (req, res, next) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        const user = result.rows[0];
        
        if (!user) {
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
    } catch (error) {
        console.error('Trial check error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// Routes
app.get('/', (req, res) => {
    res.json({ message: 'API is running' });
});

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;
        
        console.log('📝 Registration attempt for:', email);
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const customer = await stripe.customers.create({
            email: email,
            name: full_name,
            metadata: { source: 'asistant.pro' }
        });
        
        console.log('✅ Stripe customer created:', customer.id);
        
        const result = await pool.query(
            'INSERT INTO users (email, password_hash, full_name, stripe_customer_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [email, hashedPassword, full_name, customer.id]
        );
        
        const user = result.rows[0];
        console.log('✅ User created with ID:', user.id);
        
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        
        console.log('✅ Registration complete, token generated');
        
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
    } catch (error) {
        console.error('❌ Registration error:', error);
        if (error.constraint === 'users_email_key') {
            return res.status(400).json({ error: 'Email already registered' });
        }
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login - ENHANCED WITH DEBUG LOGGING
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('🔐 ========== LOGIN ATTEMPT ==========');
        console.log('📧 Email:', email);
        console.log('🔑 Password length:', password ? password.length : 0);
        console.log('⏰ Timestamp:', new Date().toISOString());
        
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (!user) {
            console.log('❌ User NOT FOUND in database for email:', email);
            
            // Check all users to see if it's a case sensitivity issue
            const allUsers = await pool.query('SELECT email FROM users');
            console.log('📊 All registered emails:', allUsers.rows.map(u => u.email).join(', '));
            
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        console.log('✅ User FOUND in database');
        console.log('👤 User ID:', user.id);
        console.log('📧 User Email:', user.email);
        console.log('👔 Full Name:', user.full_name);
        console.log('📅 Created At:', user.created_at);
        console.log('🔒 Password Hash (first 20 chars):', user.password_hash.substring(0, 20) + '...');
        
        console.log('🔑 Starting password comparison...');
        
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        console.log('🔑 Password comparison result:', validPassword);
        
        if (!validPassword) {
            console.log('❌ PASSWORD MISMATCH');
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        console.log('✅ Password is VALID');
        console.log('🎫 Generating JWT token...');
        
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        
        console.log('✅ Token generated successfully');
        console.log('📤 Sending response to client...');
        
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
        
        console.log('✅ LOGIN SUCCESSFUL for user:', user.email);
        console.log('🔐 ========== LOGIN COMPLETE ==========\n');
        
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user
app.get('/api/user', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        const user = result.rows[0];
        
        if (!user) {
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
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get transactions
app.get('/api/transactions', authenticateToken, checkTrialStatus, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
            [req.userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Get transactions error:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Create transaction
app.post('/api/transactions', authenticateToken, checkTrialStatus, async (req, res) => {
    try {
        const transaction = req.body;
        
        const result = await pool.query(
            `INSERT INTO transactions (user_id, property_address, client_name, client_email, transaction_type, 
             contract_date, closing_date, list_price, option_period_end, inspection_date, appraisal_date, 
             financing_deadline, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
            [req.userId, transaction.property_address, transaction.client_name, transaction.client_email,
             transaction.transaction_type, transaction.contract_date, transaction.closing_date, 
             transaction.list_price, transaction.option_period_end, transaction.inspection_date,
             transaction.appraisal_date, transaction.financing_deadline, transaction.notes]
        );
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Create transaction error:', error);
        res.status(500).json({ error: 'Failed to create transaction' });
    }
});

// Update transaction
app.put('/api/transactions/:id', authenticateToken, checkTrialStatus, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        const fields = Object.keys(updates).map((key, index) => `${key} = $${index + 1}`).join(', ');
        const values = [...Object.values(updates), req.userId, id];
        
        await pool.query(
            `UPDATE transactions SET ${fields} WHERE user_id = $${values.length - 1} AND id = $${values.length}`,
            values
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update transaction error:', error);
        res.status(500).json({ error: 'Update failed' });
    }
});

// Delete transaction
app.delete('/api/transactions/:id', authenticateToken, checkTrialStatus, async (req, res) => {
    try {
        const { id } = req.params;
        
        await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [id, req.userId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete transaction error:', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Create Stripe checkout session
app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        const user = result.rows[0];
        
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
app.post('/api/extend-trial', authenticateToken, async (req, res) => {
    try {
        await pool.query('UPDATE users SET trial_extended = 1 WHERE id = $1', [req.userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Extend trial error:', error);
        res.status(500).json({ error: 'Failed to extend trial' });
    }
});

// Stripe webhook
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.metadata.user_id;
            
            await pool.query(
                'UPDATE users SET subscription_status = $1, subscription_id = $2 WHERE id = $3',
                ['active', session.subscript
