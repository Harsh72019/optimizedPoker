const mongoHelper = require('../models/customdb');

class TrustedHostService {
  async getHostType(hostId) {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
    if (userResult.success && userResult.data && userResult.data.isTrustedHost) {
      return 'trusted';
    }

    const hostStats = await this.getHostStatistics(hostId);
    const trustedCriteria = await this.getTrustedHostCriteria();
    return this.evaluateTrustedStatus(hostStats, trustedCriteria) ? 'trusted' : 'regular';
  }

  async getHostStatistics(hostId) {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
    if (!userResult.success || !userResult.data) {
      throw new Error('Host not found');
    }

    const user = userResult.data;
    const financialStatsResult = await mongoHelper.aggregate(mongoHelper.COLLECTIONS.GAME_FINANCIALS, [
      { $match: { hostId, status: 'SETTLED' } },
      {
        $group: {
          _id: null,
          totalGamesHosted: { $sum: 1 },
          totalSetupFeesPaid: { $sum: '$setupFee' },
          totalPlayersServed: { $sum: '$actualParticipants' },
          avgParticipationRate: { $avg: { $divide: ['$actualParticipants', '$declaredCapacity'] } },
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

    const stats = financialStatsResult.success && financialStatsResult.data && financialStatsResult.data[0]
      ? financialStatsResult.data[0]
      : {
          totalGamesHosted: 0,
          totalSetupFeesPaid: 0,
          totalPlayersServed: 0,
          avgParticipationRate: 0,
          totalPrizePoolGenerated: 0,
          gamesInLast30Days: 0,
          successfulGames: 0
        };

    const createdAt = user.createdAt || user.created_at || new Date();
    stats.successRate = stats.totalGamesHosted > 0 ? (stats.successfulGames / stats.totalGamesHosted) * 100 : 0;
    stats.accountAgeInDays = Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
    stats.userRating = user.rating || 0;
    stats.isVerified = user.isVerified || false;

    return stats;
  }

  async getTrustedHostCriteria() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'TRUSTED_HOST_CRITERIA');
    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: 'TRUSTED_HOST_CRITERIA',
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
    });

    if (!createResult.success) {
      throw new Error(`Failed to create trusted host criteria: ${createResult.error}`);
    }

    return createResult.data.config;
  }

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

    return Object.values(checks).every(Boolean);
  }

  async promoteToTrusted(hostId, adminId, reason) {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
    if (!userResult.success || !userResult.data) {
      throw new Error('Host not found');
    }

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      hostId,
      {
        isTrustedHost: true,
        trustedHostPromotedBy: adminId,
        trustedHostPromotedAt: new Date(),
        trustedHostReason: reason
      },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(`Failed to promote trusted host: ${updateResult.error}`);
    }

    return {
      success: true,
      hostId,
      promotedBy: adminId,
      promotedAt: updateResult.data.trustedHostPromotedAt,
      reason
    };
  }

  async revokeTrustedStatus(hostId, adminId, reason) {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
    if (!userResult.success || !userResult.data) {
      throw new Error('Host not found');
    }

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      hostId,
      {
        isTrustedHost: false,
        trustedHostRevokedBy: adminId,
        trustedHostRevokedAt: new Date(),
        trustedHostRevokeReason: reason
      },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(`Failed to revoke trusted host: ${updateResult.error}`);
    }

    return {
      success: true,
      hostId,
      revokedBy: adminId,
      revokedAt: updateResult.data.trustedHostRevokedAt,
      reason
    };
  }

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
    }

    return {
      hostType: 'regular',
      maxHostUplift: 1.5,
      maxHostReward: 15,
      tier5Access: false,
      prioritySupport: false,
      customTableLimits: false
    };
  }

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

  async getAllTrustedHosts() {
    const usersResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, { isTrustedHost: true });
    const trustedHosts = [];

    if (!usersResult.success || !Array.isArray(usersResult.data)) {
      return trustedHosts;
    }

    for (const host of usersResult.data) {
      const stats = await this.getHostStatistics(host._id);
      trustedHosts.push({
        hostId: host._id,
        username: host.username,
        email: host.email,
        hostType: 'trusted',
        isManuallyPromoted: !!host.isTrustedHost,
        stats
      });
    }

    return trustedHosts;
  }

  async updateTrustedHostCriteria(newCriteria, adminId) {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'TRUSTED_HOST_CRITERIA');

    if (configResult.success && configResult.data) {
      const updateResult = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.ADMIN_CONFIG,
        configResult.data._id,
        {
          config: { ...configResult.data.config, ...newCriteria },
          lastUpdatedBy: adminId,
          version: Number(configResult.data.version || 0) + 1
        }
      );

      if (!updateResult.success) {
        throw new Error(`Failed to update trusted host criteria: ${updateResult.error}`);
      }

      return updateResult.data;
    }

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: 'TRUSTED_HOST_CRITERIA',
      config: newCriteria,
      lastUpdatedBy: adminId,
      version: 1
    });

    if (!createResult.success) {
      throw new Error(`Failed to create trusted host criteria: ${createResult.error}`);
    }

    return createResult.data;
  }

  async generateTrustedHostReport() {
    const allTrustedHosts = await this.getAllTrustedHosts();
    const criteria = await this.getTrustedHostCriteria();

    return {
      totalTrustedHosts: allTrustedHosts.length,
      manuallyPromoted: allTrustedHosts.filter((host) => host.isManuallyPromoted).length,
      autoQualified: allTrustedHosts.filter((host) => !host.isManuallyPromoted).length,
      criteria: criteria.criteria,
      privileges: criteria.privileges,
      hosts: allTrustedHosts,
      generatedAt: new Date()
    };
  }
}

module.exports = new TrustedHostService();
