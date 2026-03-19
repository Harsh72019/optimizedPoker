const mongoose = require('mongoose');
const { AdminConfig } = require('../models');
const config = require('../config/config');

// Connect to MongoDB
mongoose.connect(config.mongoose.url, config.mongoose.options);

const seedFinancialConfigs = async () => {
  try {
    console.log('🌱 Seeding financial configurations...');
    
    // Tournament Rake Tiers
    const tournamentTiers = await AdminConfig.findOneAndUpdate(
      { configType: 'RAKE_TIERS' },
      {
        configType: 'RAKE_TIERS',
        config: {
          tournamentTiers: {
            tier1: 11,
            tier2: 9,
            tier3: 7,
            tier4: 5,
            tier5: 3
          },
          sngTiers: {
            tier1: 5.0,
            tier2: 4.5,
            tier3: 3.5,
            tier4: 2.5,
            tier5: 2.0
          },
          officialTournament: {
            minRake: 5,
            maxRake: 8
          }
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Tournament rake tiers configured');
    
    // Affiliate Rate
    const affiliateRate = await AdminConfig.findOneAndUpdate(
      { configType: 'AFFILIATE_RATE' },
      {
        configType: 'AFFILIATE_RATE',
        config: {
          affiliateRate: 30
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Affiliate rate configured');
    
    // Host Caps
    const hostCaps = await AdminConfig.findOneAndUpdate(
      { configType: 'HOST_CAPS' },
      {
        configType: 'HOST_CAPS',
        config: {
          hostCaps: {
            regular: 15,
            trusted: 25
          },
          hostUpliftCaps: {
            regular: 1.5,
            trusted: 2.5
          }
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Host caps configured');
    
    // Setup Fee Constants
    const setupFee = await AdminConfig.findOneAndUpdate(
      { configType: 'SETUP_FEE' },
      {
        configType: 'SETUP_FEE',
        config: {
          setupFeeConstants: {
            a: 0.005,
            b: 0.03,
            c: 0.10,
            d: 0.10
          },
          speedBonus: {
            30: 0,
            20: 1,
            15: 2,
            10: 3,
            5: 4
          }
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Setup fee constants configured');
    
    // Timer Multipliers
    const timerMultipliers = await AdminConfig.findOneAndUpdate(
      { configType: 'TIMER_MULTIPLIERS' },
      {
        configType: 'TIMER_MULTIPLIERS',
        config: {
          timerMultipliers: {
            30: 1.00,
            20: 1.30,
            15: 1.60,
            10: 2.25,
            5: 4.00
          }
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Timer multipliers configured');
    
    // Hands Per Hour
    const handsPerHour = await AdminConfig.findOneAndUpdate(
      { configType: 'HANDS_PER_HOUR' },
      {
        configType: 'HANDS_PER_HOUR',
        config: {
          handsPerHour: {
            3: 90,
            4: 85,
            5: 82,
            6: 80,
            7: 75,
            8: 72,
            9: 70
          }
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Hands per hour configured');
    
    // Average Pot Multiplier
    const avgPotMultiplier = await AdminConfig.findOneAndUpdate(
      { configType: 'AVG_POT_MULTIPLIER' },
      {
        configType: 'AVG_POT_MULTIPLIER',
        config: {
          avgPotMultiplier: 3
        },
        version: 1
      },
      { upsert: true, new: true }
    );
    console.log('✅ Average pot multiplier configured');
    
    console.log('🎉 Financial configuration seeding completed successfully!');
    
    // Display summary
    console.log('\n📊 Configuration Summary:');
    console.log('Tournament Tiers: 11%, 9%, 7%, 5%, 3%');
    console.log('SNG Tiers: 5.0%, 4.5%, 3.5%, 2.5%, 2.0%');
    console.log('Affiliate Rate: 30%');
    console.log('Host Caps: Regular 15%, Trusted 25%');
    console.log('Host Uplift Caps: Regular 1.5%, Trusted 2.5%');
    console.log('Setup Fee Formula: 0.05 * (a × BuyIn) * (b × Capacity) * (c × Hours) - (d × SpeedBonus)');
    
  } catch (error) {
    console.error('❌ Error seeding financial configurations:', error);
  } finally {
    mongoose.connection.close();
  }
};

// Run seeder
if (require.main === module) {
  seedFinancialConfigs();
}

module.exports = seedFinancialConfigs;