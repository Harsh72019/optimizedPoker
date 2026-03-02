const fetch = require('node-fetch'); // or global fetch if using Node 18+
const config = require('../config/config');
const FormData = require('form-data');

async function sendEmail(emailData) {
  const form = new FormData();
  form.append('from', config.EMAIL_FROM); // your verified domain email
  form.append('to', emailData.to);
  form.append('subject', emailData.subject);
  if (emailData.text) {
    form.append('plain', emailData.text || ''); // fallback in case plain is missing
  }
  if (emailData.html) {
    form.append('html', emailData.html);
  }

  try {
    const response = await fetch(config.MAILEROO_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': config.MAILEROO_API_KEY,
        ...form.getHeaders(),
      },
      body: form,
    });

    const result = await response.json();

    if (response.ok) {
      console.log('Email sent successfully:', result);
    } else {
      console.error('Failed to send email:', result);
    }
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

module.exports = {
  sendEmail,
};
