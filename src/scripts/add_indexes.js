const mongoose = require('mongoose');

async function addIndexes() {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      console.log('⚠️ Database not connected yet, skipping index creation');
      return;
    }

    await db.collection('tables').createIndex({ blockChainTableId: 1 });
    await db.collection('players').createIndex({ socketId: 1 });
    await db.collection('players').createIndex({ user: 1 });
    await db.collection('gamestates').createIndex({ tableId: 1 });
    
    console.log('✅ Database indexes created');
  } catch (error) {
    console.error('❌ Error creating indexes:', error.message);
  }
}

module.exports = { addIndexes };
