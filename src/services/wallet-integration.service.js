const mongoHelper = require('../models/customdb');

class WalletIntegrationService {
  
  /**
   * Charge setup fee from host wallet
   */
  async chargeSetupFee(hostId, amount, gameId) {
    try {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
      
      if (!userResult.success || !userResult.data) {
        throw new Error('Host not found');
      }
      
      const user = userResult.data;
      
      // Check sufficient balance
      if ((user.balance || 0) < amount) {
        throw new Error(`Insufficient balance. Required: ${amount}, Available: ${user.balance || 0}`);
      }
      
      // Deduct setup fee
      const newBalance = (user.balance || 0) - amount;
      
      const updateResult = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.USERS,
        hostId,
        { balance: newBalance }
      );
      
      if (!updateResult.success) {
        throw new Error(`Failed to update user balance: ${updateResult.error}`);
      }
      
      // Log transaction
      await this.logTransaction({
        userId: hostId,
        type: 'SETUP_FEE_CHARGE',
        amount: -amount,
        gameId,
        description: `Setup fee for game ${gameId}`,
        balanceAfter: newBalance
      });
      
      console.log(`💰 Setup fee charged: ${amount} from host ${hostId}`);
      
      return {
        success: true,
        chargedAmount: amount,
        newBalance: newBalance,
        transactionId: `setup_${gameId}_${Date.now()}`
      };
      
    } catch (error) {
      console.error(`❌ Setup fee charge failed:`, error);
      throw error;
    }
  }
  
  /**
   * Pay host reward
   */
  async payHostReward(hostId, amount, gameId) {
    try {
      const user = await User.findById(hostId);
      if (!user) {
        throw new Error('Host not found');
      }
      
      // Add host reward to balance
      user.balance += amount;
      await user.save();
      
      // Log transaction
      await this.logTransaction({
        userId: hostId,
        type: 'HOST_REWARD',
        amount: amount,
        gameId,
        description: `Host reward for game ${gameId}`,
        balanceAfter: user.balance
      });
      
      console.log(`💰 Host reward paid: ${amount} to host ${hostId}`);
      
      return {
        success: true,
        paidAmount: amount,
        newBalance: user.balance,
        transactionId: `host_reward_${gameId}_${Date.now()}`
      };
      
    } catch (error) {
      console.error(`❌ Host reward payment failed:`, error);
      throw error;
    }
  }
  
  /**
   * Pay affiliate commission
   */
  async payAffiliateCommission(affiliateId, amount, gameId, referredUserId) {
    try {
      const affiliate = await User.findById(affiliateId);
      if (!affiliate) {
        throw new Error('Affiliate not found');
      }
      
      // Add commission to balance
      affiliate.balance += amount;
      await affiliate.save();
      
      // Log transaction
      await this.logTransaction({
        userId: affiliateId,
        type: 'AFFILIATE_COMMISSION',
        amount: amount,
        gameId,
        description: `Affiliate commission for game ${gameId} (referred user: ${referredUserId})`,
        balanceAfter: affiliate.balance,
        metadata: { referredUserId }
      });
      
      console.log(`💰 Affiliate commission paid: ${amount} to affiliate ${affiliateId}`);
      
      return {
        success: true,
        paidAmount: amount,
        newBalance: affiliate.balance,
        transactionId: `affiliate_${gameId}_${Date.now()}`
      };
      
    } catch (error) {
      console.error(`❌ Affiliate commission payment failed:`, error);
      throw error;
    }
  }
  
  /**
   * Distribute prize pool to winners
   */
  async distributePrizePool(winners, gameId) {
    const results = [];
    
    for (const winner of winners) {
      try {
        const { userId, amount, position } = winner;
        
        const user = await User.findById(userId);
        if (!user) {
          console.error(`❌ Winner not found: ${userId}`);
          continue;
        }
        
        // Add prize to balance
        user.balance += amount;
        await user.save();
        
        // Log transaction
        await this.logTransaction({
          userId,
          type: 'PRIZE_PAYOUT',
          amount: amount,
          gameId,
          description: `Prize payout for position ${position} in game ${gameId}`,
          balanceAfter: user.balance,
          metadata: { position }
        });
        
        results.push({
          userId,
          position,
          amount,
          success: true,
          newBalance: user.balance,
          transactionId: `prize_${gameId}_${userId}_${Date.now()}`
        });
        
        console.log(`🏆 Prize paid: ${amount} to winner ${userId} (position ${position})`);
        
      } catch (error) {
        console.error(`❌ Prize payout failed for ${winner.userId}:`, error);
        results.push({
          userId: winner.userId,
          position: winner.position,
          amount: winner.amount,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Refund buy-ins when tournament is cancelled
   */
  async refundBuyIns(playerIds, buyInAmount, gameId) {
    const results = [];
    
    for (const playerId of playerIds) {
      try {
        const user = await User.findById(playerId);
        if (!user) {
          console.error(`❌ Player not found for refund: ${playerId}`);
          continue;
        }
        
        // Add refund to balance
        user.balance += buyInAmount;
        await user.save();
        
        // Log transaction
        await this.logTransaction({
          userId: playerId,
          type: 'BUY_IN_REFUND',
          amount: buyInAmount,
          gameId,
          description: `Buy-in refund for cancelled game ${gameId}`,
          balanceAfter: user.balance
        });
        
        results.push({
          userId: playerId,
          refundAmount: buyInAmount,
          success: true,
          newBalance: user.balance,
          transactionId: `refund_${gameId}_${playerId}_${Date.now()}`
        });
        
        console.log(`💰 Buy-in refunded: ${buyInAmount} to player ${playerId}`);
        
      } catch (error) {
        console.error(`❌ Refund failed for ${playerId}:`, error);
        results.push({
          userId: playerId,
          refundAmount: buyInAmount,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Charge buy-in from player
   */
  async chargeBuyIn(playerId, amount, gameId) {
    try {
      const user = await User.findById(playerId);
      if (!user) {
        throw new Error('Player not found');
      }
      
      // Check sufficient balance
      if (user.balance < amount) {
        throw new Error(`Insufficient balance. Required: ${amount}, Available: ${user.balance}`);
      }
      
      // Deduct buy-in
      user.balance -= amount;
      await user.save();
      
      // Log transaction
      await this.logTransaction({
        userId: playerId,
        type: 'BUY_IN_CHARGE',
        amount: -amount,
        gameId,
        description: `Buy-in for game ${gameId}`,
        balanceAfter: user.balance
      });
      
      console.log(`💰 Buy-in charged: ${amount} from player ${playerId}`);
      
      return {
        success: true,
        chargedAmount: amount,
        newBalance: user.balance,
        transactionId: `buyin_${gameId}_${playerId}_${Date.now()}`
      };
      
    } catch (error) {
      console.error(`❌ Buy-in charge failed:`, error);
      throw error;
    }
  }
  
  /**
   * Get user balance
   */
  async getUserBalance(userId) {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    
    return {
      userId,
      balance: user.balance,
      lastUpdated: user.updatedAt
    };
  }
  
  /**
   * Add funds to user balance (for testing/admin)
   */
  async addFunds(userId, amount, description = 'Admin credit') {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      user.balance += amount;
      await user.save();
      
      await this.logTransaction({
        userId,
        type: 'ADMIN_CREDIT',
        amount: amount,
        description,
        balanceAfter: user.balance
      });
      
      return {
        success: true,
        addedAmount: amount,
        newBalance: user.balance
      };
      
    } catch (error) {
      console.error(`❌ Add funds failed:`, error);
      throw error;
    }
  }
  
  /**
   * Log financial transaction
   */
  async logTransaction(transactionData) {
    const {
      userId,
      type,
      amount,
      gameId,
      description,
      balanceAfter,
      metadata = {}
    } = transactionData;
    
    const transactionLogData = {
      userId,
      type,
      amount,
      gameId,
      description,
      balanceAfter,
      transactionId: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      metadata,
      status: 'COMPLETED'
    };
    
    const logResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, transactionLogData);
    
    if (logResult.success) {
      console.log(`📝 Transaction logged: ${type} - ${amount} for user ${userId}`);
      return logResult.data;
    } else {
      console.error(`❌ Failed to log transaction: ${logResult.error}`);
      return null;
    }
  }
  
  /**
   * Validate sufficient balance for multiple operations
   */
  async validateSufficientBalance(userId, requiredAmount) {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    
    return {
      sufficient: user.balance >= requiredAmount,
      currentBalance: user.balance,
      requiredAmount,
      shortfall: Math.max(0, requiredAmount - user.balance)
    };
  }
  
  /**
   * Batch process multiple wallet operations
   */
  async batchProcessTransactions(transactions) {
    const results = [];
    
    for (const transaction of transactions) {
      try {
        let result;
        
        switch (transaction.type) {
          case 'CHARGE_SETUP_FEE':
            result = await this.chargeSetupFee(transaction.userId, transaction.amount, transaction.gameId);
            break;
          case 'PAY_HOST_REWARD':
            result = await this.payHostReward(transaction.userId, transaction.amount, transaction.gameId);
            break;
          case 'PAY_AFFILIATE':
            result = await this.payAffiliateCommission(transaction.userId, transaction.amount, transaction.gameId, transaction.referredUserId);
            break;
          case 'CHARGE_BUY_IN':
            result = await this.chargeBuyIn(transaction.userId, transaction.amount, transaction.gameId);
            break;
          default:
            throw new Error(`Unknown transaction type: ${transaction.type}`);
        }
        
        results.push({ ...transaction, result, success: true });
        
      } catch (error) {
        results.push({ ...transaction, error: error.message, success: false });
      }
    }
    
    return results;
  }
}

module.exports = new WalletIntegrationService();