const express = require('express');
const path = require('path');
const GmailSender = require('./gmail-sender');
const RealEstateAutomationService = require('./real-estate-automation');

const app = express();
const port = 3000;

// Initialize services
const automationService = new RealEstateAutomationService();
const gmailSender = new GmailSender();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Serve the main HTML interface (FIXED: now serves index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// NEW: API endpoint to send test reminder emails
app.post('/api/send-test-reminder', async (req, res) => {
  try {
    const { agentEmail } = req.body;
    
    if (!agentEmail) {
      return res.status(400).json({
        success: false,
        message: 'Agent email is required'
      });
    }

    // Create test reminder email content
    const testSubject = 'Test Reminder - Option Period Ending Soon';
    const testMessage = `Hi there!

This is a test reminder from your Real Estate Transaction Tracker at asistant.pro.

TEST TRANSACTION:
Property: 1234 Main St, Houston, TX 77002
Client: John & Mary Smith (Buyer)
Option Period Ends: ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString()}

In a real scenario, this reminder would alert you about upcoming deadlines to prevent missed dates that could cost thousands in commissions.

The system is working correctly and ready to help manage your real estate transactions!

Best regards,
asistant.pro Transaction Tracker

---
This is a test email. Your transaction tracker is fully operational.`;

    // Send test email using your existing Gmail sender
    const result = await gmailSender.sendGeneralEmail(
      agentEmail,
      testSubject,
      testMessage,
      'asistant.pro Transaction Tracker'
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Test reminder sent successfully',
        messageId: result.messageId
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send test email: ' + result.error
      });
    }

  } catch (error) {
    console.error('Send test reminder error:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending test reminder: ' + error.message
    });
  }
});

// API endpoint to add transaction
app.post('/api/add-transaction', async (req, res) => {
  try {
    console.log('Received transaction data:', req.body);
    
    const transactionData = {
      agent_email: req.body.agent_email || 'demo@agent.com',
      property_address: req.body.property_address,
      client_name: req.body.client_name,
      client_email: req.body.client_email || '',
      transaction_type: req.body.transaction_type,
      contract_date: req.body.contract_date,
      closing_date: req.body.closing_date,
      list_price: parseFloat(req.body.list_price) || 0
    };

    const result = await automationService.addTransaction(transactionData);
    
    res.json({
      success: true,
      message: 'Transaction added successfully!',
      transactionId: result.transactionId,
      deadlines: {
        optionPeriodEnd: result.optionPeriodEnd.toISOString().split('T')[0],
        inspectionDate: result.inspectionDate.toISOString().split('T')[0],
        appraisalDate: result.appraisalDate.toISOString().split('T')[0],
        financingDeadline: result.financingDeadline.toISOString().split('T')[0],
        closingDate: result.closingDate.toISOString().split('T')[0]
      }
    });
  } catch (error) {
    console.error('Add transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding transaction: ' + error.message
    });
  }
});

// API endpoint to get agent dashboard
app.get('/api/dashboard/:email', async (req, res) => {
  try {
    const agentEmail = req.params.email;
    const dashboard = await automationService.getAgentDashboard(agentEmail);
    
    res.json({
      success: true,
      transactions: dashboard
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Error loading dashboard: ' + error.message
    });
  }
});

// API endpoint to trigger reminders manually
app.post('/api/trigger-reminders', async (req, res) => {
  try {
    const results = await automationService.triggerReminders();
    
    res.json({
      success: true,
      message: `Reminders processed: ${results.sent} sent, ${results.errors} errors`,
      results: results
    });
  } catch (error) {
    console.error('Trigger reminders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error triggering reminders: ' + error.message
    });
  }
});

// API endpoint to get service status
app.get('/api/status', (req, res) => {
  const status = automationService.getStatus();
  res.json({
    success: true,
    status: status,
    timestamp: new Date().toISOString(),
    gmail_initialized: gmailSender.gmail !== null
  });
});

// Initialize Gmail and start server
async function startServer() {
  try {
    console.log('Initializing Gmail sender...');
    const gmailInitialized = await gmailSender.initialize();
    
    if (gmailInitialized) {
      console.log('✅ Gmail sender ready');
    } else {
      console.log('WARNING: Gmail sender not initialized - test emails will not work');
      console.log('   Run: node gmail-auth.js to set up Gmail authentication');
    }

    app.listen(port, async () => {
      console.log(`🏠 Real Estate Transaction Tracker running at http://localhost:${port}`);
      console.log('Starting automation service...');
      
      // Start the automation service
      await automationService.start();
      
      console.log('✅ System ready!');
      console.log(`
Available endpoints:
- http://localhost:${port}/ - Main interface (serves index.html)
- http://localhost:${port}/api/status - Service status
- http://localhost:${port}/api/send-test-reminder - Send test email
- http://localhost:${port}/api/trigger-reminders - Manual reminder trigger

PNG button images should now load correctly!
      `);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  automationService.stop();
  process.exit(0);
});

// Start the server
startServer();

module.exports = app;
