// src/services/cooldown.service.js

const mongoHelper = require('../models/customdb');

class CooldownService {
    async updateCooldownsOnSeat(tableId, tierId, participantIds) {
        // Placeholder for cooldown logic
        console.log(`📊 [Cooldown] Updating for ${participantIds.length} players`);
        // Add your cooldown update logic here
    }
}

module.exports = new CooldownService();
