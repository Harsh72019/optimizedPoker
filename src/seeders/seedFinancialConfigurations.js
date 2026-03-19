const mongoHelper = require('../models/customdb');

/**
 * Default financial configurations
 */
const FINANCIAL_CONFIGS = [
  {
    configType: "RAKE_TIERS",
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
    }
  },

  {
    configType: "AFFILIATE_RATE",
    config: {
      affiliateRate: 30
    }
  },

  {
    configType: "HOST_CAPS",
    config: {
      hostCaps: {
        regular: 15,
        trusted: 25
      },
      hostUpliftCaps: {
        regular: 1.5,
        trusted: 2.5
      }
    }
  },

  {
    configType: "SETUP_FEE",
    config: {
      setupFeeConstants: {
        a: 0.005,
        b: 0.03,
        c: 0.1,
        d: 0.1
      },
      speedBonus: {
        30: 0,
        20: 1,
        15: 2,
        10: 3,
        5: 4
      }
    }
  },

  {
    configType: "TIMER_MULTIPLIERS",
    config: {
      timerMultipliers: {
        30: 1.0,
        20: 1.3,
        15: 1.6,
        10: 2.25,
        5: 4.0
      }
    }
  },

  {
    configType: "HANDS_PER_HOUR",
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
    }
  },

  {
    configType: "AVG_POT_MULTIPLIER",
    config: {
      avgPotMultiplier: 3
    }
  },

  {
    configType: "CASH_GAME_RAKE",
    config: {
      tiers: {
        tier1: 5.0,
        tier2: 4.5,
        tier3: 4.0,
        tier4: 3.5,
        tier5: 3.0
      },
      rakeCap: 5.0,
      minPotForRake: 1.0
    }
  },

  {
    configType: "OFFICIAL_TOURNAMENT_RAKE",
    config: {
      minRake: 5,
      maxRake: 8,
      defaultRake: 6,
      allowCustomRake: true
    }
  },

  {
    configType: "TRUSTED_HOST_CRITERIA",
    config: {
      criteria: {
        minGamesHosted: 10,
        minSuccessRate: 80,
        minAccountAgeDays: 30,
        minTotalPlayersServed: 50,
        minSetupFeesPaid: 100,
        requireVerification: true,
        minRating: 4.0,
        minGamesInLast30Days: 3
      },

      privileges: {
        maxHostUplift: 2.5,
        maxHostReward: 25,
        tier5Access: true,
        prioritySupport: true,
        customTableLimits: true
      }
    }
  }
];


/**
 * Seed Financial Configurations
 */
async function seedFinancialConfigurations() {
  console.log("🌱 Seeding financial configurations...");

  try {
    for (const configData of FINANCIAL_CONFIGS) {
      const existingResult = await mongoHelper.findOne(
        mongoHelper.COLLECTIONS.ADMIN_CONFIG,
        'configType',
        configData.configType
      );
      
      if (!existingResult.success || !existingResult.data) {
        const createResult = await mongoHelper.create(
          mongoHelper.COLLECTIONS.ADMIN_CONFIG,
          {
            configType: configData.configType,
            config: configData.config,
            version: 1
          }
        );
        
        if (createResult.success) {
          console.log(`✅ Created ${configData.configType} configuration`);
        } else {
          console.error(`❌ Failed to create ${configData.configType}: ${createResult.error}`);
        }
      } else {
        console.log(`⏭️  ${configData.configType} configuration already exists`);
      }
    }
    
    console.log('🎉 Financial configurations seeded successfully!');
    
  } catch (error) {
    console.error('❌ Error seeding financial configurations:', error);
    throw error;
  }
}


/**
 * Run directly
 */
if (require.main === module) {
  seedFinancialConfigurations()
    .then(() => {
      console.log("🎉 Seeder finished");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Seeder error:", err);
      process.exit(1);
    });
}


module.exports = seedFinancialConfigurations;