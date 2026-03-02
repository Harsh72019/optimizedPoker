const { mailService } = require('../microservices');

async function sendWelcomeEmail(email, username) {
  // Assuming you have a mail service configured
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to Poker!</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          background-color: #f9f9f9;
          margin: 0;
          padding: 0;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          background-color: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }
        .header {
          text-align: center;
          padding: 20px 0;
          border-bottom: 1px solid #eaeaea;
        }
        .header img {
          max-width: 200px;
        }
        .content {
          padding: 30px 20px;
        }
        .footer {
          text-align: center;
          padding: 20px;
          font-size: 12px;
          color: #777;
          border-top: 1px solid #eaeaea;
        }
        .button {
          display: inline-block;
          padding: 12px 24px;
          background-color: #2c3e50;
          color: white !important;
          text-decoration: none;
          border-radius: 4px;
          font-weight: bold;
          margin: 20px 0;
        }
        h1 {
          color: #2c3e50;
        }
        .chips {
          font-size: 32px;
          margin: 10px 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="https://sdmntprsouthcentralus.oaiusercontent.com/files/00000000-7000-51f7-8c93-7cfb457a8d82/raw?se=2025-03-27T09%3A25%3A49Z&sp=r&sv=2024-08-04&sr=b&scid=f62e9ea5-7db1-5479-87ff-a6b28c0e5972&skoid=365eb242-95ba-4335-a618-2c9f8f766a86&sktid=a48cca56-e6da-484e-a814-9c849652bcb3&skt=2025-03-26T20%3A48%3A28Z&ske=2025-03-27T20%3A48%3A28Z&sks=b&skv=2024-08-04&sig=lL0OP/%2Bo7QIRvjaT/rQjmpq76T4BPjqcet2gLRrGuTM%3D" alt="Poker Logo">
        </div>
        <div class="content">
          <h1>Welcome to Poker, ${username}!</h1>
          <p>We're excited to have you join our poker community. Your account is now set up and ready to go!</p>
          
          <div class="chips">♠️ ♥️ ♦️ ♣️</div>
          
          <p>At our tables, you'll find:</p>
          <ul>
            <li>Fast-paced games with players from around the world</li>
            <li>Secure transactions and fair play guaranteed</li>
            <li>Regular tournaments with exciting prizes</li>
            <li>Detailed statistics to track your progress</li>
          </ul>
          
          <p>If you have any questions or need assistance, our support team is available 24/7.</p>
          
          <p>Good luck at the tables!</p>
          <p>The Poker Team</p>
        </div>
        <div class="footer">
          <p>© 2025 Poker. All rights reserved.</p>
          <p>If you didn't register for an account, please ignore this email.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Use your existing mail service
  await mailService.sendEmail({
    to: email,
    subject: 'Welcome to Poker!',
    html: emailHtml,
  });
}

module.exports = {
    sendWelcomeEmail
}