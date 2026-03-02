const mongoHelper = require('../models/customdb');

async function generateUniqueReferralCode() {
  let code;
  let isUnique = false;
  
  while (!isUnique) {
    code = generateRandomCode();
    const existingUser = await mongoHelper.findOne(
      mongoHelper.COLLECTIONS.USERS,
      'referralCode',
      code
    );
    isUnique = !existingUser.success || !existingUser.data;
  }
  
  return code;
}

function generateRandomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

module.exports = { generateUniqueReferralCode };
