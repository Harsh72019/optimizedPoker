// src/utils/private-table-validator.js

class PrivateTableValidator {
  
  /**
   * Validate private table configuration
   */
  static validateTableConfig(tableConfig) {
    const errors = [];
    
    // Required fields validation
    const requiredFields = ['name', 'gameType', 'stakes', 'turnTimer', 'playerCapacity', 'tableDuration', 'buyInSettings', 'invitationControl'];
    
    for (const field of requiredFields) {
      if (!tableConfig[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    // Game type validation
    if (!['SNG', 'TOURNAMENT'].includes(tableConfig.gameType)) {
      errors.push('Game type must be either SNG or TOURNAMENT');
    }
    
    // Stakes validation
    if (tableConfig.stakes) {
      const validStakeTypes = ['FIXED_LIMIT', 'POT_LIMIT', 'NO_LIMIT', 'CUSTOM'];
      if (!validStakeTypes.includes(tableConfig.stakes.type)) {
        errors.push('Invalid stakes type. Must be one of: ' + validStakeTypes.join(', '));
      }
      
      if (tableConfig.stakes.type === 'CUSTOM' && !tableConfig.stakes.blinds) {
        errors.push('Custom stakes require blinds configuration');
      }
      
      if (tableConfig.stakes.blinds) {
        if (!tableConfig.stakes.blinds.small || !tableConfig.stakes.blinds.big) {
          errors.push('Blinds must include both small and big blind amounts');
        }
        if (tableConfig.stakes.blinds.small >= tableConfig.stakes.blinds.big) {
          errors.push('Big blind must be greater than small blind');
        }
      }
    }
    
    // Turn timer validation
    if (tableConfig.turnTimer < 5 || tableConfig.turnTimer > 300) {
      errors.push('Turn timer must be between 5 and 300 seconds');
    }
    
    // Player capacity validation
    if (tableConfig.playerCapacity) {
      const { min, max } = tableConfig.playerCapacity;
      
      if (!min || !max) {
        errors.push('Player capacity must include both min and max values');
      }
      
      if (min < 2 || max > 90) {
        errors.push('Player capacity must be between 2 and 90');
      }
      
      if (min > max) {
        errors.push('Minimum player capacity cannot be greater than maximum');
      }
    }
    
    // Table duration validation
    if (!['TIMED', 'INFINITY'].includes(tableConfig.tableDuration)) {
      errors.push('Table duration must be either TIMED or INFINITY');
    }

    if (tableConfig.tableDuration === 'TIMED') {
      if (!tableConfig.timeLimit) {
        errors.push('Timed tables require a timeLimit in minutes');
      } else if (tableConfig.timeLimit < 1) {
        errors.push('Time limit must be at least 1 minute');
      }
    }
    
    // Buy-in settings validation
    if (tableConfig.buyInSettings) {
      const { min, max } = tableConfig.buyInSettings;
      
      if (!min || !max) {
        errors.push('Buy-in settings must include both min and max values');
      }
      
      if (min < 0 || max < 0) {
        errors.push('Buy-in amounts must be non-negative');
      }
      
      if (min > max) {
        errors.push('Minimum buy-in cannot be greater than maximum buy-in');
      }
    }
    
    // Invitation control validation
    if (tableConfig.invitationControl) {
      const validTypes = ['PASSWORD', 'INVITE'];
      if (!validTypes.includes(tableConfig.invitationControl.type)) {
        errors.push('Invitation control type must be either PASSWORD or INVITE');
      }
      
      if (tableConfig.invitationControl.type === 'PASSWORD' && !tableConfig.invitationControl.password) {
        errors.push('Password is required when invitation control type is PASSWORD');
      }
    }
    
    // Buy-in re-entry rules validation
    if (tableConfig.buyInReentryRules) {
      const validRules = ['ALLOWED_ON_REBUY_ONLY', 'ALWAYS_ALLOWED', 'NEVER_ALLOWED'];
      if (!validRules.includes(tableConfig.buyInReentryRules)) {
        errors.push('Invalid buy-in re-entry rule. Must be one of: ' + validRules.join(', '));
      }
    }
    
    return { valid: errors.length === 0, errors };
  }
  
  /**
   * Validate SNG specific configuration
   */
  static validateSNGConfig(tableConfig) {
    const errors = [];
    
    // SNG specific validations
    if (tableConfig.gameType === 'SNG') {
      // For SNG, player capacity should be reasonable for single table
      if (tableConfig.playerCapacity && tableConfig.playerCapacity.max > 10) {
        errors.push('SNG tables typically support maximum 10 players');
      }
      
      // SNG should have reasonable buy-in range
      if (tableConfig.buyInSettings) {
        const range = tableConfig.buyInSettings.max - tableConfig.buyInSettings.min;
        // if (range > tableConfig.buyInSettings.min * 5) {
        //   errors.push('Buy-in range for SNG should not be too wide');
        // }
      }
    }
    
    return { valid: errors.length === 0, errors };
  }
  
  /**
   * Validate tournament specific configuration
   */
  static validateTournamentConfig(tableConfig) {
    const errors = [];
    
    // Tournament specific validations
    if (tableConfig.gameType === 'TOURNAMENT') {
      // Tournaments can have larger player capacity
      if (tableConfig.playerCapacity && tableConfig.playerCapacity.max < 6) {
        errors.push('Tournaments should support at least 6 players');
      }
      
      // Tournament duration should be reasonable
      if (tableConfig.tableDuration === 'TIMED' && !tableConfig.estimatedHours) {
        errors.push('Timed tournaments require estimated duration');
      }
    }
    
    return { valid: errors.length === 0, errors };
  }
  
  /**
   * Complete validation for private table configuration
   */
  static validate(tableConfig) {
    // Basic validation
    const basicValidation = this.validateTableConfig(tableConfig);
    if (!basicValidation.valid) {
      return basicValidation;
    }
    
    // Game type specific validation
    let specificValidation = { valid: true, errors: [] };
    
    if (tableConfig.gameType === 'SNG') {
      specificValidation = this.validateSNGConfig(tableConfig);
    } else if (tableConfig.gameType === 'TOURNAMENT') {
      specificValidation = this.validateTournamentConfig(tableConfig);
    }
    
    const allErrors = [...basicValidation.errors, ...specificValidation.errors];
    
    return {
      valid: allErrors.length === 0,
      errors: allErrors
    };
  }
}

module.exports = PrivateTableValidator;
