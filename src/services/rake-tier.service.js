const mongoHelper = require('../models/customdb');

class RakeTierService {
  
  /**
   * Get tournament rake percentage by tier
   */
  async getTournamentRake(tier) {
    const config = await this.getTournamentTierConfig();
    
    const tierMap = {
      1: config.tournamentTiers.tier1,
      2: config.tournamentTiers.tier2,
      3: config.tournamentTiers.tier3,
      4: config.tournamentTiers.tier4,
      5: config.tournamentTiers.tier5
    };
    
    if (!tierMap[tier]) {
      throw new Error(`Invalid tournament tier: ${tier}`);
    }
    
    return tierMap[tier];
  }
  
  /**
   * Get SNG rake percentage by tier
   */
  async getSNGRake(tier) {
    const config = await this.getSNGTierConfig();
    
    const tierMap = {
      1: config.sngTiers.tier1,
      2: config.sngTiers.tier2,
      3: config.sngTiers.tier3,
      4: config.sngTiers.tier4,
      5: config.sngTiers.tier5
    };
    
    if (!tierMap[tier]) {
      throw new Error(`Invalid SNG tier: ${tier}`);
    }
    
    return tierMap[tier];
  }
  
  /**
   * Get official tournament rake range
   */
  async getOfficialTournamentRakeRange() {
    const config = await this.getOfficialTournamentConfig();
    return {
      minRake: config.officialTournament.minRake,
      maxRake: config.officialTournament.maxRake
    };
  }
  
  /**
   * Validate host uplift for SNG
   */
  async validateHostUplift(hostId, upliftPercent) {
    const hostType = await this.getHostType(hostId);
    const caps = await this.getHostUpliftCaps();
    
    const maxUplift = caps[hostType];
    
    if (upliftPercent > maxUplift) {
      throw new Error(`Host uplift ${upliftPercent}% exceeds maximum allowed ${maxUplift}% for ${hostType} host`);
    }
    
    return true;
  }
  
  /**
   * Calculate effective rake (base tier + host uplift)
   */
  async calculateEffectiveRake(tier, hostUplift, gameType) {
    let baseTierRake;
    
    if (gameType === 'PRIVATE_SNG') {
      baseTierRake = await this.getSNGRake(tier);
    } else {
      baseTierRake = await this.getTournamentRake(tier);
    }
    
    return baseTierRake + (hostUplift || 0);
  }
  
  /**
   * Get all available tiers for display
   */
  async getAllTiers() {
    const tournamentConfig = await this.getTournamentTierConfig();
    const sngConfig = await this.getSNGTierConfig();
    
    return {
      tournament: {
        tier1: tournamentConfig.tournamentTiers.tier1,
        tier2: tournamentConfig.tournamentTiers.tier2,
        tier3: tournamentConfig.tournamentTiers.tier3,
        tier4: tournamentConfig.tournamentTiers.tier4,
        tier5: tournamentConfig.tournamentTiers.tier5
      },
      sng: {
        tier1: sngConfig.sngTiers.tier1,
        tier2: sngConfig.sngTiers.tier2,
        tier3: sngConfig.sngTiers.tier3,
        tier4: sngConfig.sngTiers.tier4,
        tier5: sngConfig.sngTiers.tier5
      }
    };
  }
  
  /**
   * Get tournament tier configuration
   */
  async getTournamentTierConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'RAKE_TIERS');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }
    
    const defaultConfig = {
      configType: 'RAKE_TIERS',
      config: {
        tournamentTiers: {
          tier1: 11,
          tier2: 9,
          tier3: 7,
          tier4: 5,
          tier5: 3
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config;
    } else {
      throw new Error(`Failed to create tournament tier config: ${createResult.error}`);
    }
  }
  
  /**
   * Get SNG tier configuration
   */
  async getSNGTierConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'RAKE_TIERS');
    
    if (configResult.success && configResult.data && configResult.data.config.sngTiers) {
      return configResult.data.config;
    }
    
    // Update existing config or create new one
    let updateData = {
      sngTiers: {
        tier1: 5.0,
        tier2: 4.5,
        tier3: 3.5,
        tier4: 2.5,
        tier5: 2.0
      }
    };
    
    if (configResult.success && configResult.data) {
      // Update existing config
      const updatedConfig = {
        ...configResult.data.config,
        ...updateData
      };
      
      const updateResult = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.ADMIN_CONFIG,
        configResult.data._id,
        { config: updatedConfig }
      );
      
      if (updateResult.success) {
        return updateResult.data.config;
      } else {
        throw new Error(`Failed to update SNG tier config: ${updateResult.error}`);
      }
    } else {
      // Create new config
      const defaultConfig = {
        configType: 'RAKE_TIERS',
        config: updateData
      };
      
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
      
      if (createResult.success) {
        return createResult.data.config;
      } else {
        throw new Error(`Failed to create SNG tier config: ${createResult.error}`);
      }
    }
  }
  
  /**
   * Get official tournament configuration
   */
  async getOfficialTournamentConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'RAKE_TIERS');
    
    if (configResult.success && configResult.data && configResult.data.config.officialTournament) {
      return configResult.data.config;
    }
    
    // Update existing config or create new one
    let updateData = {
      officialTournament: {
        minRake: 5,
        maxRake: 8
      }
    };
    
    if (configResult.success && configResult.data) {
      // Update existing config
      const updatedConfig = {
        ...configResult.data.config,
        ...updateData
      };
      
      const updateResult = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.ADMIN_CONFIG,
        configResult.data._id,
        { config: updatedConfig }
      );
      
      if (updateResult.success) {
        return updateResult.data.config;
      } else {
        throw new Error(`Failed to update official tournament config: ${updateResult.error}`);
      }
    } else {
      // Create new config
      const defaultConfig = {
        configType: 'RAKE_TIERS',
        config: updateData
      };
      
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
      
      if (createResult.success) {
        return createResult.data.config;
      } else {
        throw new Error(`Failed to create official tournament config: ${createResult.error}`);
      }
    }
  }
  
  /**
   * Get host uplift caps
   */
  async getHostUpliftCaps() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'HOST_CAPS');
    
    if (configResult.success && configResult.data && configResult.data.config.hostUpliftCaps) {
      return configResult.data.config.hostUpliftCaps;
    }
    
    const defaultConfig = {
      configType: 'HOST_CAPS',
      config: {
        hostUpliftCaps: {
          regular: 1.5,
          trusted: 2.5
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.hostUpliftCaps;
    } else {
      throw new Error(`Failed to create host uplift caps config: ${createResult.error}`);
    }
  }
  
  /**
   * Determine host type (regular or trusted)
   */
  async getHostType(hostId) {
    // TODO: Implement logic to check if host is trusted
    // This could be based on:
    // - Number of successful games hosted
    // - Player feedback/ratings
    // - Platform verification status
    // - Manual admin approval
    
    // For now, return 'regular' as default
    return 'regular';
  }
  
  /**
   * Update tier configuration (admin only)
   */
  async updateTierConfiguration(tierType, newConfig, adminId) {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'RAKE_TIERS');
    
    let config;
    if (configResult.success && configResult.data) {
      config = configResult.data;
    } else {
      // Create new config if doesn't exist
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
        configType: 'RAKE_TIERS',
        config: {}
      });
      
      if (!createResult.success) {
        throw new Error(`Failed to create rake tiers config: ${createResult.error}`);
      }
      
      config = createResult.data;
    }
    
    // Update the specific tier type
    const updatedConfig = { ...config.config };
    
    if (tierType === 'tournament') {
      updatedConfig.tournamentTiers = newConfig;
    } else if (tierType === 'sng') {
      updatedConfig.sngTiers = newConfig;
    } else if (tierType === 'official') {
      updatedConfig.officialTournament = newConfig;
    } else {
      throw new Error(`Invalid tier type: ${tierType}`);
    }
    
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.ADMIN_CONFIG,
      config._id,
      {
        config: updatedConfig,
        lastUpdatedBy: adminId,
        version: (config.version || 0) + 1
      }
    );
    
    if (!updateResult.success) {
      throw new Error(`Failed to update tier configuration: ${updateResult.error}`);
    }
    
    console.log(`⚙️ Tier configuration updated: ${tierType} by admin ${adminId}`);
    
    return updateResult.data;
  }
}

module.exports = new RakeTierService();