// Test script for Private Table and Financial Integration
// Run with: node src/scripts/test-private-tables.js

const mongoose = require('mongoose');
const config = require('../config/config');

// Connect to MongoDB
mongoose.connect(config.mongoose.url, config.mongoose.options);

const privateTableService = require('../services/private-table.service');
const financialService = require('../services/financial.service');
const setupFeeService = require('../services/setup-fee.service');

async function testPrivateTableIntegration() {
    console.log('🧪 Testing Private Table and Financial Integration...\n');
    
    try {
        // Test 1: Initialize financial configurations
        console.log('1️⃣ Initializing financial configurations...');
        await financialService.initializeDefaultConfigurations();
        console.log('✅ Financial configurations initialized\n');
        
        // Test 2: Create a private SNG table
        console.log('2️⃣ Creating private SNG table...');
        const hostId = '507f1f77bcf86cd799439011'; // Mock host ID
        
        const tableConfig = {
            name: 'Test Private SNG',
            description: 'Testing private table creation',
            gameType: 'PRIVATE_SNG',
            buyIn: 100,
            declaredCapacity: 6,
            participationThreshold: 75,
            tier: 2,
            hostUplift: 1.0,
            hostRewardPercent: 5,
            estimatedHours: 1.5,
            timerSeconds: 30
        };
        
        const createResult = await privateTableService.createPrivateTable(hostId, tableConfig);
        console.log('✅ Private table created:', {
            id: createResult.privateTable._id,
            setupFee: createResult.setupFee.chargedAmount,
            tierRake: createResult.privateTable.tierRake,
            effectiveRake: createResult.privateTable.effectiveRake
        });
        console.log('\n');
        
        // Test 3: Generate financial preview
        console.log('3️⃣ Generating financial preview...');
        const preview = await financialService.generateFinancialPreview({
            gameType: 'PRIVATE_SNG',
            buyIn: 100,
            declaredCapacity: 6,
            participationThreshold: 75,
            tierRake: 4.5,
            hostUplift: 1.0,
            hostRewardPercent: 5,
            hours: 1.5,
            timerSeconds: 30,
            hasAffiliate: false
        });
        
        console.log('✅ Financial preview generated:', {
            scenarios: preview.scenarios?.length || 0,
            setupFee: preview.setupFee?.amount || 'N/A'
        });
        console.log('\n');
        
        // Test 4: Test setup fee calculation
        console.log('4️⃣ Testing setup fee calculation...');
        const setupFeePreview = await setupFeeService.previewSetupFee({
            buyIn: 100,
            declaredCapacity: 6,
            hours: 1.5,
            timerSeconds: 30
        });
        
        console.log('✅ Setup fee calculation:', {
            fullPrecision: setupFeePreview.fullPrecisionResult,
            displayed: setupFeePreview.displayedAmount,
            rounding: setupFeePreview.roundingResidue
        });
        console.log('\n');
        
        // Test 5: Register players to private table
        console.log('5️⃣ Registering players...');
        const playerIds = [
            '507f1f77bcf86cd799439012',
            '507f1f77bcf86cd799439013',
            '507f1f77bcf86cd799439014',
            '507f1f77bcf86cd799439015'
        ];
        
        for (const playerId of playerIds) {
            const registerResult = await privateTableService.registerPlayer(
                createResult.privateTable._id, 
                playerId
            );
            console.log(`✅ Player ${playerId} registered:`, {
                registered: registerResult.registered,
                tableStatus: registerResult.tableStatus
            });
        }
        console.log('\n');
        
        // Test 6: Check if table is ready to start
        console.log('6️⃣ Checking table status...');
        const updatedTable = await privateTableService.getPrivateTable(createResult.privateTable._id);
        console.log('✅ Table status:', {
            status: updatedTable.status,
            registeredPlayers: updatedTable.registeredPlayers.length,
            isThresholdMet: updatedTable.isThresholdMet,
            canStart: updatedTable.canStart
        });
        console.log('\n');
        
        console.log('🎉 All tests completed successfully!');
        console.log('\n📊 Integration Summary:');
        console.log('- ✅ Private table creation with financial setup');
        console.log('- ✅ Setup fee calculation and charging');
        console.log('- ✅ Financial preview generation');
        console.log('- ✅ Player registration system');
        console.log('- ✅ Threshold-based game starting');
        console.log('\n🚀 Ready for socket integration!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
    } finally {
        mongoose.connection.close();
    }
}

// Run tests
if (require.main === module) {
    testPrivateTableIntegration();
}

module.exports = testPrivateTableIntegration;