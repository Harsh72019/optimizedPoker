const mongoHelper = require('../models/customdb');

class SetupFeeService {
  floorToCents(amount) {
    return Math.floor((Number(amount) + Number.EPSILON) * 100) / 100;
  }

  /**
   * Calculate setup fee according to specification formula
   * SetupFee = 0.05 + (a x BuyIn) + (b x DeclaredCapacity) + (c x Hours) - (d x SpeedBonus)
   */
  async calculateSetupFee(gameConfig) {
    const { buyIn, declaredCapacity, hours, timerSeconds } = gameConfig;

    const config = await this.getSetupFeeConfig();
    const { a, b, c, d } = config.setupFeeConstants;
    const speedBonus = config.speedBonus[timerSeconds] || 0;

    const baseFee = 0.05;
    const buyInComponent = a * buyIn;
    const capacityComponent = b * declaredCapacity;
    const durationComponent = c * hours;
    const speedDiscount = d * speedBonus;
    const fullPrecisionResult = baseFee + buyInComponent + capacityComponent + durationComponent - speedDiscount;

    const displayedAmount = this.floorToCents(fullPrecisionResult);
    const roundingResidue = fullPrecisionResult - displayedAmount;

    return {
      fullPrecisionResult,
      displayedAmount,
      roundingResidue,
      calculationDetails: {
        formula: '0.05 + (a x BuyIn) + (b x DeclaredCapacity) + (c x Hours) - (d x SpeedBonus)',
        constants: { a, b, c, d },
        speedBonus,
        terms: {
          baseFee,
          buyInComponent,
          capacityComponent,
          durationComponent,
          speedDiscount
        }
      }
    };
  }

  async chargeSetupFee(gameId, hostId, gameConfig, transactionData = {}) {
    const calculation = await this.calculateSetupFee(gameConfig);
    const {
      transactionId = null,
      blockchainTxHash = null,
      walletAddress = null,
      status = 'CHARGED',
      metadata = {}
    } = transactionData;

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
      transactionId,
      blockchainTxHash,
      walletAddress,
      metadata,
      status
    };

    const setupFeeResult = await mongoHelper.create(mongoHelper.COLLECTIONS.SETUP_FEE_LEDGER, setupFeeData);

    if (!setupFeeResult.success) {
      throw new Error(`Failed to create setup fee ledger: ${setupFeeResult.error}`);
    }

    if (calculation.roundingResidue > 0.001) {
      await this.addToRoundingPool(gameId, 'SETUP_FEE', calculation);
    }

    return {
      chargedAmount: calculation.displayedAmount,
      ledgerEntry: setupFeeResult.data,
      calculationSnapshot: calculation
    };
  }

  async updateSetupFeeCharge(ledgerId, updates = {}) {
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.SETUP_FEE_LEDGER,
      ledgerId,
      updates
    );

    if (!updateResult.success) {
      throw new Error(`Failed to update setup fee ledger: ${updateResult.error}`);
    }

    return updateResult.data;
  }

  async addToRoundingPool(gameId, source, calculation) {
    const roundingData = {
      gameId,
      source,
      originalAmount: calculation.fullPrecisionResult,
      displayedAmount: calculation.displayedAmount,
      roundingAmount: calculation.roundingResidue,
      description: 'Setup fee rounding residue',
      calculationDetails: calculation.calculationDetails
    };

    const roundingResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ROUNDING_POOL_LEDGER, roundingData);

    if (roundingResult.success) {
      return roundingResult.data;
    }

    console.error(`Failed to create rounding pool entry: ${roundingResult.error}`);
    return null;
  }

  async getSetupFeeConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SETUP_FEE');

    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }

    const legacyConfig = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SNG_SETUP_FEE');

    if (legacyConfig.success && legacyConfig.data) {
      return {
        setupFeeConstants: legacyConfig.data.config.constants,
        speedBonus: legacyConfig.data.config.speedBonusTable
      };
    }

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

    if (!createResult.success) {
      throw new Error(`Failed to create default setup fee config: ${createResult.error}`);
    }

    return createResult.data.config;
  }

  async previewSetupFee(gameConfig) {
    return this.calculateSetupFee(gameConfig);
  }

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

    return {
      refundedAmount: setupFeeEntry.chargedAmount,
      ledgerEntry: updateResult.data
    };
  }
}

module.exports = new SetupFeeService();
