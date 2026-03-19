const mongoHelper = require('../models/customdb');

class SetupFeeService {
  
  /**
   * Calculate setup fee according to specification formula
   * SetupFee = 0.05 * (a × BuyIn) * (b × DeclaredCapacity) * (c × Hours) - (d × SpeedBonus)
   */
  async calculateSetupFee(gameConfig) {
    const { buyIn, declaredCapacity, hours, timerSeconds } = gameConfig;
    
    // Get admin configuration
    const config = await this.getSetupFeeConfig();
    const { a, b, c, d } = config.setupFeeConstants;
    const speedBonus = config.speedBonus[timerSeconds] || 0;
    
    // Calculate with full precision
    const term1 = a * buyIn;
    const term2 = b * declaredCapacity;
    const term3 = c * hours;
    const term4 = d * speedBonus;
    
    const fullPrecisionResult = 0.05 * term1 * term2 * term3 - term4;
    
    // Floor to cents for display/charging
    const displayedAmount = Math.floor(fullPrecisionResult * 100) / 100;
    const roundingResidue = fullPrecisionResult - displayedAmount;
    
    return {
      fullPrecisionResult,
      displayedAmount,
      roundingResidue,
      calculationDetails: {
        formula: "0.05 * (a × BuyIn) * (b × DeclaredCapacity) * (c × Hours) - (d × SpeedBonus)",
        constants: { a, b, c, d },
        speedBonus,
        terms: { term1, term2, term3, term4 }
      }
    };
  }
  
  /**
   * Charge setup fee to host wallet and create ledger entry
   */
  async chargeSetupFee(gameId, hostId, gameConfig) {
    const calculation = await this.calculateSetupFee(gameConfig);
    
    // Create setup fee ledger entry
    const setupFeeData = {
      gameId,
      hostId,
      buyIn: gameConfig.buyIn,
      declaredCapacity: gameConfig.declaredCapacity,
      hours: gameConfig.hours,
      timerSeconds: gameConfig.timerSeconds,
      speedBonus: calculation.calculationDetails.speedBonus,
      constants: calculation.calculationDetails.constants,
      fullPrecisionAmount: calculation.fullPrecisionResult,
      chargedAmount: calculation.displayedAmount,
      roundingResidue: calculation.roundingResidue,
      status: 'CHARGED'
    };
    
    const setupFeeResult = await mongoHelper.create(mongoHelper.COLLECTIONS.SETUP_FEE_LEDGER, setupFeeData);
    
    if (!setupFeeResult.success) {
      throw new Error(`Failed to create setup fee ledger: ${setupFeeResult.error}`);
    }
    
    // Add rounding residue to rounding pool if significant
    if (calculation.roundingResidue > 0.001) {
      await this.addToRoundingPool(gameId, 'SETUP_FEE', calculation);
    }
    
    console.log(`💰 Setup fee ledger created: ${calculation.displayedAmount} for game ${gameId}`);
    
    return {
      chargedAmount: calculation.displayedAmount,
      ledgerEntry: setupFeeResult.data,
      calculationSnapshot: calculation
    };
  }
  
  /**
   * Add rounding residue to rounding pool ledger
   */
  async addToRoundingPool(gameId, source, calculation) {
    const roundingData = {
      gameId,
      source,
      originalAmount: calculation.fullPrecisionResult,
      displayedAmount: calculation.displayedAmount,
      roundingAmount: calculation.roundingResidue,
      description: `Setup fee rounding residue`,
      calculationDetails: calculation.calculationDetails
    };
    
    const roundingResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ROUNDING_POOL_LEDGER, roundingData);
    
    if (roundingResult.success) {
      console.log(`💰 Rounding pool entry created: ${calculation.roundingResidue}`);
      return roundingResult.data;
    } else {
      console.error(`❌ Failed to create rounding pool entry: ${roundingResult.error}`);
      return null;
    }
  }
  
  /**
   * Get setup fee configuration from admin settings
   */
  async getSetupFeeConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SETUP_FEE');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }
    
    // Create default configuration
    const defaultConfig = {
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
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config;
    } else {
      throw new Error(`Failed to create default setup fee config: ${createResult.error}`);
    }
  }
  
  /**
   * Preview setup fee calculation without charging
   */
  async previewSetupFee(gameConfig) {
    return await this.calculateSetupFee(gameConfig);
  }
  
  /**
   * Refund setup fee (if game is cancelled before threshold)
   */
  async refundSetupFee(gameId) {
    const setupFeeResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.SETUP_FEE_LEDGER, 'gameId', gameId);
    
    if (!setupFeeResult.success || !setupFeeResult.data) {
      throw new Error('No charged setup fee found for this game');
    }
    
    const setupFeeEntry = setupFeeResult.data;
    
    if (setupFeeEntry.status !== 'CHARGED') {
      throw new Error('Setup fee is not in charged status');
    }
    
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.SETUP_FEE_LEDGER,
      setupFeeEntry._id,
      { status: 'REFUNDED' }
    );
    
    if (!updateResult.success) {
      throw new Error(`Failed to update setup fee status: ${updateResult.error}`);
    }
    
    console.log(`💰 Setup fee refunded: ${setupFeeEntry.chargedAmount} for game ${gameId}`);
    
    return {
      refundedAmount: setupFeeEntry.chargedAmount,
      ledgerEntry: updateResult.data
    };
  }
}

module.exports = new SetupFeeService();