const { User, GameFinancials, AdminConfig } = require('../models');

class TrustedHostService {
  
  /**
   * Determine if host is trusted based on criteria
   */
  async getHostType(hostId) {
    const hostStats = await this.getHostStatistics(hostId);
    const trustedCriteria = await this.getTrustedHostCriteria();
    
    const isTrusted = this.evaluateTrustedStatus(hostStats, trustedCriteria);
    
    return isTrusted ? 'trusted' : 'regular';
  }
  
  /**
   * Get comprehensive host statistics
   */
  async getHostStatistics(hostId) {
    const user = await User.findById(hostId);
    if (!user) {
      throw new Error('Host not found');
    }
    
    // Get financial statistics
    const financialStats = await GameFinancials.aggregate([
      { $match: { hostId: hostId, status: 'SETTLED' } },
      {
        $group: {
          _id: null,
          totalGamesHosted: { $sum: 1 },
          totalSetupFeesPaid: { $sum: '$setupFee' },
          totalPlayersServed: { $sum: '$actualParticipants' },
          avgParticipationRate: { 
            $avg: { $divide: ['$actualParticipants', '$declaredCapacity'] } 
          },
          totalPrizePoolGenerated: { $sum: '$prizePool' },
          gamesInLast30Days: {
            $sum: {
              $cond: [
                { $gte: ['$createdAt', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)] },
                1,
                0
              ]
            }
          },
          successfulGames: {
            $sum: {
              $cond: [
                { $gte: [{ $divide: ['$actualParticipants', '$declaredCapacity'] }, 0.75] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);
    
    const stats = financialStats[0] || {
      totalGamesHosted: 0,
      totalSetupFeesPaid: 0,
      totalPlayersServed: 0,
      avgParticipationRate: 0,
      totalPrizePoolGenerated: 0,
      gamesInLast30Days: 0,
      successfulGames: 0
    };
    
    // Calculate success rate
    stats.successRate = stats.totalGamesHosted > 0 
      ? (stats.successfulGames / stats.totalGamesHosted) * 100 
      : 0;
    
    // Get account age
    stats.accountAgeInDays = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    
    // Get user reputation/rating if available
    stats.userRating = user.rating || 0;
    stats.isVerified = user.isVerified || false;
    
    return stats;
  }
  
  /**
   * Get trusted host criteria configuration
   */
  async getTrustedHostCriteria() {
    let config = await AdminConfig.findOne({ configType: 'TRUSTED_HOST_CRITERIA' });
    
    if (!config) {
      config = new AdminConfig({
        configType: 'TRUSTED_HOST_CRITERIA',
        config: {
          criteria: {
            minGamesHosted: 10,
            minSuccessRate: 80, // 80% of games must meet 75%+ participation
            minAccountAgeDays: 30,
            minTotalPlayersServed: 50,
            minSetupFeesPaid: 100,
            requireVerification: true,
            minRating: 4.0,
            minGamesInLast30Days: 3
          },
          privileges: {
            maxHostUplift: 2.5, // vs 1.5 for regular
            maxHostReward: 25,  // vs 15 for regular
            tier5Access: true,  // Access to tier 5 (2% SNG rake)
            prioritySupport: true,
            customTableLimits: true
          }
        }
      });
      await config.save();
    }
    
    return config.config;
  }
  
  /**
   * Evaluate if host meets trusted criteria
   */
  evaluateTrustedStatus(hostStats, criteria) {
    const checks = {
      gamesHosted: hostStats.totalGamesHosted >= criteria.criteria.minGamesHosted,
      successRate: hostStats.successRate >= criteria.criteria.minSuccessRate,
      accountAge: hostStats.accountAgeInDays >= criteria.criteria.minAccountAgeDays,
      playersServed: hostStats.totalPlayersServed >= criteria.criteria.minTotalPlayersServed,
      setupFeesPaid: hostStats.totalSetupFeesPaid >= criteria.criteria.minSetupFeesPaid,
      isVerified: !criteria.criteria.requireVerification || hostStats.isVerified,
      rating: hostStats.userRating >= criteria.criteria.minRating,
      recentActivity: hostStats.gamesInLast30Days >= criteria.criteria.minGamesInLast30Days
    };
    
    // All criteria must be met
    const allCriteriaMet = Object.values(checks).every(check => check === true);
    
    console.log(`🔍 Trusted host evaluation for host:`, {
      hostStats: {
        gamesHosted: hostStats.totalGamesHosted,
        successRate: hostStats.successRate.toFixed(1) + '%',
        accountAge: hostStats.accountAgeInDays + ' days',
        playersServed: hostStats.totalPlayersServed,
        setupFeesPaid: hostStats.totalSetupFeesPaid,
        isVerified: hostStats.isVerified,
        rating: hostStats.userRating,
        recentGames: hostStats.gamesInLast30Days
      },
      checks,
      result: allCriteriaMet ? 'TRUSTED' : 'REGULAR'
    });
    
    return allCriteriaMet;
  }
  
  /**
   * Manually promote host to trusted status (admin only)
   */
  async promoteToTrusted(hostId, adminId, reason) {
    const user = await User.findById(hostId);
    if (!user) {
      throw new Error('Host not found');
    }
    
    // Add trusted status flag
    user.isTrustedHost = true;
    user.trustedHostPromotedBy = adminId;
    user.trustedHostPromotedAt = new Date();
    user.trustedHostReason = reason;
    await user.save();
    
    console.log(`⭐ Host ${hostId} manually promoted to trusted by admin ${adminId}: ${reason}`);
    
    return {
      success: true,
      hostId,
      promotedBy: adminId,
      promotedAt: user.trustedHostPromotedAt,
      reason
    };
  }
  
  /**
   * Revoke trusted status
   */
  async revokeTrustedStatus(hostId, adminId, reason) {
    const user = await User.findById(hostId);
    if (!user) {
      throw new Error('Host not found');
    }
    
    user.isTrustedHost = false;
    user.trustedHostRevokedBy = adminId;
    user.trustedHostRevokedAt = new Date();
    user.trustedHostRevokeReason = reason;
    await user.save();
    
    console.log(`❌ Trusted status revoked for host ${hostId} by admin ${adminId}: ${reason}`);
    
    return {
      success: true,
      hostId,
      revokedBy: adminId,
      revokedAt: user.trustedHostRevokedAt,
      reason
    };
  }
  
  /**
   * Get host privileges based on type
   */
  async getHostPrivileges(hostId) {
    const hostType = await this.getHostType(hostId);
    const criteria = await this.getTrustedHostCriteria();
    
    if (hostType === 'trusted') {
      return {
        hostType: 'trusted',
        maxHostUplift: criteria.privileges.maxHostUplift,
        maxHostReward: criteria.privileges.maxHostReward,
        tier5Access: criteria.privileges.tier5Access,
        prioritySupport: criteria.privileges.prioritySupport,
        customTableLimits: criteria.privileges.customTableLimits
      };
    } else {
      return {
        hostType: 'regular',
        maxHostUplift: 1.5,
        maxHostReward: 15,
        tier5Access: false,
        prioritySupport: false,
        customTableLimits: false
      };
    }
  }
  
  /**
   * Validate host action based on privileges
   */
  async validateHostAction(hostId, action, value) {
    const privileges = await this.getHostPrivileges(hostId);
    
    switch (action) {
      case 'HOST_UPLIFT':
        if (value > privileges.maxHostUplift) {
          throw new Error(`Host uplift ${value}% exceeds maximum allowed ${privileges.maxHostUplift}% for ${privileges.hostType} host`);
        }
        break;
        
      case 'HOST_REWARD':
        if (value > privileges.maxHostReward) {
          throw new Error(`Host reward ${value}% exceeds maximum allowed ${privileges.maxHostReward}% for ${privileges.hostType} host`);
        }
        break;
        
      case 'TIER_5_ACCESS':
        if (!privileges.tier5Access) {
          throw new Error('Tier 5 access is only available for trusted hosts');
        }
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    return { valid: true, privileges };
  }
  
  /**
   * Get all trusted hosts
   */
  async getAllTrustedHosts() {
    // Get manually promoted trusted hosts
    const manuallyTrusted = await User.find({ isTrustedHost: true });
    
    // Get automatically qualified trusted hosts
    const allHosts = await User.find({ 
      _id: { $in: await this.getActiveHostIds() }
    });
    
    const trustedHosts = [];
    
    for (const host of allHosts) {
      const hostType = await this.getHostType(host._id);
      if (hostType === 'trusted') {
        const stats = await this.getHostStatistics(host._id);
        trustedHosts.push({
          hostId: host._id,
          username: host.username,
          email: host.email,
          hostType,
          isManuallyPromoted: host.isTrustedHost || false,
          stats
        });
      }
    }
    
    return trustedHosts;
  }
  
  /**
   * Get active host IDs (hosts who have created games)
   */
  async getActiveHostIds() {
    const hostIds = await GameFinancials.distinct('hostId');
    return hostIds;
  }
  
  /**
   * Update trusted host criteria (admin only)
   */
  async updateTrustedHostCriteria(newCriteria, adminId) {
    let config = await AdminConfig.findOne({ configType: 'TRUSTED_HOST_CRITERIA' });
    
    if (!config) {
      config = new AdminConfig({ configType: 'TRUSTED_HOST_CRITERIA', config: {} });
    }
    
    config.config = { ...config.config, ...newCriteria };
    config.lastUpdatedBy = adminId;
    config.version += 1;
    
    await config.save();
    
    console.log(`⚙️ Trusted host criteria updated by admin ${adminId}`);
    
    return config;
  }
  
  /**
   * Generate trusted host report
   */
  async generateTrustedHostReport() {
    const allTrustedHosts = await this.getAllTrustedHosts();
    const criteria = await this.getTrustedHostCriteria();
    
    const report = {
      totalTrustedHosts: allTrustedHosts.length,
      manuallyPromoted: allTrustedHosts.filter(h => h.isManuallyPromoted).length,
      autoQualified: allTrustedHosts.filter(h => !h.isManuallyPromoted).length,
      criteria: criteria.criteria,
      privileges: criteria.privileges,
      hosts: allTrustedHosts,
      generatedAt: new Date()
    };
    
    return report;
  }
}

module.exports = new TrustedHostService();